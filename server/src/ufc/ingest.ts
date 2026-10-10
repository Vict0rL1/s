// Ingesta de la UFC en sombra: los CSV que publica Greco1899/scrape_ufc_stats en GitHub (rascados de
// ufcstats.com y actualizados cada semana). Cuatro ficheros: eventos (con la fecha), resultados de
// las peleas, luchadores y sus medidas. Todo en una transacción: o entra el archivo entero o nada.
//
// Lo que NO se inventa:
//   · una pelea cuyo evento no tiene fecha en el fichero de eventos se descarta (y se cuenta);
//   · un nombre que comparten varios luchadores deja la pelea sin atribuir (`ambigua`), porque las
//     peleas solo traen nombres y no hay forma de saber cuál de los dos era;
//   · una medida que no consta («--») queda NULL.

import { parse } from 'csv-parse/sync';
import { getDb } from '../db.ts';

export const REPO_UFC = 'https://raw.githubusercontent.com/Greco1899/scrape_ufc_stats/main';
export const FICHEROS_UFC = ['ufc_event_details.csv', 'ufc_fight_results.csv', 'ufc_fighter_details.csv', 'ufc_fighter_tott.csv'] as const;

type Fila = Record<string, string>;
const leer = (texto: string): Fila[] => parse(texto, { columns: true, skip_empty_lines: true, relax_column_count: true, trim: true }) as Fila[];

/** El id de ufcstats al final de una URL (`…/fight-details/3f804eec9183e597` → `3f804eec9183e597`). */
export const idDeUrl = (url: string | undefined): string | null => {
  const m = /\/([0-9a-f]{8,})\/?$/i.exec(url ?? '');
  return m ? m[1].toLowerCase() : null;
};
const nombreLimpio = (s: string) => s.replace(/\s+/g, ' ').trim();

const MESES: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
/** «October 03, 2026» o «Jul 13, 1978» → 2026-10-03. NULL si no se entiende. */
export function fechaUfc(s: string | undefined): string | null {
  const m = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4})$/.exec((s ?? '').trim());
  if (!m || !MESES[m[1].toLowerCase()]) return null;
  return `${m[3]}-${MESES[m[1].toLowerCase()]}-${m[2].padStart(2, '0')}`;
}
/** «5' 11"» → 180,3 cm; «72"» → 182,9 cm; «--» → NULL. */
export function cm(s: string | undefined): number | null {
  const t = (s ?? '').trim();
  const pies = /^(\d+)' ?(\d+)"?$/.exec(t);
  if (pies) return Math.round((Number(pies[1]) * 12 + Number(pies[2])) * 2.54 * 10) / 10;
  const pulgadas = /^(\d+(?:\.\d+)?)"$/.exec(t);
  if (pulgadas) return Math.round(Number(pulgadas[1]) * 2.54 * 10) / 10;
  return null;
}

export interface Archivo {
  eventos: { id: string; nombre: string; fecha: string; lugar: string | null }[];
  luchadores: { id: string; nombre: string; apodo: string | null; altura_cm: number | null; alcance_cm: number | null; guardia: string | null; nacimiento: string | null; ambiguo: boolean }[];
  peleas: {
    id: string;
    evento_id: string;
    fecha: string;
    /** Posición en la cartelera tal como la lista la fuente: 0 es la estelar, que se pelea la última. */
    orden: number;
    luchador_a: string | null;
    luchador_b: string | null;
    nombre_a: string;
    nombre_b: string;
    resultado: 'A' | 'B' | 'EMPATE' | 'NC';
    categoria: string | null;
    metodo: string | null;
    asalto: number | null;
    tiempo: string | null;
    ambigua: boolean;
  }[];
  descartadas: { sinFecha: number; ilegibles: number };
}

