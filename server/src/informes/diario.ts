// El resumen diario (Fase 6.7): lo que hay hoy, cómo salió ayer, cómo va el dinero de papel y qué
// avisó la app. Cada cifra sale de algo guardado; si no hay, el informe lo dice en vez de rellenar.

import { mejoresPartidos } from '../picks/top.ts';
import { predicciones } from '../evaluation/live.ts';
import { resumen } from '../paper/bankroll.ts';
import { compararEstrategias } from '../estrategias/index.ts';
import { alertas } from '../alerts/engine.ts';
import { avisoMuestra } from '../evaluation/sample.ts';
import { featureEncendida } from '../features.ts';
import { SPORT_IDS, type SportId } from '../sports.ts';
import { fechaLarga, horaCorta, local, sumarDias, zonaApp } from './tiempo.ts';
import { conSigno, dinero, pct, tabla } from './formato.ts';

export const NOMBRE_DEPORTE: Record<SportId, string> = { football: 'Fútbol', basketball: 'Baloncesto', baseball: 'Béisbol', nfl: 'NFL', nhl: 'NHL', ufc: 'UFC', tennis: 'Tenis' };
/** Cuántos partidos de hoy caben en la tabla; el resto se cuenta. */
const MAX_PARTIDOS = 15;

export interface DatosDiario {
  fecha: string;
  zona: string;
  generado: string;
  hoy: {
    partidos: { sport: string; partido: string; cuando: string; favorito: string; probabilidad: number; confianza: string | null; decision: string | null; ventaja: number | null; url: string }[];
    total: number;
    sinPrediccion: number;
    demo: number;
  };
  ayer: { fecha: string; porDeporte: { sport: string; n: number; aciertos: number }[] };
  banco: { banco: number; beneficio: number; liquidadas: number; pendientes: number; roi: number | null; aviso: string | null; motivo: string | null };
  estrategias: { nombre: string; banco: number; apuestas: number; pendientes: number }[];
  alertas: { total: number; porTipo: { tipo: string; n: number }[]; destacadas: { titulo: string; cuerpo: string; severidad: string; cuando: string }[] };
}

const argmax = (p: number[]) => p.reduce((m, v, i) => (v > p[m] ? i : m), 0);

export function datosDiario(ahora = new Date(), zona = zonaApp()): DatosDiario {
  const { fecha } = local(ahora, zona);
  const ayer = sumarDias(fecha, -1);

  const m = mejoresPartidos(ahora, 24);
  const hoy = {
    partidos: m.partidos.slice(0, MAX_PARTIDOS).map((p) => ({
      sport: p.sport,
      partido: p.partido,
      cuando: p.cuando,
      favorito: p.favorito,
      probabilidad: p.probabilidad,
      confianza: p.confianza?.nivel ?? null,
      decision: p.confianza?.decision ?? null,
      ventaja: p.ventaja,
      url: `/partido/${p.sport}/${encodeURIComponent(p.eventoId)}`,
    })),
    total: m.partidos.length,
    sinPrediccion: m.sinPrediccion,
    demo: m.demo,
  };

  // Ayer: las predicciones en vivo cuyo partido empezó ayer (hora local) y ya tienen resultado.
  const porDeporte = SPORT_IDS.map((sport) => {
    let xs: ReturnType<typeof predicciones> = [];
    try {
      xs = predicciones(sport).filter((x) => x.cuando && local(new Date(x.cuando), zona).fecha === ayer);
    } catch {
      xs = [];
    }
    return { sport, n: xs.length, aciertos: xs.filter((x) => argmax(x.p) === x.y).length };
  }).filter((d) => d.n > 0);

  const r = resumen();
  const aviso = avisoMuestra(r.liquidadas, 'apuestas');
  // Un banco quieto tiene que poder explicarse (paper/bankroll.ts): la última pasada lo dice.
  const u = r.ultima;
  const motivo = !u
    ? 'el banco de papel todavía no ha hecho ninguna pasada'
    : u.colocadas > 0
      ? null
      : u.candidatas === 0
        ? 'en la última pasada no había ningún partido con cuotas reales por delante'
        : `la última pasada evaluó ${u.candidatas} partido(s) con cuotas reales y ninguno pasó la política`;
  const banco = { banco: r.banco, beneficio: r.beneficio, liquidadas: r.liquidadas, pendientes: r.pendientes, roi: r.roi, aviso: aviso.texto, motivo };

  const estrategias = featureEncendida('estrategias.laboratorio')
    ? compararEstrategias().filas.filter((f) => f.id != null && !f.archivada).map((f) => ({ nombre: f.nombre, banco: f.banco, apuestas: f.apuestas, pendientes: f.pendientes }))
    : [];

  const desde = new Date(ahora.getTime() - 24 * 3_600_000).toISOString();
  const recientes = alertas({ limit: 500 }).filter((a) => a.created_at >= desde);
  const porTipo = new Map<string, number>();
  for (const a of recientes) porTipo.set(a.type, (porTipo.get(a.type) ?? 0) + 1);
  const peso: Record<string, number> = { importante: 0, aviso: 1, info: 2 };
  const destacadas = [...recientes]
    .sort((a, b) => peso[a.severity] - peso[b.severity] || b.created_at.localeCompare(a.created_at))
    .filter((a) => a.severity !== 'info')
    .slice(0, 8)
    .map((a) => ({ titulo: a.title, cuerpo: a.body, severidad: a.severity, cuando: a.created_at }));

  return {
    fecha,
    zona,
    generado: ahora.toISOString(),
    hoy,
    ayer: { fecha: ayer, porDeporte },
    banco,
    estrategias,
    alertas: { total: recientes.length, porTipo: [...porTipo].map(([tipo, n]) => ({ tipo, n })).sort((a, b) => b.n - a.n), destacadas },
  };
}

