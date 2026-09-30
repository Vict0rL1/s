// `npm run doctor` — diagnóstico de punta a punta de las cuotas reales.
//
//   npm run doctor              gratis: no gasta ni un crédito
//   npm run doctor -- --probar  gasta UN crédito por deporte en juego para ver eventos,
//                               mercados y casas reales de verdad
//   npm run doctor -- --sin-red no habla con The Odds API
//
// Recorre el flujo entero, en el orden en que viaja una cuota:
//
//   .env → The Odds API → competiciones → base de datos → frescura → backend → pantalla
//
// y termina con un RESULTADO y una lista numerada de qué hacer. Las comprobaciones viven
// en doctor/checks.ts (y tienen tests); aquí solo se reúnen los datos y se imprimen.
//
// Código de salida: 0 si no hay errores (puede haber advertencias), 1 si los hay. Así se
// puede encadenar: `npm run doctor && npm run dev`.

import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT,
  DB_PATH,
  env,
  envFileValues,
  oddsKeySource,
  footballConfig,
  basketballConfig,
  baseballConfig,
  nflConfig,
  tournamentsConfig,
} from '../config.ts';
import { getDb, getMeta } from '../db.ts';
import { ODDS_API_BASE, requestOdds, summarizeEvents, OddsApiError } from '../oddsApi.ts';
import { recordQuota, planTotal, withinMonthlyPace, lastCycleCredits, OddsBudgetSkip, creditCost } from '../oddsQuota.ts';
import { readKeyOutcomes, type SportPrefix } from '../oddsReason.ts';
import {
  comprobarConfiguracion,
  interpretarApi,
  comprobarDeportes,
  comprobarBaseDeDatos,
  comprobarFrescura,
  comprobarServidor,
  resultado,
  type Hallazgo,
  type Listado,
  type Seccion,
  type DeporteConfig,
  type ConteoDeporte,
} from '../doctor/checks.ts';

