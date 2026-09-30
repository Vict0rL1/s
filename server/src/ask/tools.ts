// Las capacidades del asistente: consultas REALES, de solo lectura, sobre la base.
//
// ===========================================================================
// EL ASISTENTE NO DICE NI UN DATO
// ===========================================================================
// Un modelo de lenguaje que contesta «Alcaraz tiene 2180 de Elo» es un generador de
// frases plausibles, y un número plausible es exactamente lo que NO sirve para
// comprobar nada: suena igual esté bien o mal, y no hay forma de distinguirlo sin ir a
// mirarlo a mano — que es justo el trabajo que se quería ahorrar.
//
// Así que el reparto aquí es estricto:
//
//   · quien interpreta la pregunta SOLO elige QUÉ consulta correr y con qué
//     argumentos. No redacta ningún número.
//   · la consulta la ejecuta SQLite contra la base, y el número que sale es el mismo
//     que enseña la pestaña.
//   · la respuesta lleva SIEMPRE de dónde viene, para poder repetirla a mano y no
//     tener que fiarse.
//
// Consecuencia práctica: este asistente dice «no sé» a menudo. Uno que nunca lo dice
// está inventando.
//
// ===========================================================================
// SOLO LECTURA, Y NO POR CONFIANZA
// ===========================================================================
// Ninguna herramienta acepta SQL de fuera. Son funciones con argumentos tipados y sus
// consultas escritas aquí; lo de fuera son valores, y van parametrizados. A un
// asistente al que se le puede dictar SQL se le puede dictar DROP TABLE.

import { getDb, getMeta } from '../db.ts';
import {
  searchPlayers, getRating, getEloRank, getH2HMeetings,
  getOfficialRanking, getSurfaceRecord, getEloRanking, countRows,
} from '../repo.ts';
import { buildPrediction } from '../model/predict.ts';
import { readOddsReason, REASON_TEXT, type SportPrefix } from '../oddsReason.ts';
import type { TourId } from '../types.ts';

export interface Respuesta {
  /** Lo que se contesta. Lo compone ESTE fichero, no un modelo. */
  texto: string;
  /** Filas de apoyo, para enseñarlas en tabla. */
  filas?: { etiqueta: string; valor: string }[];
  /** Con qué se ha obtenido, para poder repetirlo a mano. */
  fuente: string;
}

const TOURS: TourId[] = ['atp', 'wta'];

function buscarJugador(nombre: string): { tour: TourId; id: number; name: string } | null {
  for (const tour of TOURS) {
    const r = searchPlayers(tour, nombre, 1);
    if (r.length > 0) return { tour, id: r[0].id, name: r[0].name };
  }
  return null;
}

const noEncuentro = (n: string): Respuesta => ({
  texto: `No encuentro a ningún jugador que se llame «${n}» en la base. Prueba con el apellido.`,
  fuente: 'búsqueda por nombre en la tabla de jugadores',
});

// ---------------------------------------------------------------------------
export function jugador(nombre: string): Respuesta {
  const j = buscarJugador(nombre);
  if (!j) return noEncuentro(nombre);
  const r = getRating(j.tour, j.id);
  const puesto = getEloRank(j.tour, j.id);
  const oficial = getOfficialRanking(j.tour, j.id);
  const sup = (s: string) => {
    const x = getSurfaceRecord(j.tour, j.id, s);
    return `${x.wins}-${x.losses}`;
  };
  const filas = [
    { etiqueta: 'Elo general', valor: `${Math.round(r.overall)}  ·  puesto ${puesto} por Elo` },
    { etiqueta: 'Pista dura', valor: `${Math.round(r.hard)} Elo  ·  ${sup('Hard')}` },
    { etiqueta: 'Tierra', valor: `${Math.round(r.clay)} Elo  ·  ${sup('Clay')}` },
    { etiqueta: 'Hierba', valor: `${Math.round(r.grass)} Elo  ·  ${sup('Grass')}` },
    { etiqueta: 'Partidos en la base', valor: String(r.matches_played) },
  ];
  if (oficial) {
    filas.push({ etiqueta: 'Ranking oficial', valor: `${oficial.rank}º con ${oficial.points} puntos` });
  }
  return {
    texto: `${j.name} — ${j.tour.toUpperCase()}`,
    filas,
    fuente: `player_ratings y player_rankings, jugador ${j.id}`,
  };
}

