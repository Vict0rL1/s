/**
 * ¿Está funcionando todo? La respuesta, calculada de forma determinista a
 * partir de `sync_state` y la configuración.
 *
 * Existe para que ninguna automatización se quede parada durante días sin que
 * Victor lo sepa. Lo usan tres sitios: Ajustes → Estado del sistema (el
 * detalle), el aviso de arriba de cada vista (si algo falla) y el resumen de
 * la mañana (que lo menciona aunque no abras la app).
 *
 * Puro: recibe los datos y la hora, devuelve texto. Nada de red ni de base.
 */

export type Level = "ok" | "warn" | "error" | "off";
export type Source = "cron" | "canvas" | "gcal" | "push" | "telegram" | "ai";

export type StateRow = {
  source: string;
  last_synced_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  last_error_code: string | null;
  items_synced: number;
};

export type HealthInput = {
  now: number;
  states: Partial<Record<Source, StateRow>>;
  canvasConfigured: boolean;
  /** GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET puestos. */
  gcalConfigured?: boolean;
  /** Hay un permiso de Google guardado. */
  gcalLinked?: boolean;
  /** El servidor puede firmar avisos (llaves VAPID puestas). */
  pushConfigured: boolean;
  pushDevices: number;
  telegramConfigured: boolean;
  telegramLinked: boolean;
  aiConfigured: boolean;
};

export type IntegrationHealth = {
  key: Source;
  label: string;
  level: Level;
  /** Una frase. Lo que se ve en el aviso y en la cabecera de cada fila. */
  summary: string;
};

export type Health = { overall: Level; items: IntegrationHealth[]; alerts: IntegrationHealth[] };

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** El reloj de GitHub corre cada hora; a veces se salta una. Con 2 h ya es raro, con 6 h está parado. */
export const CRON_LATE = 2 * HOUR;
export const CRON_STOPPED = 6 * HOUR;
/** Canvas se pide cada 3 h: medio día sin un sync bueno ya es un problema. */
export const CANVAS_STALE = 12 * HOUR;
/** Cuánto tiempo se sigue mencionando una desconexión (bot bloqueado, navegadores dados de baja). */
const RECENT = 14 * DAY;

const RANK: Record<Level, number> = { off: 0, ok: 1, warn: 2, error: 3 };

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

/** "hace 5 min", "hace 3 h", "hace 2 días". */
export function ago(iso: string | null | undefined, now: number): string {
  const t = ms(iso);
  if (!Number.isFinite(t)) return "nunca";
  const d = Math.max(0, now - t);
  if (d < MIN) return "hace un momento";
  if (d < HOUR) return `hace ${Math.round(d / MIN)} min`;
  if (d < 2 * DAY) return `hace ${Math.round(d / HOUR)} h`;
  return `hace ${Math.round(d / DAY)} días`;
}

const failing = (s?: StateRow) =>
  Boolean(s?.last_error_at) && (!s?.last_success_at || ms(s.last_error_at) > ms(s.last_success_at));

/** El primer renglón del error guardado, sin la cola técnica. */
const firstLine = (s?: StateRow) => (s?.last_error ?? "").split("\n")[0].replace(/\s+/g, " ").trim();

/**
 * La próxima vez que corre el reloj después de `after`: cada hora, en el
 * minuto 7 UTC (`.github/workflows/taskflow-clock.yml`). Es aproximada:
 * GitHub suele retrasarse unos minutos.
 */
export function nextClockTick(after: number): number {
  const d = new Date(after);
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(7);
  if (d.getTime() <= after) d.setUTCHours(d.getUTCHours() + 1);
  return d.getTime();
}

/** Cuándo vuelve a preguntar el reloj a Canvas, aproximadamente. */
export function nextCanvasSync(lastSuccessAt: string | null | undefined, now: number, hours = 3): number {
  const due = Number.isFinite(ms(lastSuccessAt)) ? ms(lastSuccessAt) + hours * HOUR : now;
  return nextClockTick(Math.max(now, due) - 1);
}