/** Los cuatro CSV, ya leídos, a filas para las tablas. Puro: no toca la base. */
export function leerArchivo(textos: Record<(typeof FICHEROS_UFC)[number], string>): Archivo {
  const eventos: Archivo['eventos'] = [];
  const fechaDeEvento = new Map<string, { id: string; fecha: string }>();
  for (const r of leer(textos['ufc_event_details.csv'])) {
    const id = idDeUrl(r.URL);
    const fecha = fechaUfc(r.DATE);
    if (!id || !fecha || !r.EVENT) continue;
    eventos.push({ id, nombre: nombreLimpio(r.EVENT), fecha, lugar: r.LOCATION || null });
    fechaDeEvento.set(nombreLimpio(r.EVENT), { id, fecha });
  }

  const medidas = new Map(leer(textos['ufc_fighter_tott.csv']).map((r) => [idDeUrl(r.URL), r]));
  const luchadores: Archivo['luchadores'] = [];
  const porNombre = new Map<string, string[]>();
  for (const r of leer(textos['ufc_fighter_details.csv'])) {
    const id = idDeUrl(r.URL);
    const nombre = nombreLimpio(`${r.FIRST ?? ''} ${r.LAST ?? ''}`);
    if (!id || !nombre) continue;
    const m = medidas.get(id);
    luchadores.push({ id, nombre, apodo: r.NICKNAME || null, altura_cm: cm(m?.HEIGHT), alcance_cm: cm(m?.REACH), guardia: m?.STANCE || null, nacimiento: fechaUfc(m?.DOB), ambiguo: false });
    porNombre.set(nombre, [...(porNombre.get(nombre) ?? []), id]);
  }
  for (const l of luchadores) l.ambiguo = (porNombre.get(l.nombre)?.length ?? 0) > 1;
  const idUnico = (nombre: string): { id: string | null; ambiguo: boolean } => {
    const ids = porNombre.get(nombre);
    if (!ids) return { id: null, ambiguo: false };
    return ids.length === 1 ? { id: ids[0], ambiguo: false } : { id: null, ambiguo: true };
  };

  const peleas: Archivo['peleas'] = [];
  let sinFecha = 0;
  let ilegibles = 0;
  const enEvento = new Map<string, number>();
  for (const r of leer(textos['ufc_fight_results.csv'])) {
    const id = idDeUrl(r.URL);
    const ev = fechaDeEvento.get(nombreLimpio(r.EVENT ?? ''));
    const partes = (r.BOUT ?? '').split(/\s+vs\.\s+/);
    const resultado = { 'W/L': 'A', 'L/W': 'B', 'D/D': 'EMPATE', 'NC/NC': 'NC' }[(r.OUTCOME ?? '').trim()] as Archivo['peleas'][number]['resultado'] | undefined;
    if (!id || partes.length !== 2 || !resultado) {
      ilegibles++;
      continue;
    }
    if (!ev) {
      sinFecha++;
      continue;
    }
    const orden = enEvento.get(ev.id) ?? 0;
    enEvento.set(ev.id, orden + 1);
    const [na, nb] = partes.map(nombreLimpio);
    const a = idUnico(na);
    const b = idUnico(nb);
    peleas.push({
      id,
      evento_id: ev.id,
      fecha: ev.fecha,
      orden,
      luchador_a: a.id,
      luchador_b: b.id,
      nombre_a: na,
      nombre_b: nb,
      resultado,
      categoria: r.WEIGHTCLASS || null,
      metodo: r.METHOD || null,
      asalto: Number.isInteger(Number(r.ROUND)) && r.ROUND !== '' ? Number(r.ROUND) : null,
      tiempo: r.TIME || null,
      ambigua: a.ambiguo || b.ambiguo,
    });
  }
  return { eventos, luchadores, peleas, descartadas: { sinFecha, ilegibles } };
}

/** Sustituye el archivo entero en una transacción (es historia: la fuente es la que manda). */
export function guardarArchivo(x: Archivo, ahora = new Date()): void {
  const d = getDb();
  d.exec('BEGIN');
  try {
    d.exec('DELETE FROM ufc_fights; DELETE FROM ufc_fighters; DELETE FROM ufc_events;');
    const e = d.prepare('INSERT INTO ufc_events (id, nombre, fecha, lugar) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING');
    for (const v of x.eventos) e.run(v.id, v.nombre, v.fecha, v.lugar);
    const l = d.prepare('INSERT INTO ufc_fighters (id, nombre, apodo, altura_cm, alcance_cm, guardia, nacimiento, ambiguo) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING');
    for (const v of x.luchadores) l.run(v.id, v.nombre, v.apodo, v.altura_cm, v.alcance_cm, v.guardia, v.nacimiento, v.ambiguo ? 1 : 0);
    const p = d.prepare(
      `INSERT INTO ufc_fights (id, evento_id, fecha, orden, luchador_a, luchador_b, nombre_a, nombre_b, resultado, categoria, metodo, asalto, tiempo, ambigua, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
    );
    for (const v of x.peleas) p.run(v.id, v.evento_id, v.fecha, v.orden, v.luchador_a, v.luchador_b, v.nombre_a, v.nombre_b, v.resultado, v.categoria, v.metodo, v.asalto, v.tiempo, v.ambigua ? 1 : 0, ahora.toISOString());
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

/** Baja los cuatro ficheros; si falta uno no se escribe nada. */
export async function ingestarUfc(f: typeof fetch = fetch): Promise<Archivo> {
  const textos = {} as Record<(typeof FICHEROS_UFC)[number], string>;
  for (const fichero of FICHEROS_UFC) {
    let res: Response;
    try {
      res = await f(`${REPO_UFC}/${fichero}`);
    } catch (e) {
      throw new Error(`no se pudo contactar con GitHub para ${fichero} (${(e as Error).message}); no se ha escrito nada`);
    }
    if (!res.ok) throw new Error(`GitHub contestó ${res.status} para ${fichero}; no se ha escrito nada`);
    textos[fichero] = await res.text();
  }
  const x = leerArchivo(textos);
  if (x.peleas.length === 0) throw new Error('los ficheros no traen ninguna pelea legible; no se ha escrito nada');
  guardarArchivo(x);
  return x;
}
