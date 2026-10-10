// Los partidos que vienen, de los cinco deportes juntos, ordenados por cuánto se puede
// fiar uno de la predicción y por la probabilidad del favorito.
//
// ===========================================================================
// DE DÓNDE SALE CADA NÚMERO (nada se recalcula aquí)
// ===========================================================================
//   · probabilidad: la del registro de predicciones, tal como se enseñó en la pestaña
//     del deporte (la misma regla que «Hoy»: si no, dos pantallas dirían dos cifras).
//   · confianza: la última evaluación de la capa de confianza (trust/): nivel ALTA /
//     MEDIA / BAJA, calidad de datos, estabilidad, desacuerdo y su decisión BET/NO BET.
//   · acierto histórico: la franja de calibración del backtest del deporte
//     (experiments/calibration.json): «cuando dijo 70–80 %, acertó el 78 % de 2.402».
//   · cuota y ventaja: la cuota real del favorito, si la hay; ventaja = p × cuota − 1.
//
// ===========================================================================
// EL ORDEN, Y LO QUE NO DICE
// ===========================================================================
// Primero el nivel de confianza y, dentro de cada nivel, la probabilidad. Así un 82 %
// con datos pobres no se cuela por delante de un 74 % sólido. Pero «más probable» no es
// «mejor apuesta»: un 85 % pagado a 1,10 pierde dinero si la probabilidad real no llega
// al 91 %. Por eso cada fila lleva su cuota justa (1/p) y la ventaja contra la cuota
// ofrecida, y la pantalla lo dice.
//
// Solo partidos reales: los de demostración no tienen predicción registrada y su
// «probabilidad» sería del modelo contra un rival que no existe.

import { getDb } from '../db.ts';
import { CON_ARROBA, FUENTES, probSql, empateSql, type Fuente, type PartidoDeHoy } from '../today.ts';
import { readCalibration } from '../staking/calibration.ts';
import type { SportId } from '../sports.ts';

export interface OpcionPick {
  nombre: string;
  p: number;
  cuota: number | null;
}

export interface Pick {
  deporte: PartidoDeHoy['deporte'];
  sport: SportId;
  matchKey: string;
  /** Id del partido en la tabla de próximos: el de la página /partido/:sport/:id. */
  eventoId: string;
  liga: string | null;
  cuando: string;
  partido: string;
  casa: string;
  fuera: string;
  casaId: string | null;
  fueraId: string | null;
  opciones: OpcionPick[];
  favorito: string;
  probabilidad: number;
  /** La cuota real del favorito, o null si el partido no tiene precio. */
  cuota: number | null;
  /** 1/p: la cuota a partir de la cual el favorito tiene valor según el modelo. */
  cuotaJusta: number;
  /** p × cuota − 1, o null sin cuota. */
  ventaja: number | null;
  casas: number | null;
  /** La fiabilidad que el modelo da a su propio número (high/medium/low). */
  fiabilidad: string | null;
  confianza: {
    nivel: 'ALTA' | 'MEDIA' | 'BAJA';
    calidadDatos: number;
    estabilidad: string;
    desacuerdo: string;
    incertidumbrePp: number;
    decision: 'BET' | 'NO BET' | 'SIN MERCADO';
    motivo: string | null;
    evaluadaEn: string;
  } | null;
  /** Lo que acertó el modelo en el backtest cuando dio una probabilidad de esta franja. */
  historico: { franja: string; acierto: number; n: number } | null;
}

export interface MejoresPartidos {
  horas: number;
  generado: string;
  partidos: Pick[];
  /** Partidos reales de la ventana que todavía no tienen predicción registrada. */
  sinPrediccion: number;
  /** Partidos de demostración que no entran. */
  demo: number;
}

export const HORIZONTES = [24, 48, 168] as const;

const SPORT: Record<PartidoDeHoy['deporte'], SportId> = { 'Fútbol': 'football', 'Baloncesto': 'basketball', 'Béisbol': 'baseball', NFL: 'nfl', NHL: 'nhl', UFC: 'ufc', 'Tenis': 'tennis' };

/** Las columnas de cuota de cada tabla de próximos: [local, (empate,) visitante]. */
const CUOTAS: Record<PartidoDeHoy['deporte'], string[]> = {
  'Fútbol': ['odds_home', 'odds_draw', 'odds_away'],
  'Baloncesto': ['home_odds', 'away_odds'],
  'Béisbol': ['odds_home', 'odds_away'],
  NFL: ['odds_home', 'odds_away'],
  NHL: ['odds_home', 'odds_away'],
  UFC: ['odds_home', 'odds_away'],
  'Tenis': ['p1_odds', 'p2_odds'],
};
const LIGA: Record<PartidoDeHoy['deporte'], string> = { 'Fútbol': 'league', 'Baloncesto': 'league', 'Béisbol': 'league', NFL: 'league', NHL: 'league', UFC: 'league', 'Tenis': 'tour' };
const CASA_ID: Record<PartidoDeHoy['deporte'], [string, string]> = {
  'Fútbol': ['home_id', 'away_id'], 'Baloncesto': ['home_id', 'away_id'], 'Béisbol': ['home_id', 'away_id'], NFL: ['home_id', 'away_id'], NHL: ['home_id', 'away_id'], UFC: ['home_id', 'away_id'], 'Tenis': ['p1_id', 'p2_id'],
};

const RANGO_CONFIANZA: Record<string, number> = { ALTA: 0, MEDIA: 1, BAJA: 2 };

/** ALTA antes que MEDIA antes que BAJA antes que «sin evaluar»; dentro, más probable antes. */
export function ordenar(a: Pick, b: Pick): number {
  const ra = a.confianza ? RANGO_CONFIANZA[a.confianza.nivel] : 3;
  const rb = b.confianza ? RANGO_CONFIANZA[b.confianza.nivel] : 3;
  return ra - rb || b.probabilidad - a.probabilidad || a.cuando.localeCompare(b.cuando);
}