const SIN_RED = process.argv.includes('--sin-red') || process.argv.includes('--no-net');
const PROBAR = process.argv.includes('--probar') || process.argv.includes('--probe');
const C = { bold: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', amber: '\x1b[33m', off: '\x1b[0m' };

const hallazgos: Hallazgo[] = [];

// ---------------------------------------------------------------------------
// Qué deporte es qué, en cada sitio
// ---------------------------------------------------------------------------
interface Deporte {
  nombre: string;
  prefijo: SportPrefix;
  claves: string[];
  tabla: string;
  precio: string;
  meta: string;
}
const DEPORTES: Deporte[] = [
  { nombre: 'Fútbol', prefijo: 'fb_', claves: footballConfig.leagues.flatMap((l) => l.oddsSportKeys ?? []), tabla: 'fb_upcoming', precio: 'odds_home', meta: 'fb_odds_refreshed_at' },
  { nombre: 'NBA', prefijo: 'bb_', claves: basketballConfig.leagues.flatMap((l) => l.oddsSportKeys ?? []), tabla: 'bb_upcoming', precio: 'home_odds', meta: 'bb_odds_refreshed_at' },
  { nombre: 'MLB', prefijo: 'bsb_', claves: baseballConfig.leagues.flatMap((l) => l.oddsSportKeys ?? []), tabla: 'bsb_upcoming', precio: 'odds_home', meta: 'bsb_odds_refreshed_at' },
  { nombre: 'NFL', prefijo: 'naf_', claves: nflConfig.leagues.flatMap((l) => l.oddsSportKeys ?? []), tabla: 'naf_upcoming', precio: 'odds_home', meta: 'naf_odds_refreshed_at' },
  {
    nombre: 'Tenis',
    prefijo: '',
    // El tenis guarda sus claves como { atp: clave, wta: clave }, y además la ingesta
    // pide TODOS los torneos de tenis activos, no solo los configurados.
    claves: tournamentsConfig.tournaments.flatMap((t) => Object.values(t.oddsSportKeys ?? {})),
    tabla: 'upcoming_matches',
    precio: 'p1_odds',
    meta: 'odds_refreshed_at',
  },
];

// ---------------------------------------------------------------------------
// CONFIGURACIÓN
// ---------------------------------------------------------------------------
const envPath = path.join(ROOT, '.env');
const envExiste = fs.existsSync(envPath);
const otrosEnv = [path.join(ROOT, '..', '.env'), path.join(ROOT, 'server', '.env'), path.join(ROOT, 'web', '.env'), path.join(process.cwd(), '.env')]
  .map((p) => path.resolve(p))
  .filter((p, i, a) => p !== path.resolve(envPath) && a.indexOf(p) === i && fs.existsSync(p));
const zona = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'desconocida';
hallazgos.push(
  ...comprobarConfiguracion({
    envPath,
    envExiste,
    envCrudo: envExiste ? fs.readFileSync(envPath, 'utf8') : '',
    otrosEnv,
    valoresFichero: envFileValues,
    valoresProceso: { ODDS_API_KEY: process.env.ODDS_API_KEY, THE_ODDS_API_KEY: process.env.THE_ODDS_API_KEY },
    clave: oddsKeySource,
    regiones: env.oddsRegions,
    zonaHoraria: zona,
    offsetMin: -new Date().getTimezoneOffset(),
  }),
);

// ---------------------------------------------------------------------------
// THE ODDS API — /v4/sports es gratis: valida la clave y trae el cupo sin gastar
// ---------------------------------------------------------------------------
// La base se abre DESPUÉS de mirar si existe: getDb() la crea vacía si no está, y
// entonces «no existe la base de datos» nunca saldría.
const dbExistia = fs.existsSync(DB_PATH);
let listado: Listado | null = null;
if (env.oddsApiKey && !SIN_RED) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${ODDS_API_BASE}/sports/?apiKey=${encodeURIComponent(env.oddsApiKey)}`);
    const ms = Date.now() - t0;
    recordQuota(res);
    const cuerpo = res.ok ? '' : await res.text().catch(() => '');
    let deportes: Listado['deportes'] = null;
    if (res.ok) {
      try {
        deportes = (await res.json()) as Listado['deportes'];
      } catch {
        deportes = null;
      }
    }
    const num = (k: string) => {
      const v = res.headers.get(k);
      return v == null || !Number.isFinite(Number(v)) ? null : Number(v);
    };
    listado = { status: res.status, cuerpo, restantes: num('x-requests-remaining'), usados: num('x-requests-used'), ms, errorRed: null, deportes };
  } catch (e) {
    listado = { status: null, cuerpo: '', restantes: null, usados: null, ms: null, errorRed: (e as Error).message, deportes: null };
  }
}
hallazgos.push(
  ...interpretarApi({
    hayClave: !!env.oddsApiKey,
    sinRed: SIN_RED,
    listado,
    plan: planTotal(),
    ritmo: withinMonthlyPace(1),
    gastoPorCiclo: lastCycleCredits(),
    minutosEntreCiclos: env.autoRefreshMinutes,
  }),
);

// ---------------------------------------------------------------------------
// DEPORTES — la última descarga, y el sondeo si se pidió
// ---------------------------------------------------------------------------
const activas = new Set((listado?.deportes ?? []).filter((s) => s.active && !s.has_outrights).map((s) => s.key));
const tenisActivas = (listado?.deportes ?? []).filter((s) => s.group === 'Tennis' && s.active && !s.has_outrights).map((s) => s.key);
const primeraActiva = (d: Deporte): string | null =>
  d.nombre === 'Tenis' ? (tenisActivas[0] ?? null) : (d.claves.find((k) => activas.has(k)) ?? null);

if (PROBAR && listado?.status === 200) {
  const aProbar = DEPORTES.filter((d) => primeraActiva(d));
  console.log(
    `${C.amber}--probar: ${aProbar.length} petición(es) reales, ${aProbar.length * creditCost('h2h')} crédito(s) de tu plan.${C.off}`,
  );
}
const deportesConfig: DeporteConfig[] = [];
for (const d of DEPORTES) {
  const conf: DeporteConfig = { nombre: d.nombre, claves: d.nombre === 'Tenis' ? [...new Set([...d.claves, ...tenisActivas])] : d.claves, ultimas: readKeyOutcomes(d.prefijo) };
  const clave = primeraActiva(d);
  if (PROBAR && listado?.status === 200 && clave) {
    try {
      const r = await requestOdds(clave, { manual: true });
      const s = summarizeEvents(r.events);
      conf.sondeo = { key: clave, eventos: s.eventos, conPrecio: s.conPrecio, casas: s.casas, mercados: s.mercados };
    } catch (e) {
      conf.sondeo = {
        key: clave,
        error: (e as Error).message,
        kind: e instanceof OddsBudgetSkip ? 'presupuesto' : e instanceof OddsApiError ? e.kind : 'error_proveedor',
      };
    }
  }
  deportesConfig.push(conf);
}
hallazgos.push(...comprobarDeportes(deportesConfig, listado?.status === 200 ? listado.deportes : null, !!env.oddsApiKey));

// ---------------------------------------------------------------------------
// BASE DE DATOS y ACTUALIZACIÓN
// ---------------------------------------------------------------------------
const conteos: ConteoDeporte[] = [];
const frescura: { nombre: string; ultimoRefresco: string | null; precioMasNuevo: string | null }[] = [];
if (dbExistia) {
  const db = getDb();
  for (const d of DEPORTES) {
    try {
      const r = db
        .prepare(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN source = 'fixture' THEN 1 ELSE 0 END) AS demo,
                  SUM(CASE WHEN source <> 'fixture' AND ${d.precio} IS NOT NULL THEN 1 ELSE 0 END) AS reales,
                  SUM(CASE WHEN source <> 'fixture' AND ${d.precio} IS NULL THEN 1 ELSE 0 END) AS sin,
                  MAX(CASE WHEN source <> 'fixture' AND ${d.precio} IS NOT NULL THEN updated_at END) AS nuevo
           FROM ${d.tabla}`,
        )
        .get() as { total: number; demo: number | null; reales: number | null; sin: number | null; nuevo: string | null };
      conteos.push({ nombre: d.nombre, total: r.total, reales: r.reales ?? 0, demo: r.demo ?? 0, sinCuotas: r.sin ?? 0 });
      frescura.push({ nombre: d.nombre, ultimoRefresco: getMeta(d.meta), precioMasNuevo: r.nuevo });
    } catch {
      conteos.push({ nombre: d.nombre, total: 0, reales: 0, demo: 0, sinCuotas: 0 });
    }
  }
}
hallazgos.push(...comprobarBaseDeDatos(DB_PATH, dbExistia, conteos, !!env.oddsApiKey));
if (dbExistia) hallazgos.push(...comprobarFrescura(frescura, new Date(), !!env.oddsApiKey));

