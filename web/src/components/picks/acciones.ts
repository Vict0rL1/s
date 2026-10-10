// Lo que se puede hacer con «Mi selección» (Fase 5.15): enviarla a Apuestas como borrador,
// copiarla como texto, descargarla en JSON o .ics, y guardarla como imagen. Todo en el
// navegador salvo la imagen, que el servidor dibuja en SVG con los colores de datos.

import type { Combinada, Pick } from './tipos';
import { localeDe, tr, type Idioma } from '../../i18n';
import { num as numF, pct as pctF } from '../../lib/formato';

export const CLAVE_BORRADOR = 'predictor.borradorApuesta';

export interface Pata {
  sport: string;
  matchKey: string;
  liga: string | null;
  cuando: string;
  seleccion: string;
  indice: number;
  resultados: number;
  p: number;
  cuota: number | null;
}

export const patasDe = (xs: Pick[]): Pata[] =>
  xs.map((p) => ({ sport: p.sport, matchKey: p.matchKey, liga: p.liga, cuando: p.cuando, seleccion: p.favorito, indice: p.opciones.findIndex((o) => o.nombre === p.favorito), resultados: p.opciones.length, p: p.probabilidad, cuota: p.cuota }));

// El texto que sale de la app (portapapeles, calendario, notas) va en el idioma de la pantalla;
// en español con la coma decimal, como estaba.
const pctTxt = (x: number, idioma: Idioma = 'es') => pctF(x, 1, idioma);

/** El borrador de apuesta personal: una pata, su mercado; varias, una combinada. */
export function borradorDe(xs: Pick[], c: Combinada | null, idioma: Idioma = 'es'): Record<string, unknown> {
  const hoy = new Date().toISOString().slice(0, 10);
  if (xs.length === 1) {
    const p = xs[0];
    return { sport: p.sport, league: p.liga, event: p.partido, market: 'moneyline', selection: p.favorito, odds: p.cuota ?? '', placed_on: hoy, model_prob: p.probabilidad, match_key: p.matchKey, notes: tr(idioma, 'exp.desdeDestacados') };
  }
  return {
    sport: new Set(xs.map((p) => p.sport)).size === 1 ? xs[0].sport : 'other',
    event: xs.map((p) => p.partido).join(' + ').slice(0, 200),
    market: 'other',
    selection: xs.map((p) => p.favorito).join(' + ').slice(0, 200),
    odds: c?.cuotaCombinada != null ? Number(c.cuotaCombinada.toFixed(2)) : '',
    placed_on: hoy,
    model_prob: c ? c.conjunta : null,
    notes: `${tr(idioma, 'exp.combinada', { n: xs.length })}${c ? tr(idioma, 'exp.conjunta', { p: pctTxt(c.conjunta, idioma) }) : ''}`,
  };
}

export function comoTexto(xs: Pick[], c: Combinada | null, idioma: Idioma = 'es'): string {
  const lineas = xs.map((p) => `• ${p.partido} — ${p.favorito} ${pctTxt(p.probabilidad, idioma)}${p.cuota ? ` @ ${numF(p.cuota, 2, idioma)}` : ''} (${new Date(p.cuando).toLocaleString(localeDe(idioma), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })})`);
  const pie = c
    ? `${tr(idioma, 'exp.acertarTodos', { p: pctTxt(c.conjunta, idioma) })}${
        c.cuotaCombinada != null
          ? `${tr(idioma, 'exp.cuotaCombinada', { c: numF(c.cuotaCombinada, 2, idioma) })}${c.ventaja != null ? tr(idioma, 'exp.ventaja', { v: `${c.ventaja >= 0 ? '+' : '−'}${pctTxt(Math.abs(c.ventaja), idioma)}` }) : ''}`
          : ''
      }`
    : '';
  return [tr(idioma, 'exp.titulo'), ...lineas, pie, tr(idioma, 'exp.estimacion')].filter(Boolean).join('\n');
}

const fechaIcs = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const escIcs = (s: string) => s.replace(/[\\;,]/g, (m) => `\\${m}`).replace(/\n/g, '\\n');

/** Pliega una línea a 75 octetos (RFC 5545 §3.1): CRLF + espacio, sin partir un carácter. */
export function plegar(linea: string): string {
  const enc = new TextEncoder();
  const trozos: string[] = [];
  let actual = '';
  for (const ch of linea) {
    if (enc.encode(actual + ch).length > (trozos.length ? 74 : 75)) {
      trozos.push(actual);
      actual = '';
    }
    actual += ch;
  }
  trozos.push(actual);
  return trozos.join('\r\n ');
}

/** Un VEVENT por partido, con la probabilidad en la descripción (RFC 5545). */
export function comoIcs(xs: Pick[], ahora = new Date(), idioma: Idioma = 'es'): string {
  const eventos = xs.map((p) => {
    const ini = fechaIcs(p.cuando);
    const fin = fechaIcs(new Date(Date.parse(p.cuando) + 2 * 3_600_000).toISOString());
    return [
      'BEGIN:VEVENT',
      `UID:${escIcs(`${p.sport}-${p.matchKey}`)}@sports-predictor`,
      `DTSTAMP:${fechaIcs(ahora.toISOString())}`,
      `DTSTART:${ini}`,
      `DTEND:${fin}`,
      `SUMMARY:${escIcs(p.partido)}`,
      `DESCRIPTION:${escIcs(tr(idioma, 'exp.ics', { fav: p.favorito, p: pctTxt(p.probabilidad, idioma), cuota: p.cuota ? tr(idioma, 'exp.icsCuota', { c: numF(p.cuota, 2, idioma) }) : '' }))}`,
      'END:VEVENT',
    ].map(plegar).join('\r\n');
  });
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Sports Predictor//Mi seleccion//ES', 'CALSCALE:GREGORIAN', ...eventos, 'END:VCALENDAR', ''].join('\r\n');
}

export function descargar(nombre: string, contenido: Blob | string, tipo = 'text/plain;charset=utf-8'): void {
  const blob = typeof contenido === 'string' ? new Blob([contenido], { type: tipo }) : contenido;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Pide el SVG al servidor y lo pasa a PNG en un canvas del navegador. */
export async function imagenPng(xs: Pick[], idioma: Idioma = 'es'): Promise<Blob> {
  const r = await fetch('/api/picks/tarjeta.svg', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ patas: patasDe(xs) }) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const svg = await r.text();
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    await new Promise<void>((ok, mal) => {
      img.onload = () => ok();
      img.onerror = () => mal(new Error(tr(idioma, 'exp.noDibujar')));
      img.src = url;
    });
    const escala = 2;
    const canvas = document.createElement('canvas');
    canvas.width = img.width * escala;
    canvas.height = img.height * escala;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error(tr(idioma, 'exp.sinCanvas'));
    ctx.scale(escala, escala);
    ctx.drawImage(img, 0, 0);
    return await new Promise<Blob>((ok, mal) => canvas.toBlob((b) => (b ? ok(b) : mal(new Error(tr(idioma, 'exp.sinPng')))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}