export function markdownDiario(d: DatosDiario): { titulo: string; resumen: string; markdown: string } {
  const titulo = `Resumen del día · ${fechaLarga(d.fecha)}`;
  const l: string[] = [`# ${titulo}`, '', `_Generado el ${horaCorta(d.generado, d.zona)} (${d.zona}). Estimaciones estadísticas medidas contra resultados reales; no es una recomendación para apostar._`, ''];

  l.push('## Hoy: partidos por confianza (próximas 24 h)', '');
  if (d.hoy.total === 0) {
    l.push(d.hoy.demo > 0 ? `Ningún partido con predicción y precio real en las próximas 24 h (${d.hoy.demo} de demostración no cuentan).` : 'Ningún partido con predicción en las próximas 24 h.');
  } else {
    l.push(
      tabla(
        ['Partido', 'Deporte', 'Hora', 'Favorito', 'Prob.', 'Confianza'],
        d.hoy.partidos.map((p) => [`[${p.partido}](${p.url})`, NOMBRE_DEPORTE[p.sport as SportId] ?? p.sport, horaCorta(p.cuando, d.zona), p.favorito, pct(p.probabilidad, 0), p.confianza ? `${p.confianza}${p.decision === 'BET' ? ' · con valor' : ''}` : 'sin evaluar']),
      ),
    );
    if (d.hoy.total > d.hoy.partidos.length) l.push('', `Y ${d.hoy.total - d.hoy.partidos.length} más en Destacados.`);
  }
  if (d.hoy.sinPrediccion > 0) l.push('', `${d.hoy.sinPrediccion} partido(s) reales de la ventana todavía sin predicción registrada.`);

  l.push('', `## Ayer (${fechaLarga(d.ayer.fecha)})`, '');
  if (d.ayer.porDeporte.length === 0) l.push('Ninguna predicción en vivo de ayer con resultado todavía.');
  else {
    for (const x of d.ayer.porDeporte) l.push(`- ${NOMBRE_DEPORTE[x.sport as SportId] ?? x.sport}: el favorito del modelo ganó ${x.aciertos} de ${x.n}.`);
    l.push('', '_Un día es una muestra minúscula: esto cuenta lo que pasó, no mide al modelo (para eso, Confianza)._');
  }

  l.push('', '## Banco de papel', '');
  l.push(`- Banco ${dinero(d.banco.banco)} (${conSigno(d.banco.beneficio)}) · ${d.banco.liquidadas} liquidadas · ${d.banco.pendientes} pendientes · ROI ${pct(d.banco.roi)}`);
  if (d.banco.aviso) l.push(`- ${d.banco.aviso}`);
  if (d.banco.motivo) l.push(`- Sin apuestas nuevas: ${d.banco.motivo}.`);
  if (d.estrategias.length) {
    l.push('', '### Estrategias del laboratorio', '');
    for (const e of d.estrategias) l.push(`- ${e.nombre}: banco ${dinero(e.banco)} · ${e.apuestas} apuestas · ${e.pendientes} pendientes`);
  }

  l.push('', '## Alertas de las últimas 24 h', '');
  if (d.alertas.total === 0) l.push('Ninguna.');
  else {
    l.push(d.alertas.porTipo.map((x) => `${x.tipo} ×${x.n}`).join(' · '));
    if (d.alertas.destacadas.length) {
      l.push('');
      for (const a of d.alertas.destacadas) l.push(`- **${a.titulo}** (${a.severidad}, ${horaCorta(a.cuando, d.zona)}): ${a.cuerpo}`);
    }
  }

  const resumenTxt =
    `${d.hoy.total} partido(s) hoy` +
    (d.ayer.porDeporte.length ? ` · ayer el favorito ganó ${d.ayer.porDeporte.reduce((a, x) => a + x.aciertos, 0)} de ${d.ayer.porDeporte.reduce((a, x) => a + x.n, 0)}` : '') +
    ` · banco ${dinero(d.banco.banco)} · ${d.alertas.total} alerta(s)`;
  return { titulo, resumen: resumenTxt, markdown: l.join('\n') + '\n' };
}
