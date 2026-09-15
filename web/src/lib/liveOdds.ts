/**
 * El canal en vivo: el servidor avisa, la pantalla se actualiza sola.
 *
 * ===========================================================================
 * POR QUÉ ESTO ES UNA ETAPA DE LATENCIA Y NO UNA COMODIDAD
 * ===========================================================================
 * Un precio puede llevar veinte minutos escrito en la base y no estar en la pantalla
 * porque nadie ha pulsado nada. Ese hueco cuenta igual que el resto: si el objetivo es
 * cinco minutos de punta a punta, un refresco manual lo hace inalcanzable por
 * definición, porque depende de que alguien mire.
 *
 * ===========================================================================
 * TRES COSAS QUE HACE, Y UNA QUE NO
 * ===========================================================================
 *   1. Escucha por SSE. El navegador reconecta solo si se cae, que es la mitad del
 *      motivo para usar SSE en vez de un WebSocket propio.
 *   2. Mide la última etapa. El servidor no puede saber cuánto tardó la red del usuario
 *      ni cuánto tardó React en pintar; sin esta medición, «de punta a punta» sería en
 *      realidad «hasta que salió de mi máquina».
 *   3. Avisa con una notificación del sistema, si se le ha dado permiso.
 *
 * Lo que NO hace es pedir permiso de notificaciones al cargar. Un permiso pedido sin
 * contexto se deniega, y una vez denegado el navegador no vuelve a preguntar — así que
 * pedirlo mal quema la única oportunidad que hay. Se pide cuando el usuario activa las
 * alertas a propósito.
 */

export interface LiveEvent {
  type: 'odds' | 'latency';
  title: string;
  body: string;
  fixtureId?: string;
  at: string;
}

// Rutas relativas, como el resto del cliente. Vite ya redirige `/api` al backend
// (ver web/vite.config.ts), así que anteponer VITE_API_BASE aquí lo enviaría dos veces
// al mismo sitio — y en la build de producción, donde no hay proxy, a ninguno.
const API = '/api';

/**
 * Cuánto tardó en llegar y pintarse, medido de verdad.
 *
 * Se usa `performance.now()` y no `Date.now()`: el segundo puede saltar si el reloj del
 * sistema se sincroniza a mitad de la medición, y una latencia negativa en un panel es
 * la clase de dato que hace desconfiar de todo el panel.
 */
export function reportClientLatency(startedAt: number, meta?: { fixtureId?: string; sport?: string }): void {
  const ms = performance.now() - startedAt;
  if (!Number.isFinite(ms) || ms < 0) return;
  // `keepalive` para que la medición sobreviva a una navegación inmediata: sin él, la
  // muestra que más interesa —la del usuario que mira y se va— es justo la que se pierde.
  void fetch(`${API}/latency/client`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ms, ...meta }),
    keepalive: true,
  }).catch(() => {
    // Medir no puede romper nada de lo que el usuario está haciendo.
  });
}

export interface LiveOptions {
  /** Se llama con cada evento. */
  onEvent: (e: LiveEvent) => void;
  /** Si mostrar una notificación del sistema además del callback. */
  notify?: boolean;
}

/**
 * Conectarse al canal. Devuelve la función para desconectarse.
 *
 * No hay reintentos a mano: `EventSource` reconecta por su cuenta con retroceso, y
 * escribir un reintento encima produce dos bucles compitiendo — que es como se acaba
 * con cuatro conexiones abiertas del mismo cliente.
 */
export function connectLiveOdds(opts: LiveOptions): () => void {
  const es = new EventSource(`${API}/latency/stream`);
  es.onmessage = (msg) => {
    let e: LiveEvent;
    try {
      e = JSON.parse(msg.data) as LiveEvent;
    } catch {
      return;
    }
    opts.onEvent(e);
    if (opts.notify) showNotification(e);
  };
  // `onerror` no se trata: EventSource ya reconecta, y cerrar aquí impediría que lo
  // hiciera. Lo único que aporta un handler es ruido en la consola.
  return () => es.close();
}

/** ¿Se pueden mostrar notificaciones ahora mismo? */
export function notificationState(): 'concedido' | 'denegado' | 'sin-pedir' | 'no-soportado' {
  if (typeof Notification === 'undefined') return 'no-soportado';
  return Notification.permission === 'granted'
    ? 'concedido'
    : Notification.permission === 'denied'
      ? 'denegado'
      : 'sin-pedir';
}

/**
 * Pedir permiso. Solo se llama desde un gesto del usuario, nunca al cargar.
 *
 * Un permiso denegado es PERMANENTE hasta que la persona lo cambie a mano en la
 * configuración del navegador, así que pedirlo en mal momento no es un intento fallido:
 * es haber gastado la única oportunidad.
 */
export async function requestNotifications(): Promise<boolean> {
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  return (await Notification.requestPermission()) === 'granted';
}

function showNotification(e: LiveEvent): void {
  if (notificationState() !== 'concedido') return;
  try {
    new Notification(e.title, {
      body: e.body,
      // La etiqueta hace que un aviso nuevo del mismo partido SUSTITUYA al anterior en
      // vez de apilarse. Sin esto, una línea que se mueve cinco veces deja cinco
      // notificaciones que dicen casi lo mismo, y la persona las silencia todas.
      tag: e.fixtureId ?? e.type,
    });
  } catch {
    // Algunos navegadores lanzan en contextos no seguros. No es motivo para romper nada.
  }
}

// ===========================================================================
// EL INFORME
// ===========================================================================
// Los tipos siguen a server/src/routes/latency.ts. Se escriben a mano y no se generan
// porque el servidor no publica un esquema; a cambio, cualquier divergencia la caza el
// typecheck del web en cuanto se usa un campo que ya no existe.

export type Stage = 'origen' | 'ingesta' | 'servidor' | 'cliente';

export interface StageReport {
  stage: Stage;
  /** Cuántas muestras. Con 0, p50 y p95 valen 0 y NO significan «rapidísimo». */
  n: number;
  p50: number;
  p95: number;
  max: number;
  label: string;
  owner: string;
  budgetMs: number;
  overBudget: boolean;
}

export interface LatencyReport {
  windowHours: number;
  target: {
    totalMs: number;
    perStage: Record<Stage, number>;
    /** Si el objetivo cabe en el plan de peticiones contratado. */
    feasible: { ok: boolean; bestPossibleMs: number | null; reason: string };
  };
  stages: StageReport[];
  total: { p95Ms: number; complete: boolean; missing: Stage[] };
  alert: {
    breached: boolean;
    complete: boolean;
    totalMs: number;
    targetMs: number;
    offenders: { stage: Stage; p95: number; budget: number; overBy: number; owner: string }[];
    message: string;
  };
  transport: { kind: 'websocket' | 'sondeo'; note: string };
  schedule: {
    cycleMinutes: number;
    fixtures: {
      fixtureId: string;
      sport: string;
      commenceTime: string;
      minutesToStart: number;
      recentMoves: number;
      weight: number;
      reason: string;
    }[];
    deferred: number;
    explanation: string;
  } | null;
  push: { subscribers: number; recent: LiveEvent[] };
}

export async function fetchLatency(hours = 24): Promise<LatencyReport> {
  const res = await fetch(`${API}/latency?hours=${hours}`);
  if (!res.ok) throw new Error(`/api/latency respondió ${res.status}`);
  return (await res.json()) as LatencyReport;
}