export function computeHealth(h: HealthInput): Health {
  const { now, states } = h;
  const items: IntegrationHealth[] = [];

  /* ---- reloj ---- */
  const cron = states.cron;
  const needsClock = h.canvasConfigured || h.pushConfigured || h.telegramConfigured || Boolean(h.gcalLinked);
  const cronAge = now - ms(cron?.last_synced_at);
  if (!needsClock) {
    items.push({ key: "cron", label: "Reloj", level: "off", summary: "Nada que programar todavía" });
  } else if (!cron?.last_synced_at) {
    items.push({ key: "cron", label: "Reloj", level: "warn", summary: "Todavía no ha corrido nunca: sin él no hay avisos ni sync automático" });
  } else if (cronAge > CRON_STOPPED) {
    items.push({
      key: "cron", label: "Reloj", level: "error",
      summary: `No corre desde ${ago(cron.last_synced_at, now)}: los avisos y el sync de Canvas están parados`,
    });
  } else if (cronAge > CRON_LATE) {
    items.push({ key: "cron", label: "Reloj", level: "warn", summary: `Atrasado: la última vez fue ${ago(cron.last_synced_at, now)}` });
  } else if (failing(cron)) {
    items.push({ key: "cron", label: "Reloj", level: "warn", summary: `La última corrida falló: ${firstLine(cron)}` });
  } else {
    items.push({ key: "cron", label: "Reloj", level: "ok", summary: `Corrió ${ago(cron.last_synced_at, now)}` });
  }

  /* ---- Canvas ---- */
  const cv = states.canvas;
  if (!h.canvasConfigured) {
    items.push({ key: "canvas", label: "Canvas", level: "off", summary: "No configurado" });
  } else if (!cv?.last_synced_at) {
    items.push({ key: "canvas", label: "Canvas", level: "warn", summary: "Todavía no se ha sincronizado" });
  } else if (failing(cv)) {
    const viejo = !cv.last_success_at || now - ms(cv.last_success_at) > CANVAS_STALE;
    items.push({
      key: "canvas", label: "Canvas", level: viejo ? "error" : "warn",
      summary: `No sincroniza${cv.last_success_at ? ` desde ${ago(cv.last_success_at, now)}` : ""}: ${firstLine(cv)}`,
    });
  } else if (now - ms(cv.last_success_at) > CANVAS_STALE) {
    items.push({ key: "canvas", label: "Canvas", level: "warn", summary: `La última sincronización fue ${ago(cv.last_success_at, now)}` });
  } else {
    items.push({ key: "canvas", label: "Canvas", level: "ok", summary: `Sincronizado ${ago(cv.last_success_at, now)}` });
  }

  /* ---- Google Calendar ---- */
  const gc = states.gcal;
  if (!h.gcalConfigured) {
    items.push({ key: "gcal", label: "Google Calendar", level: "off", summary: "No configurado" });
  } else if (!h.gcalLinked) {
    items.push({ key: "gcal", label: "Google Calendar", level: "off", summary: "Sin conectar" });
  } else if (failing(gc)) {
    // Un permiso retirado no se arregla solo: es error desde el primer momento.
    const viejo = gc?.last_error_code === "GCAL_REVOKED" || !gc?.last_success_at || now - ms(gc.last_success_at) > CANVAS_STALE;
    items.push({
      key: "gcal", label: "Google Calendar", level: viejo ? "error" : "warn",
      summary: `No sincroniza${gc?.last_success_at ? ` desde ${ago(gc.last_success_at, now)}` : ""}: ${firstLine(gc)}`,
    });
  } else if (!gc?.last_success_at) {
    items.push({ key: "gcal", label: "Google Calendar", level: "warn", summary: "Todavía no se ha sincronizado" });
  } else if (now - ms(gc.last_success_at) > CANVAS_STALE) {
    items.push({ key: "gcal", label: "Google Calendar", level: "warn", summary: `La última sincronización fue ${ago(gc.last_success_at, now)}` });
  } else {
    items.push({ key: "gcal", label: "Google Calendar", level: "ok", summary: `Sincronizado ${ago(gc.last_success_at, now)}` });
  }

  /* ---- push ---- */
  const ps = states.push;
  const recentGone = ps?.last_error_code === "PUSH_SUBSCRIPTION_GONE" && now - ms(ps.last_error_at) < RECENT;
  if (!h.pushConfigured) {
    items.push({ key: "push", label: "Avisos push", level: "off", summary: "Faltan las llaves VAPID en el servidor" });
  } else if (!h.pushDevices) {
    items.push(
      recentGone
        ? { key: "push", label: "Avisos push", level: "warn", summary: "Tus navegadores se dieron de baja: vuelve a activar los avisos" }
        : { key: "push", label: "Avisos push", level: "off", summary: "Ningún dispositivo suscrito" },
    );
  } else if (failing(ps)) {
    items.push({ key: "push", label: "Avisos push", level: "error", summary: `El último aviso no llegó: ${firstLine(ps)}` });
  } else {
    items.push({
      key: "push", label: "Avisos push", level: "ok",
      summary: `${h.pushDevices} dispositivo${h.pushDevices > 1 ? "s" : ""}` +
        (ps?.last_success_at ? ` · último aviso ${ago(ps.last_success_at, now)}` : ""),
    });
  }

  /* ---- Telegram ---- */
  const tg = states.telegram;
  const tgDead = (tg?.last_error_code === "TELEGRAM_BOT_BLOCKED" || tg?.last_error_code === "TELEGRAM_CHAT_GONE") &&
    now - ms(tg.last_error_at) < RECENT;
  if (!h.telegramConfigured) {
    items.push({ key: "telegram", label: "Telegram", level: "off", summary: "No configurado" });
  } else if (!h.telegramLinked) {
    items.push(
      tgDead
        ? { key: "telegram", label: "Telegram", level: "warn", summary: firstLine(tg) }
        : { key: "telegram", label: "Telegram", level: "off", summary: "Sin chat conectado" },
    );
  } else if (failing(tg)) {
    items.push({ key: "telegram", label: "Telegram", level: "error", summary: `El último mensaje no llegó: ${firstLine(tg)}` });
  } else {
    items.push({
      key: "telegram", label: "Telegram", level: "ok",
      summary: tg?.last_success_at ? `Último mensaje ${ago(tg.last_success_at, now)}` : "Conectado",
    });
  }

  /* ---- Claude ---- */
  const ai = states.ai;
  if (!h.aiConfigured) {
    items.push({ key: "ai", label: "Claude", level: "off", summary: "Sin ANTHROPIC_API_KEY" });
  } else if (failing(ai)) {
    items.push({ key: "ai", label: "Claude", level: "warn", summary: `La última petición falló: ${firstLine(ai)}` });
  } else {
    items.push({
      key: "ai", label: "Claude", level: "ok",
      summary: ai?.last_success_at ? `Último uso ${ago(ai.last_success_at, now)}` : "Listo, sin usar todavía",
    });
  }

  // Claude no es una automatización: si falla, lo ves en el momento en que lo
  // usas. No merece un aviso permanente arriba de cada vista.
  const alerts = items
    .filter((i) => (i.level === "error" || i.level === "warn") && i.key !== "ai")
    .sort((a, b) => RANK[b.level] - RANK[a.level]);

  const overall = items.reduce<Level>((w, i) => (RANK[i.level] > RANK[w] ? i.level : w), "off");
  return { overall: overall === "off" ? "ok" : overall, items, alerts };
}

/**
 * El resumen de la mañana con una línea por lo que esté fallando.
 *
 * Es la forma de enterarse sin abrir la app: si Telegram falló ayer, el push
 * lo dice; si Canvas lleva medio día sin sincronizar, lo dicen los dos. Sólo
 * lo que es error de verdad, y sólo por la mañana: una vez al día basta.
 *
 * Si no había nada que avisar pero algo falla, igual sale un aviso.
 */
export function withHealthNote(
  digest: { title: string; body: string; url: string } | null,
  alerts: IntegrationHealth[],
): { title: string; body: string; url: string } | null {
  const graves = alerts.filter((a) => a.level === "error" && a.key !== "cron" && a.key !== "ai");
  if (!graves.length) return digest;
  const nota = graves.map((a) => `⚠ ${a.label}: ${a.summary}`).join("\n");
  if (!digest) return { title: "TaskFlow necesita atención", body: nota, url: "/ajustes/estado" };
  return { ...digest, body: digest.body ? `${digest.body}\n${nota}` : nota };
}
