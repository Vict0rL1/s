// `npm run doctor` — diagnóstico de punta a punta de las cuotas reales.
//
//   npm run doctor              gratis: no gasta ni un crédito
//   npm run doctor -- --probar  gasta UN crédito por deporte en juego para ver eventos,
//                               mercados y casas reales de verdad
//   npm run doctor -- --sin-red no habla con The Odds API
//
// Recorre el flujo entero, en el orden en que viaja una cuota:
//
//   .env → The Odds API → competiciones → base de datos → frescura → confianza → backend → pantalla
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
  env,
  envFileValues,
  oddsKeySource,
  footballConfig,
  basketballConfig,
  baseballConfig,
  nflConfig,
  nhlConfig,
  ufcConfig,
  tournamentsConfig,
} from '../config.ts';
import { getDb, getMeta, MIGRACIONES } from '../db.ts';
import { ODDS_API_BASE, requestOdds, summarizeEvents, OddsApiError } from '../oddsApi.ts';
import { recordQuota, planTotal, withinMonthlyPace, lastCycleCredits, OddsBudgetSkip, creditCost } from '../oddsQuota.ts';
import { readKeyOutcomes, type SportPrefix } from '../oddsReason.ts';
import {
  comprobarConfiguracion,
  interpretarApi,
  comprobarDeportes,
  comprobarBaseDeDatos,
  comprobarFrescura,
  comprobarConfianza,
  comprobarSeguridad,
  comprobarAlmacenamiento,
  comprobarAnalitica,
  type EstadoAnalitica,
  comprobarProducto,
  comprobarOperacion,
  type EstadoOperacion,
  type EstadoProducto,
  type EstadoAlmacenamiento,
  comprobarServidor,
  resultado,
  type Hallazgo,
  type Listado,
  type Seccion,
  type DeporteConfig,
  type ConteoDeporte,
  type EstadoConfianza,
  type EstadoSeguridad,
  type FamiliaContada,
} from '../doctor/checks.ts';
import { META_CICLO } from '../prematch/snapshots.ts';
import { LEGACY_DB_PATH, rutaPrincipal } from '../db/layout.ts';
import { familiaDeMotivo } from '../trust/decision.ts';
import { execFileSync } from 'node:child_process';
import { configAuth } from '../auth/mode.ts';
import { LAYOUT, ficherosDe } from '../db/layout.ts';
import { estadoPorVersion } from '../db/migrations.ts';
import { copiasLocales, ultimaCopia } from '../db/backup.ts';
import { configS3 } from '../db/s3.ts';
import { marcarMuertas, ultimasEjecuciones } from '../ingest/runs.ts';
import { sesionesActivas } from '../auth/sessions.ts';
import { featureEncendida, estadoFeatures, leerFeatures } from '../features.ts';
import { historicosDisponibles } from '../estrategias/historico.ts';
import { zonaApp } from '../informes/tiempo.ts';
import { eventosRecientes } from '../odds/intel.ts';
import { origenesPermitidos } from '../security/cors.ts';
import { monitorizacion as monitorizacionDe } from '../monitoring/series.ts';
import { predicciones as prediccionesEnVivo } from '../evaluation/live.ts';
import { leerDiagramasBacktest } from '../evaluation/reliability.ts';
import { CLAVE_ANULACIONES } from '../features.ts';
import { SPORT_IDS } from '../sports.ts';
import { chatsPermitidos, CLAVE_OFFSET } from '../telegram/asistente.ts';
import { contarErrores } from '../security/errors.ts';
import { canales as canalesDeAviso } from '../notifications/index.ts';