// ---------------------------------------------------------------------------
// SERVIDOR Y PANTALLA — ¿llega hasta la pantalla lo que hay en la base?
// ---------------------------------------------------------------------------
let puertos = { api: env.port, web: 7373 as number | null };
try {
  const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', '.dev-ports.json'), 'utf8')) as { api?: number; web?: number };
  puertos = { api: p.api ?? env.port, web: p.web ?? null };
} catch {
  // Sin fichero: los puertos por defecto. Se comprueban igual, no se dan por buenos.
}
const pedir = async (url: string): Promise<{ ok: boolean; error?: string; json?: unknown }> => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const texto = await res.text();
    try {
      return { ok: true, json: JSON.parse(texto) };
    } catch {
      return { ok: true };
    }
  } catch (e) {
    return { ok: false, error: (e as Error).name === 'TimeoutError' ? 'no contesta' : 'no está arrancado' };
  }
};
const api = await pedir(`http://127.0.0.1:${puertos.api}/api/health`);
let hoy: { partidos: number; conPrecio: number } | null = null;
let web: { ok: boolean; error?: string } | null = null;
if (api.ok) {
  const t = await pedir(`http://127.0.0.1:${puertos.api}/api/today`);
  const ps = ((t.json as { partidos?: { precioReal?: boolean }[] } | undefined)?.partidos) ?? null;
  if (ps) hoy = { partidos: ps.length, conPrecio: ps.filter((p) => p.precioReal).length };
  if (puertos.web) web = await pedir(`http://127.0.0.1:${puertos.web}/`);
}
hallazgos.push(...comprobarServidor({ puertoApi: puertos.api, puertoWeb: puertos.web, api, web, hoy }));

// ---------------------------------------------------------------------------
// Impresión
// ---------------------------------------------------------------------------
const marca = { ok: `${C.green}✓${C.off}`, aviso: `${C.amber}⚠${C.off}`, error: `${C.red}✗${C.off}`, info: `${C.dim}·${C.off}` };
const orden: Seccion[] = ['CONFIGURACIÓN', 'THE ODDS API', 'DEPORTES', 'BASE DE DATOS', 'ACTUALIZACIÓN', 'SERVIDOR Y PANTALLA'];
for (const s of orden) {
  const hs = hallazgos.filter((x) => x.seccion === s);
  if (hs.length === 0) continue;
  console.log(`\n${C.bold}${s}${C.off}`);
  for (const x of hs) {
    console.log(`${marca[x.nivel]} ${x.texto}`);
    for (const d of x.detalle ?? []) console.log(`    ${C.dim}${d}${C.off}`);
  }
}

const r = resultado(hallazgos);
console.log(`\n${C.bold}RESULTADO${C.off}`);
console.log(r.nivel === 'ok' ? `${C.green}${r.texto}${C.off}` : r.nivel === 'aviso' ? `${C.amber}${r.texto}${C.off}` : `${C.red}${r.texto}${C.off}`);
if (r.acciones.length > 0) {
  console.log(`\n${C.bold}QUÉ HACER${C.off}  (en este orden)`);
  r.acciones.forEach((a, i) => {
    console.log(`\n${C.bold}${i + 1}) ${a.texto}${C.off}`);
    console.log('   Solución:');
    for (const l of a.accion) console.log(`     ${l}`);
  });
  console.log(`\n${C.dim}Tras tocar el .env, reinicia el servidor: el .env solo se lee al arrancar (npm run dev).${C.off}`);
}
if (!PROBAR && env.oddsApiKey && !SIN_RED) {
  console.log(`\n${C.dim}Para ver eventos, mercados y casas reales de cada deporte: npm run doctor -- --probar (1 crédito por deporte).${C.off}`);
}
process.exit(r.nivel === 'error' ? 1 : 0);
