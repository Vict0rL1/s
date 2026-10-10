// ¿Podemos confiar en el modelo? La página de transparencia, en datos.
//
// Las cifras salen de los mismos módulos que el resto de la app (evaluación en vivo,
// banco de papel, validación, walk-forward), y las dos listas —lo que sabemos y lo que
// todavía no— se generan con REGLAS a partir de las muestras y los veredictos, no a mano:
// si mañana hay 300 apuestas, el aviso de «solo 84 apuestas» desaparece solo.

import { getDb } from '../db.ts';
import { env } from '../config.ts';
import { evaluacionEnVivo } from './live.ts';
import { validacionEnVivo } from './validation.ts';
import { rendimientoEnVivo } from './betting.ts';
import { leerWalkForward } from './walkforward.ts';
import { UMBRALES_MUESTRA } from './sample.ts';
import { SPORT_IDS } from '../sports.ts';

const NOMBRE: Record<string, string> = { tennis: 'tenis', football: 'fútbol', basketball: 'NBA', baseball: 'MLB', nfl: 'NFL', nhl: 'NHL', ufc: 'UFC' };
const LOGS = ['prediction_log', 'fb_prediction_log', 'bb_prediction_log', 'bsb_prediction_log', 'naf_prediction_log'];

export interface ConfianzaSistema {
  prediccionesEnVivo: number;
  resueltas: number;
  apuestasEnVivo: number;
  liquidadas: number;
  diasRegistrados: number | null;
  clvMedio: number | null;
  roi: number | null;
  brier: { deporte: string; n: number; brier: number | null; ece: number | null }[];
  maxDrawdownPct: number | null;
  benchmark: { deporte: string; partidos: number; modelo: number | null; mejorBaseline: { nombre: string; logLoss: number } | null; mercado: number | null }[];
  sabemos: string[];
  noSabemos: string[];
  cuotasReales: boolean;
}

export function confianzaDelSistema(): ConfianzaSistema {
  const db = getDb();
  let total = 0;
  let resueltas = 0;
  let primera: string | null = null;
  for (const t of LOGS) {
    try {
      const r = db.prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN resolved_at IS NOT NULL THEN 1 ELSE 0 END) AS r, MIN(predicted_at) AS p FROM ${t}`).get() as { n: number; r: number | null; p: string | null };
      total += r.n;
      resueltas += r.r ?? 0;
      if (r.p && (!primera || r.p < primera)) primera = r.p;
    } catch {
      // tabla aún sin crear
    }
  }
  const b = db.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN status IN ('won','lost') THEN 1 ELSE 0 END) AS l FROM paper_bets").get() as { n: number; l: number | null };
  const rend = rendimientoEnVivo();
  const vivo = evaluacionEnVivo();
  const val = validacionEnVivo();
  const benchmark = SPORT_IDS.map((d) => {
    const w = leerWalkForward(d);
    const bs = w ? Object.entries(w.global.baselines).filter(([, i]) => i.logLoss != null).sort((x, y) => (x[1].logLoss as number) - (y[1].logLoss as number)) : [];
    return {
      deporte: d,
      partidos: w?.global.modelo.n ?? 0,
      modelo: w?.global.modelo.logLoss ?? null,
      mejorBaseline: bs[0] ? { nombre: bs[0][0], logLoss: bs[0][1].logLoss as number } : null,
      mercado: w?.global.modelo.mercado?.logLoss ?? null,
    };
  });

  const sabemos: string[] = [];
  const noSabemos: string[] = [];
  const A = UMBRALES_MUESTRA.apuestas;
  const P = UMBRALES_MUESTRA.predicciones;
  if (total) sabemos.push(`${total} predicciones en vivo registradas antes de cada partido, inmutables (${resueltas} ya con resultado).`);
  for (const x of benchmark) {
    const w = leerWalkForward(x.deporte as (typeof SPORT_IDS)[number]);
    if (!w) continue;
    const r = w.resumen['Elo básico'];
    if (r) sabemos.push(`${NOMBRE[x.deporte]}: en el histórico, el modelo le gana al Elo básico en ${r.ganaModelo} de ${r.periodos} periodos del walk-forward.`);
    const m = w.resumen['Mercado (cierre)'];
    if (m && m.ganaRival > m.ganaModelo) sabemos.push(`${NOMBRE[x.deporte]}: el mercado de cierre es MEJOR que el modelo (gana ${m.ganaRival} de ${m.periodos} temporadas).`);
  }
  if (val.clvSenales.veredicto === 'a favor') sabemos.push(`El edge detectado le gana al cierre: ${val.clvSenales.lectura}`);
  if (val.clvSenales.veredicto === 'en contra') sabemos.push(`El edge detectado PIERDE contra el cierre: ${val.clvSenales.lectura}`);
  for (const [d, p] of Object.entries(val.modeloVsMercado)) {
    if (p.veredicto === 'a favor' || p.veredicto === 'en contra') sabemos.push(`${NOMBRE[d]} en vivo: ${p.veredicto === 'a favor' ? 'el modelo le gana al mercado' : 'el mercado le gana al modelo'} (${p.lectura})`);
  }

  if (!env.oddsApiKey) noSabemos.push('Sin clave de The Odds API en este servidor: no hay cuotas reales, ni apuestas, ni CLV en vivo.');
  if (b.l == null || b.l < A.orientativa) noSabemos.push(`Solo ${b.l ?? 0} apuestas de papel liquidadas: el ROI ${(b.l ?? 0) < A.insuficiente ? 'no permite concluir nada' : 'es orientativo'}.`);
  for (const x of vivo) {
    if (x.n < P.insuficiente) noSabemos.push(`${NOMBRE[x.deporte]}: ${x.n} predicciones en vivo con resultado (muestra pequeña; aviso por debajo de ${P.insuficiente}).`);
  }
  noSabemos.push('CLV histórico: el archivo solo tiene la cuota de cierre, así que no se puede medir en el pasado; solo en vivo.');
  noSabemos.push('Tenis, NBA y MLB no tienen cuotas históricas: en el backtest no hay comparación con el mercado, solo con baselines.');
  noSabemos.push('Lesiones de NBA y NFL, clima, bullpen y alineaciones de NBA/MLB: la app no tiene esas fuentes (aparecen como DESCONOCIDO).');

  return {
    prediccionesEnVivo: total,
    resueltas,
    apuestasEnVivo: b.n,
    liquidadas: b.l ?? 0,
    diasRegistrados: primera ? Math.max(0, Math.round((Date.now() - Date.parse(primera)) / 86_400_000)) : null,
    clvMedio: rend.total.clvMedio,
    roi: rend.total.roi,
    brier: vivo.map((x) => ({ deporte: x.deporte, n: x.n, brier: x.brier, ece: x.ece })),
    maxDrawdownPct: rend.drawdown?.pct ?? null,
    benchmark,
    sabemos,
    noSabemos,
    cuotasReales: !!env.oddsApiKey,
  };
}