/** La franja de calibración que contiene p (la de «desde» más alto ≤ p). */
export function franjaDe(
  bandas: { desde: number; n: number; acierto: number }[] | null | undefined,
  p: number,
): Pick['historico'] {
  if (!bandas?.length) return null;
  const ordenadas = [...bandas].sort((x, y) => x.desde - y.desde);
  let b: (typeof ordenadas)[number] | null = null;
  for (const x of ordenadas) if (x.desde <= p) b = x;
  if (!b) return null;
  const i = ordenadas.indexOf(b);
  const hasta = ordenadas[i + 1]?.desde ?? 1;
  return { franja: `${Math.round(b.desde * 100)}–${Math.round(hasta * 100)} %`, acierto: b.acierto, n: b.n };
}

export function mejoresPartidos(now = new Date(), horas: number = HORIZONTES[1]): MejoresPartidos {
  const db = getDb();
  const desde = now.toISOString();
  const hasta = new Date(now.getTime() + horas * 3_600_000).toISOString();
  const calibracion = readCalibration();
  const out: Pick[] = [];
  let sinPrediccion = 0;
  let demo = 0;

  const ultimaEvaluacion = db.prepare(
    `SELECT confidence, data_quality, stability, disagreement, uncertainty_pp, decision, reasons, assessed_at
       FROM prediction_assessments WHERE sport = ? AND match_key = ? ORDER BY id DESC LIMIT 1`,
  );

  for (const f of FUENTES as Fuente[]) {
    const cuotas = CUOTAS[f.deporte];
    const [cId, fId] = CASA_ID[f.deporte];
    try {
      const filas = db
        .prepare(
          `SELECT u.id AS uid, u.commence_time AS cuando, u.source AS fuente, u.${LIGA[f.deporte]} AS liga, u.books AS casas,
                  u.${cId} AS casaId, u.${fId} AS fueraId, ${cuotas.map((c, i) => `u.${c} AS c${i}`).join(', ')},
                  l.${f.clave} AS clave, l.${f.casa} AS casa, l.${f.fuera} AS fuera, l.reliability AS fiabilidad,
                  ${probSql(f, 'l.')} AS p ${f.empate ? `, ${empateSql(f, 'l.')} AS pEmpate` : ''}
             FROM ${f.up} u
             LEFT JOIN ${f.log} l ON l.upcoming_id = u.id
            WHERE u.commence_time > ? AND u.commence_time <= ?`,
        )
        .all(desde, hasta) as Record<string, unknown>[];

      for (const r of filas) {
        if (r.fuente === 'fixture') {
          demo++;
          continue;
        }
        if (typeof r.p !== 'number' || !r.casa || !r.fuera || !r.clave) {
          sinPrediccion++;
          continue;
        }
        const casa = String(r.casa);
        const fuera = String(r.fuera);
        const pE = typeof r.pEmpate === 'number' ? r.pEmpate : 0;
        const ps = f.empate ? [r.p, pE, 1 - r.p - pE] : [r.p, 1 - r.p];
        const nombres = f.empate ? [casa, 'Empate', fuera] : [casa, fuera];
        const opciones: OpcionPick[] = ps.map((p, i) => {
          const c = r[`c${i}`];
          return { nombre: nombres[i], p, cuota: typeof c === 'number' && c > 1 ? c : null };
        });
        const fav = opciones.reduce((a, b) => (b.p > a.p ? b : a));
        const sport = SPORT[f.deporte];
        const ev = ultimaEvaluacion.get(sport, String(r.clave)) as
          | { confidence: 'ALTA' | 'MEDIA' | 'BAJA'; data_quality: number; stability: string; disagreement: string; uncertainty_pp: number; decision: 'BET' | 'NO BET' | 'SIN MERCADO'; reasons: string; assessed_at: string }
          | undefined;
        const motivos = ev ? (JSON.parse(ev.reasons) as string[]) : [];
        out.push({
          deporte: f.deporte,
          sport,
          matchKey: String(r.clave),
          eventoId: String(r.uid),
          liga: (r.liga as string | null) ?? null,
          cuando: String(r.cuando),
          partido: CON_ARROBA.has(f.deporte) ? `${fuera} @ ${casa}` : `${casa} vs ${fuera}`,
          casa,
          fuera,
          casaId: r.casaId == null ? null : String(r.casaId),
          fueraId: r.fueraId == null ? null : String(r.fueraId),
          opciones,
          favorito: fav.nombre,
          probabilidad: fav.p,
          // Una cuota de demostración nunca llega aquí (las filas `fixture` se saltan).
          cuota: fav.cuota,
          cuotaJusta: 1 / fav.p,
          ventaja: fav.cuota ? fav.p * fav.cuota - 1 : null,
          casas: typeof r.casas === 'number' ? r.casas : null,
          fiabilidad: (r.fiabilidad as string | null) ?? null,
          confianza: ev
            ? {
                nivel: ev.confidence,
                calidadDatos: ev.data_quality,
                estabilidad: ev.stability,
                desacuerdo: ev.disagreement,
                incertidumbrePp: ev.uncertainty_pp,
                decision: ev.decision,
                motivo: motivos[0] ?? null,
                evaluadaEn: ev.assessed_at,
              }
            : null,
          historico: franjaDe(calibracion[sport]?.bands, fav.p),
        });
      }
    } catch {
      // Un deporte sin tablas todavía no deja sin lista a los otros cuatro.
    }
  }

  out.sort(ordenar);
  return { horas, generado: now.toISOString(), partidos: out, sinPrediccion, demo };
}