// ---------------------------------------------------------------------------
export function caraACara(a: string, b: string): Respuesta {
  const ja = buscarJugador(a);
  if (!ja) return noEncuentro(a);
  const jb = buscarJugador(b);
  if (!jb) return noEncuentro(b);
  if (ja.tour !== jb.tour) {
    return {
      texto: `${ja.name} es de ${ja.tour.toUpperCase()} y ${jb.name} de ${jb.tour.toUpperCase()}: no hay cara a cara entre circuitos.`,
      fuente: 'el circuito de cada jugador',
    };
  }
  const ms = getH2HMeetings(ja.tour, ja.id, jb.id);
  if (ms.length === 0) {
    return {
      texto: `${ja.name} y ${jb.name} no se han enfrentado nunca en lo que tiene la app (desde 2015).`,
      fuente: `partidos con ${ja.id} y ${jb.id}`,
    };
  }
  const gana = ms.filter((m) => m.winnerId === ja.id).length;
  return {
    texto: `${ja.name} ${gana}–${ms.length - gana} ${jb.name}, en ${ms.length} enfrentamiento${ms.length > 1 ? 's' : ''}.`,
    filas: ms.slice(0, 10).map((m) => ({
      etiqueta: `${m.date.slice(0, 4)}-${m.date.slice(4, 6)}  ${m.tourney_name ?? ''} ${m.surface ?? ''}`.trim(),
      valor: `ganó ${m.winnerId === ja.id ? ja.name : jb.name}${m.score ? `  ${m.score}` : ''}`,
    })),
    fuente: `partidos con ${ja.id} y ${jb.id}, de la tabla de histórico`,
  };
}

// ---------------------------------------------------------------------------
export function prediccion(a: string, b: string, superficie?: string): Respuesta {
  const ja = buscarJugador(a);
  if (!ja) return noEncuentro(a);
  const jb = buscarJugador(b);
  if (!jb) return noEncuentro(b);
  if (ja.tour !== jb.tour) {
    return { texto: `${ja.name} y ${jb.name} no son del mismo circuito.`, fuente: 'el circuito de cada jugador' };
  }
  const sup = /tierra|arcilla|clay/i.test(superficie ?? '')
    ? 'Clay'
    : /hierba|grass|c[ée]sped/i.test(superficie ?? '')
      ? 'Grass'
      : 'Hard';
  const nombreSup = sup === 'Clay' ? 'tierra' : sup === 'Grass' ? 'hierba' : 'pista dura';
  let p;
  try {
    p = buildPrediction(ja.tour, ja.id, jb.id, sup, null);
  } catch {
    return {
      texto: `No puedo predecir ${ja.name} vs ${jb.name}: falta algún dato de los dos.`,
      fuente: 'el mismo modelo que la pestaña',
    };
  }
  return {
    // Se dice la superficie SIEMPRE, aunque no la hayan pedido. La probabilidad cambia
    // mucho con ella, y una respuesta sin decir sobre qué se ha calculado invita a
    // leerla como si valiera para cualquier partido.
    texto: `En ${nombreSup}: ${(p.model.prob1 * 100).toFixed(1)} % ${ja.name} · ${(p.model.prob2 * 100).toFixed(1)} % ${jb.name}.`,
    filas: [
      { etiqueta: 'Fiabilidad', valor: `${p.reliability.level} · banda ±${p.reliability.marginPp.toFixed(1)} pp` },
      { etiqueta: `Elo efectivo de ${ja.name}`, valor: String(Math.round(p.ratings.p1.effective)) },
      { etiqueta: `Elo efectivo de ${jb.name}`, valor: String(Math.round(p.ratings.p2.effective)) },
    ],
    fuente: `el mismo buildPrediction que usa la pestaña, en ${nombreSup}`,
  };
}

