// El ÚNICO sitio que habla con The Odds API para pedir cuotas.
//
// ===========================================================================
// POR QUÉ EXISTE
// ===========================================================================
// Había cinco copias de la misma petición —una por deporte— y cada una trataba los
// errores a su manera. Tenis y baloncesto convertían un 404 o un 422 en «no hay
// partidos»; el tenis perdía los 401/429 de cada torneo y acababa diciendo `sin_ligas`
// («no sé traducir esos circuitos»), que es falso; y todas resumían el resultado en una
// palabra sin el código HTTP, así que ante «no hay partidos con precio» no había forma
// de saber si la API devolvió cero eventos, eventos sin casas, o un error disfrazado.
//
// Aquí se decide UNA vez qué significa cada respuesta, y nunca se convierte un error en
// una lista vacía. Una lista vacía es una respuesta 200 con `[]`; todo lo demás lanza
// `OddsApiError` con su causa, su código HTTP y el cuerpo que mandó el proveedor.
//
// Códigos de la API v4 (https://the-odds-api.com/liveapi/guides/v4/):
//   401  clave inválida o ausente (INVALID_KEY, MISSING_KEY) — o créditos agotados
//        (OUT_OF_USAGE_CREDITS): mismo código, causas opuestas, se separan por el cuerpo
//   404  deporte desconocido (UNKNOWN_SPORT)
//   422  parámetros inválidos (INVALID_REGION, INVALID_MARKET, INVALID_COMMENCE_TIME…)
//   429  demasiadas peticiones seguidas (EXCEEDED_FREQ_LIMIT) — NO es el cupo del mes

import { env } from './config.ts';
import { assertCanSpend, creditCost, recordQuota, setOddsError } from './oddsQuota.ts';
import { recordOddsResponse } from './odds/snapshots.ts';

export const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';

export type OddsApiFailure =
  | 'sin_clave'
  | 'clave_invalida'
  | 'sin_creditos'
  | 'limite_ritmo'
  | 'deporte_desconocido'
  | 'parametros_invalidos'
  | 'error_proveedor'
  | 'sin_red'
  | 'respuesta_invalida';

/** Qué hacer con cada fallo, en una frase. La leen el doctor y la pantalla. */
export const ACCION_POR_FALLO: Record<OddsApiFailure, string> = {
  sin_clave: 'Pon tu clave con `npm run clave` (o añade ODDS_API_KEY=tu-clave al .env de la raíz) y reinicia el servidor.',
  clave_invalida:
    'La clave no es válida para The Odds API. Cópiala otra vez desde tu cuenta de ' +
    'the-odds-api.com, ponla con `npm run clave` (32 caracteres) y reinicia.',
  sin_creditos:
    'Tu plan se quedó sin créditos este mes. Espera al reinicio mensual, cambia de plan, ' +
    'o baja el gasto con `npm run ahorro`.',
  limite_ritmo:
    'Demasiadas peticiones seguidas. No es el cupo del mes: espera un minuto y vuelve a ' +
    'intentarlo; si pasa siempre, sube AUTO_REFRESH_MINUTES.',
  deporte_desconocido:
    'El proveedor no reconoce esa clave de competición. Revisa oddsSportKeys en config/*.json ' +
    'contra `npm run doctor` (sección «Deportes»).',
  parametros_invalidos:
    'El proveedor rechazó los parámetros de la petición. Revisa ODDS_REGIONS en .env ' +
    '(valores válidos: us, us2, uk, eu, au, separados por comas).',
  error_proveedor: 'Fallo del lado del proveedor. Suele ser pasajero: vuelve a probar en unos minutos.',
  sin_red:
    'No se pudo conectar con api.the-odds-api.com. Comprueba la conexión a internet, una ' +
    'VPN o un cortafuegos que bloquee ese dominio.',
  respuesta_invalida:
    'El proveedor contestó con algo que no es una lista de eventos. Guarda la salida de ' +
    '`npm run doctor -- --probar` y revísala: puede haber cambiado su formato.',
};

export class OddsApiError extends Error {
  constructor(
    public readonly kind: OddsApiFailure,
    message: string,
    public readonly status: number | null = null,
    public readonly body: string = '',
  ) {
    super(message);
    this.name = 'OddsApiError';
  }
}

export interface OddsOutcome {
  name: string;
  price: number;
  point?: number;
}
export interface OddsMarket {
  key: string;
  last_update?: string;
  outcomes: OddsOutcome[];
}
export interface OddsBookmaker {
  key: string;
  title: string;
  last_update?: string;
  markets: OddsMarket[];
}
export interface OddsEvent {
  id: string;
  sport_key: string;
  sport_title?: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: OddsBookmaker[];
}