const SIN_RED = process.argv.includes('--sin-red') || process.argv.includes('--no-net');
const PROBAR = process.argv.includes('--probar') || process.argv.includes('--probe');
const FUENTES = process.argv.includes('--fuentes');
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
  { nombre: 'NHL', prefijo: 'nhl_', claves: [nhlConfig.odds.sportKey], tabla: 'nhl_upcoming', precio: 'odds_home', meta: 'nhl_odds_refreshed_at' },
  { nombre: 'UFC', prefijo: 'ufc_', claves: [ufcConfig.odds.sportKey], tabla: 'ufc_upcoming', precio: 'odds_home', meta: 'ufc_odds_refreshed_at' },
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
const dbExistia = fs.existsSync(rutaPrincipal()) || fs.existsSync(LEGACY_DB_PATH);
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
hallazgos.push(...comprobarBaseDeDatos(rutaPrincipal(), dbExistia, conteos, !!env.oddsApiKey));
if (dbExistia) hallazgos.push(...comprobarFrescura(frescura, new Date(), !!env.oddsApiKey));

// ---------------------------------------------------------------------------
// CONFIANZA — ¿corre el ciclo pre-partido y por qué se abstiene?
// ---------------------------------------------------------------------------
if (dbExistia) {
  const db = getDb();
  const ahora = new Date();
  const iso = (msAtras: number) => new Date(ahora.getTime() - msAtras).toISOString();
  const uno = <T>(f: () => T, porDefecto: T): T => {
    try {
      return f();
    } catch {
      // Una base anterior a la capa de confianza no tiene las tablas: se cuenta cero.
      return porDefecto;
    }
  };
  const ultimoCiclo = getMeta(META_CICLO);
  let conCuotaPorEmpezar = 0;
  for (const d of DEPORTES) {
    conCuotaPorEmpezar += uno(
      () => (db.prepare(`SELECT COUNT(*) AS n FROM ${d.tabla} WHERE source <> 'fixture' AND ${d.precio} IS NOT NULL AND commence_time > ?`).get(ahora.toISOString()) as { n: number }).n,
      0,
    );
  }
  const sinFinal = (desde: string | null, hasta: string) =>
    uno(
      () =>
        (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM (SELECT DISTINCT sport, match_key FROM prediction_snapshots s
                WHERE s.commence_time <= ? AND (? IS NULL OR s.commence_time > ?)
                  AND NOT EXISTS (SELECT 1 FROM prematch_final f WHERE f.sport = s.sport AND f.match_key = s.match_key))`,
            )
            .get(hasta, desde, desde) as { n: number }
        ).n,
      0,
    );
  const contar = (filas: string[][]): FamiliaContada[] => {
    const m = new Map<string, FamiliaContada>();
    for (const motivos of filas) {
      // Una abstención con dos motivos de la misma familia cuenta una vez en ella.
      for (const f of new Map(motivos.map((x) => { const g = familiaDeMotivo(x); return [g.familia, g]; })).values()) {
        const e = m.get(f.familia) ?? { ...f, n: 0 };
        e.n++;
        m.set(f.familia, e);
      }
    }
    return [...m.values()];
  };
  // La decisión MÁS RECIENTE de cada partido evaluado en 24 h.
  const recientes = uno(
    () =>
      db
        .prepare(
          `SELECT a.decision, a.reasons FROM prediction_assessments a
            WHERE a.assessed_at >= ?
              AND a.id = (SELECT MAX(b.id) FROM prediction_assessments b WHERE b.sport = a.sport AND b.match_key = a.match_key)`,
        )
        .all(iso(24 * 3_600_000)) as { decision: 'BET' | 'NO BET' | 'SIN MERCADO'; reasons: string }[],
    [],
  );
  const evaluaciones24h = { BET: 0, 'NO BET': 0, 'SIN MERCADO': 0 };
  for (const r of recientes) evaluaciones24h[r.decision]++;
  // El ÚLTIMO motivo de abstención del banco por partido, en 7 días.
  const banco = uno(
    () =>
      db
        .prepare(
          `SELECT s.reason FROM edge_signals s
            WHERE s.created_at >= ? AND s.decision = 'rechazada' AND s.reason LIKE 'abstención:%'
              AND s.id = (SELECT MAX(x.id) FROM edge_signals x WHERE x.sport = s.sport AND x.event_id = s.event_id AND x.created_at >= ?)`,
        )
        .all(iso(7 * 86_400_000), iso(7 * 86_400_000)) as { reason: string }[],
    [],
  );
  const alertas = uno(
    () => db.prepare('SELECT severity, COUNT(*) AS n FROM alerts WHERE created_at >= ? GROUP BY severity').all(iso(24 * 3_600_000)) as { severity: 'info' | 'aviso' | 'importante'; n: number }[],
    [],
  );
  const deriva = uno(
    () => db.prepare("SELECT sport, body FROM alerts WHERE type = 'deriva' AND created_at >= ? ORDER BY id DESC LIMIT 1").get(iso(7 * 86_400_000)) as { sport: string | null; body: string } | undefined,
    undefined,
  );
  const estado: EstadoConfianza = {
    ultimoCiclo,
    conCuotaPorEmpezar,
    sinCongelarTrasCiclo: ultimoCiclo ? sinFinal(null, ultimoCiclo) : 0,
    pendientesDeCongelar: sinFinal(ultimoCiclo, ahora.toISOString()),
    congeladas: uno(() => (db.prepare('SELECT COUNT(*) AS n FROM prematch_final').get() as { n: number }).n, 0),
    evaluaciones24h,
    motivos24h: contar(recientes.filter((r) => r.decision === 'NO BET').map((r) => JSON.parse(r.reasons) as string[])),
    banco7d: { total: banco.length, familias: contar(banco.map((b) => [b.reason])) },
    alertas24h: { importante: 0, aviso: 0, info: 0, ...Object.fromEntries(alertas.map((a) => [a.severity, a.n])) },
    deriva7d: deriva ? `${deriva.sport ? `${deriva.sport}: ` : ''}${deriva.body}` : null,
  };
  hallazgos.push(...comprobarConfianza(estado, ahora));
}

// ---------------------------------------------------------------------------
// DATOS Y COPIAS — ficheros, migraciones, copia del libro mayor, ingestas
// ---------------------------------------------------------------------------
{
  const db = getDb();
  const ahora = new Date();
  const tam = (ruta: string | null) => (ruta && fs.existsSync(ruta) ? { ruta, mb: fs.statSync(ruta).size / 1048576 } : null);
  const f = ficherosDe();
  const dataDir = path.dirname(f.history);
  const preSplit = fs.existsSync(dataDir) ? fs.readdirSync(dataDir).filter((x) => x.includes('.pre-split-')) : [];
  const fallidas: string[] = [];
  for (const [schema, nombre] of LAYOUT === 'split' ? ([['main', 'history'], ['ledger', 'ledger']] as const) : ([['main', 'tennis.db']] as const)) {
    try {
      for (const [v, e] of estadoPorVersion(db, schema)) if (e.estado === 'failed') fallidas.push(`v${v} ${MIGRACIONES.find((m) => m.version === v)?.nombre ?? ''} en ${nombre}`);
    } catch {
      // sin schema_version: base anterior a la fase; lo dirá la migración al arrancar
    }
  }
  const uno = <T,>(fn: () => T, porDefecto: T): T => {
    try {
      return fn();
    } catch {
      return porDefecto;
    }
  };
  const copia = uno(() => ultimaCopia(), null);
  const retAt = getMeta('retention:last_at');
  const estado: EstadoAlmacenamiento = {
    layout: LAYOUT,
    history: tam(f.history),
    ledger: tam(f.ledger),
    preSplit,
    legacySinPartir: LAYOUT === 'split' && fs.existsSync(LEGACY_DB_PATH) && !fs.existsSync(f.history) && !fs.existsSync(f.ledger!),
    migracionesFallidas: fallidas,
    backup: copia ? { cuando: copia.cuando, fichero: copia.fichero, existe: !!copia.fichero && fs.existsSync(copia.fichero) } : null,
    copiasLocales: uno(() => copiasLocales().length, 0),
    backupHoras: process.env.BACKUP_HOURS?.trim() ? Number(process.env.BACKUP_HOURS) || 0 : 24,
    s3: !!configS3(),
    apuestasRegistradas: uno(() => (db.prepare('SELECT COUNT(*) AS n FROM paper_bets').get() as { n: number }).n, 0),
    retencion: retAt ? { cuando: retAt, borradas: Number(getMeta('retention:last_removed')) || 0 } : null,
    snapshots: uno(() => (db.prepare('SELECT COUNT(*) AS n FROM odds_snapshots').get() as { n: number }).n, 0),
    ejecuciones: uno(() => ultimasEjecuciones(), []),
    muertas: uno(() => marcarMuertas(ahora), 0),
  };
  hallazgos.push(...comprobarAlmacenamiento(estado, ahora));
}

// ---------------------------------------------------------------------------
// OPERACIÓN — trabajos, canales de aviso, interruptores, frescura y fuentes (Fase 9)
// ---------------------------------------------------------------------------
{
  const db = getDb();
  const uno = <T,>(fn: () => T, porDefecto: T): T => {
    try {
      return fn();
    } catch {
      return porDefecto;
    }
  };
  const feats = estadoFeatures(process.env);
  const conocidas = new Set(Object.keys(leerFeatures()));
  const yyyymmdd = (x: string | null) => (x && /^\d{8}$/.test(x) ? `${x.slice(0, 4)}-${x.slice(4, 6)}-${x.slice(6, 8)}` : x);
  const ultimoDe = (deporte: string, sql: string) =>
    uno(() => {
      const r = db.prepare(sql).get() as { u: string | null; n: number };
      return { deporte, ultimo: yyyymmdd(r.u), partidos: r.n };
    }, { deporte, ultimo: null, partidos: 0 });
  const desde24h = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const estadoO: EstadoOperacion = {
    registroOn: featureEncendida('operacion.registroTrabajos'),
    trabajos: uno(
      () =>
        (db.prepare('SELECT name, enabled, last_status, last_run_at, last_error, COALESCE(cadence_override, cadence_minutes) AS c FROM scheduler_jobs ORDER BY name').all() as {
          name: string; enabled: number; last_status: string | null; last_run_at: string | null; last_error: string | null; c: number;
        }[]).map((r) => ({ nombre: r.name, enabled: !!r.enabled, lastStatus: r.last_status, lastRunAt: r.last_run_at, lastError: r.last_error, cadenciaMin: r.c })),
      [],
    ),
    canalesOn: featureEncendida('notificaciones.canales'),
    canales: uno(() => canalesDeAviso().map((c) => ({ nombre: c.nombre, configurado: c.configurado, falta: c.falta })), []),
    envios24h: uno(() => {
      const r = db.prepare('SELECT SUM(ok = 1) AS bien, SUM(ok = 0) AS mal FROM notification_log WHERE created_at >= ?').get(desde24h) as { bien: number | null; mal: number | null };
      const u = db.prepare('SELECT channel, error FROM notification_log WHERE ok = 0 AND created_at >= ? ORDER BY created_at DESC LIMIT 1').get(desde24h) as { channel: string; error: string | null } | undefined;
      return { ok: r.bien ?? 0, fallidos: r.mal ?? 0, ultimoError: u ? { canal: u.channel, error: u.error ?? 'sin detalle' } : null };
    }, { ok: 0, fallidos: 0, ultimoError: null }),
    interruptores: {
      total: Object.keys(feats).length,
      encendidos: Object.values(feats).filter((f) => f.on).length,
      inactivos: Object.entries(feats).filter(([, f]) => f.falta).map(([nombre, f]) => ({ nombre, falta: f.falta! })),
      huerfanas: uno(() => Object.keys(JSON.parse(getMeta(CLAVE_ANULACIONES) ?? '{}') as Record<string, boolean>).filter((k) => !conocidas.has(k)), [] as string[]),
    },
    frescura: [
      ultimoDe('Tenis', 'SELECT MAX(tourney_date) AS u, COUNT(*) AS n FROM matches'),
      ultimoDe('Fútbol', 'SELECT MAX(match_date) AS u, COUNT(*) AS n FROM fb_matches'),
      ultimoDe('Baloncesto', "SELECT MAX(game_date) AS u, COUNT(*) AS n FROM bb_games WHERE league = 'nba'"),
      ultimoDe('Béisbol', 'SELECT MAX(game_date) AS u, COUNT(*) AS n FROM bsb_games'),
      ultimoDe('NFL', 'SELECT MAX(game_date) AS u, COUNT(*) AS n FROM naf_games'),
      ultimoDe('NHL', 'SELECT MAX(game_date) AS u, COUNT(*) AS n FROM nhl_games'),
      ultimoDe('UFC', 'SELECT MAX(fecha) AS u, COUNT(*) AS n FROM ufc_fights'),
    ],
  };
  if (FUENTES) {
    // Una petición ligera a cada fuente: ¿contesta desde aquí? (403 suele ser la red de la máquina.)
    const FUENTES_DATOS: [string, string][] = [
      ['GitHub (TML, openfootball, nflverse, Retrosheet, FPL, UFC)', 'https://raw.githubusercontent.com/nflverse/nfldata/master/README.md'],
      ['GitHub releases (NHL, sportsdataverse)', 'https://github.com/sportsdataverse/sportsdataverse-data/releases/download/nhl_schedules/nhl_schedule_2025.csv'],
      ['tennis-data.co.uk', 'http://www.tennis-data.co.uk/alldata.php'],
      ['football-data.co.uk', 'https://www.football-data.co.uk/data.php'],
      ['ESPN', 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard'],
      ['MLB Stats API', 'https://statsapi.mlb.com/api/v1/sports'],
      ['Open-Meteo', 'https://api.open-meteo.com/v1/forecast?latitude=40.4&longitude=-3.7&hourly=temperature_2m&forecast_days=1'],
      ['ClubElo', 'http://api.clubelo.com/Barcelona'],
      ['The Odds API', 'https://api.the-odds-api.com/v4/sports/?apiKey=sin-clave'],
      ['NHL API (segunda fuente)', 'https://api-web.nhle.com/v1/schedule/now'],
      ['Telegram', 'https://api.telegram.org/'],
    ];
    estadoO.fuentes = await Promise.all(
      FUENTES_DATOS.map(async ([nombre, url]) => {
        const host = new URL(url).host;
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'follow' });
          await res.body?.cancel();
          // The Odds API contesta 401 sin clave: eso es que llega.
          const ok = res.status < 400 || (host === 'api.the-odds-api.com' && res.status === 401) || (host === 'api.telegram.org' && res.status === 404);
          return { nombre, host, ok, detalle: ok ? `contesta (${res.status})` : res.status === 403 ? 'responde 403: lo bloquea la red de esta máquina o el propio sitio' : `responde ${res.status}` };
        } catch (e) {
          return { nombre, host, ok: false, detalle: `no contesta (${(e as Error).name === 'TimeoutError' ? 'tiempo agotado' : (e as Error).message})` };
        }
      }),
    );
  }
  hallazgos.push(...comprobarOperacion(estadoO, new Date()));
}

// ---------------------------------------------------------------------------
// ANALÍTICA E INTERFAZ — monitorización, simulación, calendario, ajustes, seguimiento
// ---------------------------------------------------------------------------
{
  const db = getDb();
  const ahora = new Date();
  const uno = <T,>(fn: () => T, porDefecto: T): T => {
    try {
      return fn();
    } catch {
      return porDefecto;
    }
  };
  const monitorizacion = SPORT_IDS.map((dep) =>
    uno(() => {
      const m = monitorizacionDe(dep, ahora);
      return { deporte: dep, n: m.deriva.n, deriva: m.deriva.hay, motivos: m.deriva.motivos };
    }, { deporte: dep, n: 0, deriva: false, motivos: [] as string[] }),
  );
  const estadoA: EstadoAnalitica = {
    monitorizacion,
    ultimaSerie: uno(() => (db.prepare('SELECT MAX(day) AS d FROM monitoring_series').get() as { d: string | null }).d, null),
    predichasConResultado: SPORT_IDS.reduce((a, dep) => a + uno(() => prediccionesEnVivo(dep).length, 0), 0),
    simulacion: uno(() => {
      const r = db.prepare('SELECT MAX(day) AS d, COUNT(DISTINCT sport || league) AS n FROM simulation_runs').get() as { d: string | null; n: number };
      return { ultimoDia: r.d, ligas: r.n };
    }, { ultimoDia: null, ligas: 0 }),
    calendarioPendiente: uno(() => (db.prepare('SELECT COUNT(*) AS n FROM remaining_fixtures').get() as { n: number }).n, 0),
    fiabilidadBacktest: uno(() => Object.keys(leerDiagramasBacktest()).length, 0),
    anulaciones: uno(() => Object.keys(JSON.parse(getMeta(CLAVE_ANULACIONES) ?? '{}') as Record<string, boolean>), [] as string[]),
    seguidos: uno(() => (db.prepare('SELECT COUNT(*) AS n FROM watchlist').get() as { n: number }).n, 0),
  };
  hallazgos.push(...comprobarAnalitica(estadoA, ahora));
}

// ---------------------------------------------------------------------------
// PRODUCTO — laboratorio de estrategias, bandeja, informes, líneas y archivo (Fase 6)
// ---------------------------------------------------------------------------
{
  const db = getDb();
  const uno = <T,>(fn: () => T, porDefecto: T): T => {
    try {
      return fn();
    } catch {
      return porDefecto;
    }
  };
  const estadoP: EstadoProducto = {
    estrategias: uno(() => {
      const e = db.prepare('SELECT SUM(archived_at IS NULL) AS a, SUM(archived_at IS NOT NULL) AS b FROM strategies').get() as { a: number | null; b: number | null };
      const b = db.prepare("SELECT COUNT(*) AS n, SUM(status = 'pending') AS p, MAX(placed_at) AS u FROM strategy_bets").get() as { n: number; p: number | null; u: string | null };
      return { activas: e.a ?? 0, archivadas: e.b ?? 0, apuestas: b.n, pendientes: b.p ?? 0, ultimaApuesta: b.u, laboratorio: featureEncendida('estrategias.laboratorio') };
    }, { activas: 0, archivadas: 0, apuestas: 0, pendientes: 0, ultimaApuesta: null, laboratorio: featureEncendida('estrategias.laboratorio') }),
    historicos: uno(() => historicosDisponibles(), []),
    hayCuotasReales: !!env.oddsApiKey,
    bandeja: uno(() => {
      const r = db.prepare('SELECT COUNT(*) AS n, SUM(leida_at IS NULL) AS u FROM inbox').get() as { n: number; u: number | null };
      return { on: featureEncendida('alertas.bandeja'), total: r.n, noLeidas: r.u ?? 0 };
    }, { on: featureEncendida('alertas.bandeja'), total: 0, noLeidas: 0 }),
    informes: uno(() => {
      const ult = (tipo: string) => (db.prepare('SELECT periodo, created_at AS creado FROM reports WHERE tipo = ? ORDER BY created_at DESC LIMIT 1').get(tipo) as { periodo: string; creado: string } | undefined) ?? null;
      return {
        diarioOn: featureEncendida('informes.diario'),
        semanalOn: featureEncendida('informes.semanal'),
        ultimoDiario: ult('diario'),
        ultimoSemanal: ult('semanal'),
        total: (db.prepare('SELECT COUNT(*) AS n FROM reports').get() as { n: number }).n,
        zona: zonaApp(),
      };
    }, undefined),
    lineas: { on: featureEncendida('mercado.lineas'), mercados: uno(() => eventosRecientes(new Date()).length, 0) },
    archivo: {
      on: featureEncendida('archivo.predicciones'),
      predicciones: uno(() => ['prediction_log', 'fb_prediction_log', 'bb_prediction_log', 'bsb_prediction_log', 'naf_prediction_log', 'nhl_prediction_log', 'ufc_prediction_log'].reduce((a, t) => a + (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n, 0), 0),
    },
    ampliaciones: {
      telegram: {
        on: featureEncendida('asistente.telegram'),
        token: !!process.env.TELEGRAM_BOT_TOKEN?.trim(),
        chats: chatsPermitidos(process.env).size,
        offset: uno(() => {
          const v = getMeta(CLAVE_OFFSET);
          return v == null ? null : Number(v);
        }, null),
      },
      enVivo: featureEncendida('tenis.enVivo'),
      propsNba: featureEncendida('apuestas.propsNba'),
    },
  };
  hallazgos.push(...comprobarProducto(estadoP, new Date()));
}

// ---------------------------------------------------------------------------
// SEGURIDAD — la puerta, las cabeceras y los secretos
// ---------------------------------------------------------------------------
{
  const auth = configAuth();
  const git = (args: string[]): string | null => {
    try {
      return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  };
  const hayGit = fs.existsSync(path.join(ROOT, '.git'));
  // `git check-ignore` sale con 0 si el fichero está ignorado y 1 si no.
  const envIgnorado = hayGit ? git(['check-ignore', '-q', '.env']) !== null : null;
  const hooksPath = hayGit ? git(['config', 'core.hooksPath']) : null;
  const hookInstalado = hayGit ? hooksPath === '.githooks' && fs.existsSync(path.join(ROOT, '.githooks', 'pre-commit')) : null;
  let gitleaks = false;
  try {
    execFileSync('gitleaks', ['version'], { stdio: 'ignore' });
    gitleaks = true;
  } catch {
    gitleaks = false;
  }
  let escaner: EstadoSeguridad['escaner'] = null;
  if (hayGit) {
    try {
      const salida = execFileSync('node', [path.join(ROOT, 'scripts', 'secret-scan.mjs'), '--tracked', '--json'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      escaner = JSON.parse(salida) as EstadoSeguridad['escaner'];
    } catch (e) {
      // Exit 1 = hay hallazgos; la salida JSON viene igual en stdout.
      const stdout = (e as { stdout?: string }).stdout;
      try {
        escaner = stdout ? (JSON.parse(stdout) as EstadoSeguridad['escaner']) : null;
      } catch {
        escaner = null;
      }
    }
  }
  let sesiones = 0;
  let errores24h = 0;
  if (dbExistia) {
    try {
      sesiones = sesionesActivas().length;
      errores24h = contarErrores(new Date(Date.now() - 24 * 3_600_000).toISOString());
    } catch {
      // Tablas aún no creadas: cero.
    }
  }
  hallazgos.push(
    ...comprobarSeguridad({
      produccion: auth.produccion,
      modo: auth.modo,
      authActiva: auth.activa,
      passwordLongitud: auth.password.length,
      totp: !!auth.totpSecret,
      sesionesActivas: sesiones,
      cabeceras: featureEncendida('seguridad.cabeceras'),
      errorLog: featureEncendida('seguridad.errorLog'),
      corsOrigenes: origenesPermitidos(),
      envIgnorado,
      hookInstalado,
      escaner,
      gitleaks,
      errores24h,
    }),
  );
}

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
const orden: Seccion[] = ['CONFIGURACIÓN', 'THE ODDS API', 'DEPORTES', 'BASE DE DATOS', 'ACTUALIZACIÓN', 'CONFIANZA', 'DATOS Y COPIAS', 'OPERACIÓN', 'ANALÍTICA E INTERFAZ', 'PRODUCTO', 'SEGURIDAD', 'SERVIDOR Y PANTALLA'];
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
