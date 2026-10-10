// Búsqueda global (Fase 5.17): equipos, jugadores, partidos próximos y ligas, por prefijo o
// subcadena, sin acentos ni mayúsculas. Las páginas fijas las añade la pantalla.

import { getDb } from '../db.ts';
import { footballConfig, basketballConfig, baseballConfig, nflConfig } from '../config.ts';
import type { SportId } from '../sports.ts';

export type TipoResultado = 'equipo' | 'jugador' | 'partido' | 'liga';

export interface Resultado {
  tipo: TipoResultado;
  sport: SportId;
  league: string | null;
  id: string;
  etiqueta: string;
  detalle: string | null;
  /** Para abrir: /equipo/…, /jugador/…, /partido/…, /liga/… */
  ruta: string;
}

export const normalizar = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

const EQUIPOS: { sport: Exclude<SportId, 'tennis'>; tabla: string }[] = [
  { sport: 'football', tabla: 'fb_teams' },
  { sport: 'basketball', tabla: 'bb_teams' },
  { sport: 'baseball', tabla: 'bsb_teams' },
  { sport: 'nfl', tabla: 'naf_teams' },
  { sport: 'nhl', tabla: 'nhl_teams' },
];
const PROXIMOS: { sport: SportId; tabla: string; id: string; casa: string; fuera: string; liga: string }[] = [
  { sport: 'football', tabla: 'fb_upcoming', id: 'id', casa: 'home_name', fuera: 'away_name', liga: 'league' },
  { sport: 'basketball', tabla: 'bb_upcoming', id: 'id', casa: 'home_name', fuera: 'away_name', liga: 'league' },
  { sport: 'baseball', tabla: 'bsb_upcoming', id: 'id', casa: 'home_name', fuera: 'away_name', liga: 'league' },
  { sport: 'nfl', tabla: 'naf_upcoming', id: 'id', casa: 'home_name', fuera: 'away_name', liga: 'league' },
  { sport: 'nhl', tabla: 'nhl_upcoming', id: 'id', casa: 'home_name', fuera: 'away_name', liga: 'league' },
  { sport: 'ufc', tabla: 'ufc_upcoming', id: 'id', casa: 'home_name', fuera: 'away_name', liga: 'league' },
  { sport: 'tennis', tabla: 'upcoming_matches', id: 'id', casa: 'p1_name', fuera: 'p2_name', liga: 'tour' },
];

export function buscar(q: string, limite = 30, ahora = new Date()): Resultado[] {
  const n = normalizar(q);
  if (n.length < 2) return [];
  const db = getDb();
  const out: Resultado[] = [];
  const coincide = (texto: string) => normalizar(texto).includes(n);
  const like = `%${n}%`;
  // Ligas (configuración), primero: son pocas y una búsqueda «laliga» quiere la liga.
  const ligas: { sport: SportId; id: string; name: string }[] = [
    ...footballConfig.leagues.map((l) => ({ sport: 'football' as const, id: l.id, name: l.name })),
    ...basketballConfig.leagues.map((l) => ({ sport: 'basketball' as const, id: l.id, name: l.name })),
    ...baseballConfig.leagues.map((l) => ({ sport: 'baseball' as const, id: l.id, name: l.name })),
    ...nflConfig.leagues.map((l) => ({ sport: 'nfl' as const, id: l.id, name: l.name })),
    { sport: 'nhl' as const, id: 'nhl', name: 'NHL' },
    { sport: 'ufc' as const, id: 'ufc', name: 'UFC' },
  ];
  for (const l of ligas) if (coincide(l.name) || coincide(l.id)) out.push({ tipo: 'liga', sport: l.sport, league: l.id, id: l.id, etiqueta: l.name, detalle: null, ruta: `/liga/${l.sport}/${encodeURIComponent(l.id)}` });
  for (const e of EQUIPOS) {
    try {
      const filas = db.prepare(`SELECT id, league, name FROM ${e.tabla} ORDER BY name`).all() as { id: string; league: string; name: string }[];
      for (const f of filas) if (coincide(f.name) || normalizar(f.id) === n) out.push({ tipo: 'equipo', sport: e.sport, league: f.league, id: f.id, etiqueta: f.name, detalle: f.league, ruta: `/equipo/${e.sport}/${encodeURIComponent(f.league)}/${encodeURIComponent(f.id)}` });
    } catch {
      // Deporte sin tabla todavía.
    }
  }
  try {
    const filas = db.prepare('SELECT id, tour, name, country FROM players WHERE lower(name) LIKE ? ORDER BY name LIMIT 50').all(like) as { id: number; tour: string; name: string; country: string | null }[];
    for (const f of filas) if (coincide(f.name)) out.push({ tipo: 'jugador', sport: 'tennis', league: f.tour, id: String(f.id), etiqueta: f.name, detalle: [f.tour.toUpperCase(), f.country].filter(Boolean).join(' · '), ruta: `/jugador/${encodeURIComponent(f.tour)}/${f.id}` });
  } catch {
    // Sin jugadores.
  }
  // Luchadores de la UFC: los que han peleado (la ficha de los que no, no dice nada).
  try {
    const filas = db
      .prepare(
        `SELECT f.id, f.nombre, f.apodo FROM ufc_fighters f
          WHERE lower(f.nombre) LIKE ? AND EXISTS (SELECT 1 FROM ufc_fights p WHERE p.luchador_a = f.id OR p.luchador_b = f.id)
          ORDER BY f.nombre LIMIT 50`,
      )
      .all(like) as { id: string; nombre: string; apodo: string | null }[];
    for (const f of filas) if (coincide(f.nombre)) out.push({ tipo: 'jugador', sport: 'ufc', league: 'ufc', id: f.id, etiqueta: f.nombre, detalle: f.apodo ? `UFC · «${f.apodo}»` : 'UFC', ruta: `/luchador/${encodeURIComponent(f.id)}` });
  } catch {
    // Sin archivo de la UFC.
  }
  for (const p of PROXIMOS) {
    try {
      const filas = db
        .prepare(`SELECT ${p.id} AS id, ${p.casa} AS casa, ${p.fuera} AS fuera, ${p.liga} AS liga, commence_time AS cuando FROM ${p.tabla} WHERE commence_time > ? AND source <> 'fixture' ORDER BY commence_time LIMIT 400`)
        .all(ahora.toISOString()) as { id: string; casa: string; fuera: string; liga: string | null; cuando: string }[];
      for (const f of filas) {
        if (coincide(f.casa) || coincide(f.fuera)) out.push({ tipo: 'partido', sport: p.sport, league: f.liga, id: String(f.id), etiqueta: p.sport === 'nfl' || p.sport === 'nhl' ? `${f.fuera} @ ${f.casa}` : `${f.casa} vs ${f.fuera}`, detalle: f.cuando, ruta: `/partido/${p.sport}/${encodeURIComponent(String(f.id))}` });
      }
    } catch {
      // Deporte sin tabla todavía.
    }
  }
  // Primero lo que EMPIEZA por lo buscado, luego el resto; sin repetir.
  const vistos = new Set<string>();
  return out
    .filter((r) => {
      const k = `${r.tipo}|${r.sport}|${r.id}`;
      if (vistos.has(k)) return false;
      vistos.add(k);
      return true;
    })
    .sort((a, b) => Number(!normalizar(a.etiqueta).startsWith(n)) - Number(!normalizar(b.etiqueta).startsWith(n)) || a.etiqueta.localeCompare(b.etiqueta))
    .slice(0, limite);
}