/**
 * Qué significa una respuesta que no es 2xx.
 *
 * Exportada para poder probarla sin red: es la parte donde un error se convertía en
 * silencio, y es la que tiene que estar fijada por tests.
 */
export function classifyFailure(status: number, body: string): { kind: OddsApiFailure; message: string } {
  const b = body.toUpperCase();
  const code = /"ERROR_CODE"\s*:\s*"([A-Z_]+)"/.exec(b)?.[1] ?? null;
  const detalle = code ? ` (${code})` : '';
  if (status === 401) {
    if (b.includes('OUT_OF_USAGE_CREDITS') || b.includes('USAGE QUOTA') || b.includes('QUOTA')) {
      return { kind: 'sin_creditos', message: `The Odds API: créditos del plan agotados (HTTP 401${detalle}).` };
    }
    return { kind: 'clave_invalida', message: `The Odds API rechazó la clave (HTTP 401${detalle}).` };
  }
  if (status === 429) {
    return { kind: 'limite_ritmo', message: `The Odds API: demasiadas peticiones seguidas (HTTP 429${detalle}).` };
  }
  if (status === 404) {
    return { kind: 'deporte_desconocido', message: `The Odds API no reconoce la competición (HTTP 404${detalle}).` };
  }
  if (status === 422) {
    return {
      kind: 'parametros_invalidos',
      message: `The Odds API rechazó los parámetros (HTTP 422${detalle})${body ? `: ${body.slice(0, 160)}` : ''}.`,
    };
  }
  return { kind: 'error_proveedor', message: `The Odds API respondió HTTP ${status}${detalle}.` };
}

/** Descarta lo que no tenga la forma mínima de un evento, sin inventar nada. */
function isEvent(x: unknown): x is OddsEvent {
  const e = x as OddsEvent;
  return (
    !!e &&
    typeof e.id === 'string' &&
    typeof e.commence_time === 'string' &&
    !Number.isNaN(Date.parse(e.commence_time)) &&
    Array.isArray(e.bookmakers ?? [])
  );
}

export interface OddsResponse {
  events: OddsEvent[];
  /** Créditos que costó, según la tabla de `creditCost`. */
  credits: number;
  /** Cuándo llegó la respuesta, en ISO UTC. Es la marca de los snapshots. */
  fetchedAt: string;
  /** Eventos que el proveedor mandó con una forma que no se entiende. */
  malformed: number;
}

/**
 * Pide las cuotas de UNA competición.
 *
 * Lanza `OddsBudgetSkip` si el freno de presupuesto no deja preguntar (antes de gastar
 * nada), y `OddsApiError` para cualquier otra cosa que no sea una lista de eventos.
 */
export async function requestOdds(
  sportKey: string,
  opts: { markets?: string; manual?: boolean } = {},
): Promise<OddsResponse> {
  const markets = opts.markets ?? 'h2h';
  if (!env.oddsApiKey) {
    throw new OddsApiError('sin_clave', 'No hay ODDS_API_KEY: no se puede pedir ninguna cuota.');
  }
  const credits = creditCost(markets);
  assertCanSpend(credits, opts.manual ?? false);

  const url =
    `${ODDS_API_BASE}/sports/${encodeURIComponent(sportKey)}/odds/` +
    `?apiKey=${encodeURIComponent(env.oddsApiKey)}` +
    `&regions=${encodeURIComponent(env.oddsRegions)}` +
    `&markets=${encodeURIComponent(markets)}` +
    `&oddsFormat=decimal&dateFormat=iso`;

  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new OddsApiError('sin_red', `Sin conexión con The Odds API: ${(e as Error).message}`);
  }
  recordQuota(res);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const f = classifyFailure(res.status, body);
    // Los fallos de la CLAVE valen para todos los deportes y se enseñan en la cabecera;
    // los de una competición concreta, no.
    if (f.kind === 'clave_invalida' || f.kind === 'sin_creditos') setOddsError(f.message);
    throw new OddsApiError(f.kind, `${sportKey}: ${f.message}`, res.status, body.slice(0, 500));
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch (e) {
    throw new OddsApiError('respuesta_invalida', `${sportKey}: la respuesta no es JSON (${(e as Error).message})`, res.status);
  }
  if (!Array.isArray(data)) {
    throw new OddsApiError('respuesta_invalida', `${sportKey}: se esperaba una lista de eventos`, res.status);
  }
  const events = data.filter(isEvent).map((e) => ({ ...e, bookmakers: e.bookmakers ?? [] }));
  setOddsError(null);

  const out: OddsResponse = {
    events,
    credits,
    fetchedAt: new Date().toISOString(),
    malformed: data.length - events.length,
  };
  // Cada respuesta real queda en el histórico de mercado (odds/snapshots.ts), sea cual
  // sea el deporte y quien la pidiera — también el sondeo del doctor. Guardarla nunca
  // puede tumbar la descarga, pero tampoco se calla.
  try {
    recordOddsResponse(sportKey, markets, out);
  } catch (e) {
    process.stderr.write(`  aviso: no se pudo guardar el snapshot de ${sportKey}: ${(e as Error).message}\n`);
  }
  return out;
}