// ---------------------------------------------------------------------------
export function clasificacion(n = 10, tour: TourId = 'atp'): Respuesta {
  const filas = getEloRanking(tour, { limit: Math.min(Math.max(n, 1), 30) });
  if (filas.length === 0) {
    return { texto: `No hay ratings de ${tour.toUpperCase()} en la base.`, fuente: 'player_ratings' };
  }
  return {
    texto: `Los ${filas.length} primeros de ${tour.toUpperCase()} por Elo:`,
    filas: filas.map((r, i) => ({ etiqueta: `${i + 1}.  ${r.name}`, valor: `${Math.round(r.elo)} Elo` })),
    fuente: `player_ratings de ${tour}, ordenado por Elo`,
  };
}

// ---------------------------------------------------------------------------
export function estadoDatos(): Respuesta {
  const deportes: { nombre: string; tabla: string; prefijo: SportPrefix }[] = [
    { nombre: 'Fútbol', tabla: 'fb_upcoming', prefijo: 'fb_' },
    { nombre: 'Baloncesto', tabla: 'bb_upcoming', prefijo: 'bb_' },
    { nombre: 'Béisbol', tabla: 'bsb_upcoming', prefijo: 'bsb_' },
    { nombre: 'NFL', tabla: 'naf_upcoming', prefijo: 'naf_' },
    { nombre: 'Tenis', tabla: 'upcoming_matches', prefijo: '' },
  ];
  const db = getDb();
  const filas = deportes.map((d) => {
    let total = 0;
    let reales = 0;
    try {
      const r = db
        .prepare(`SELECT COUNT(*) c, SUM(CASE WHEN source <> 'fixture' THEN 1 ELSE 0 END) v FROM ${d.tabla}`)
        .get() as { c: number; v: number | null };
      total = r.c;
      reales = r.v ?? 0;
    } catch {
      // Una tabla que aún no existe se informa como cero en vez de tumbar la respuesta.
    }
    const { reason } = readOddsReason(d.prefijo);
    return {
      etiqueta: d.nombre,
      valor:
        total === 0
          ? `sin partidos${reason ? ` — ${REASON_TEXT[reason]}` : ''}`
          : `${total} partidos · ${reales} con cuotas reales${reason ? ` — ${REASON_TEXT[reason]}` : ''}`,
    };
  });
  return {
    texto: 'Lo que hay guardado ahora mismo:',
    filas: [
      ...filas,
      {
        etiqueta: 'Histórico de tenis',
        valor: `${countRows('matches')} partidos, hasta ${getMeta('history_through') ?? 'fecha sin registrar'}`,
      },
    ],
    fuente: 'las tablas de próximos partidos y la causa que dejó escrita la última ingesta',
  };
}

// ---------------------------------------------------------------------------
export function precision(): Respuesta {
  // Los números del backtest NO se recalculan aquí: recorrer 22.000 partidos dentro de
  // una petición web tardaría demasiado. Se CITAN los publicados, diciendo que lo son y
  // con qué comando se reproducen — que es la diferencia entre citar y afirmar.
  return {
    texto:
      'Medido con `npm run backtest` sobre 22.062 partidos ATP fuera de muestra (2015–2026), ' +
      'walk-forward: cada partido se predice solo con lo anterior a él.',
    filas: [
      { etiqueta: 'Acierta al favorito', valor: '65,3 %' },
      { etiqueta: 'Baseline «gana el mejor rankeado»', valor: '63,6 %' },
      { etiqueta: 'Brier', valor: '0,2132   (0,25 = decir siempre 50/50)' },
      { etiqueta: 'Log loss', valor: '0,6133   (0,693 = decir siempre 50/50)' },
      { etiqueta: 'Cuando NO coincide con el ranking', valor: 'el modelo acierta 54,2 % y el ranking 45,8 %' },
    ],
    fuente: 'cifras publicadas por `npm run backtest` — reprodúcelas, no me creas',
  };
}