/** El h2h de un evento: mediana por resultado entre casas, y la marca más nueva. */
export function aggregateH2H(ev: OddsEvent): {
  price: Record<string, number>;
  books: number;
  sourceUpdatedAt: string | null;
} {
  const prices: Record<string, number[]> = {};
  let newest = 0;
  let books = 0;
  for (const bk of ev.bookmakers) {
    const h2h = (bk.markets ?? []).find((m) => m.key === 'h2h');
    if (!h2h) continue;
    books++;
    for (const t of [h2h.last_update, bk.last_update]) {
      const ms = t ? Date.parse(String(t)) : NaN;
      if (Number.isFinite(ms) && ms > newest) newest = ms;
    }
    for (const o of h2h.outcomes ?? []) {
      if (typeof o.price === 'number' && o.price > 1) (prices[o.name] ??= []).push(o.price);
    }
  }
  const price: Record<string, number> = {};
  for (const [n, arr] of Object.entries(prices)) price[n] = median(arr);
  return { price, books, sourceUpdatedAt: newest > 0 ? new Date(newest).toISOString() : null };
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Lo que el doctor quiere saber de una respuesta: cuántos, con precio, qué casas. */
export function summarizeEvents(events: OddsEvent[]): {
  eventos: number;
  conPrecio: number;
  casas: string[];
  mercados: string[];
} {
  const casas = new Set<string>();
  const mercados = new Set<string>();
  let conPrecio = 0;
  for (const ev of events) {
    let tiene = false;
    for (const bk of ev.bookmakers) {
      casas.add(bk.key);
      for (const m of bk.markets ?? []) {
        mercados.add(m.key);
        if ((m.outcomes ?? []).some((o) => typeof o.price === 'number' && o.price > 1)) tiene = true;
      }
    }
    if (tiene) conPrecio++;
  }
  return { eventos: events.length, conPrecio, casas: [...casas].sort(), mercados: [...mercados].sort() };
}

// ---------------------------------------------------------------------------
// La evidencia por competición
// ---------------------------------------------------------------------------
// Cada descarga guarda, por clave, qué pasó: código, eventos, con precio y casas. Es lo
// que convierte «no hay partidos con precio» en algo diagnosticable: `soccer_epl 200 ·
// 0 eventos` y `soccer_epl 401 sin_creditos` son averías opuestas que antes se leían igual.

export interface KeyOutcome {
  key: string;
  ok: boolean;
  status: number | null;
  kind: OddsApiFailure | 'presupuesto' | null;
  eventos: number;
  conPrecio: number;
  casas: number;
  message: string | null;
  at: string;
}

export function outcomeOk(key: string, r: OddsResponse): KeyOutcome {
  const s = summarizeEvents(r.events);
  return {
    key,
    ok: true,
    status: 200,
    kind: null,
    eventos: s.eventos,
    conPrecio: s.conPrecio,
    casas: s.casas.length,
    message: r.malformed ? `${r.malformed} evento(s) con forma inválida descartados` : null,
    at: r.fetchedAt,
  };
}

export function outcomeError(key: string, e: unknown, presupuesto = false): KeyOutcome {
  const err = e as Error;
  return {
    key,
    ok: false,
    status: e instanceof OddsApiError ? e.status : null,
    kind: presupuesto ? 'presupuesto' : e instanceof OddsApiError ? e.kind : 'error_proveedor',
    eventos: 0,
    conPrecio: 0,
    casas: 0,
    message: err?.message ?? String(e),
    at: new Date().toISOString(),
  };
}

/** Una línea por clave, para el detalle que se guarda y se enseña. */
export function describeOutcomes(os: KeyOutcome[]): string {
  return os
    .map((o) =>
      o.ok
        ? `${o.key}=${o.eventos} (${o.conPrecio} con precio, ${o.casas} casas)`
        : `${o.key}=${o.kind}${o.status ? ` HTTP ${o.status}` : ''}`,
    )
    .join(', ');
}
