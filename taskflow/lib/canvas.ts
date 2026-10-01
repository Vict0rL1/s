/**
 * Mapeo de Canvas a `tasks`.
 *
 * Todo aquí es puro: recibe la respuesta de Canvas y devuelve filas. Así el
 * test de idempotencia que pide CLAUDE.md corre sin tocar la base, y el route
 * handler se queda con lo único que no se puede probar en frío: la red.
 *
 * La regla dura del proyecto vive en `planSync` y `updatePatch`: si una fila
 * tiene `user_edited_at`, el sync sólo puede refrescar título y fecha. Nunca
 * `done`, `priority`, `area` ni `est_minutes`. Una app que desmarca tareas
 * hechas se deja de usar.
 */

import { addDays, minsToTime, norm, zonedDayMinute } from "./date";
import { type ErrorCode, IntegrationError } from "./log";
import type { ItemSource, TaskKind } from "./types";

/** Los únicos tipos que son un deadline de verdad. */
export const PLANNABLE_TYPES = ["assignment", "quiz", "discussion_topic"] as const;
export type PlannableType = (typeof PLANNABLE_TYPES)[number];

export type CanvasCourse = {
  /** Canvas manda número o texto según el header Accept. Ver `courseKey`. */
  id: number | string;
  name?: string | null;
  course_code?: string | null;
};

export type CanvasPlannerItem = {
  course_id?: number | string | null;
  plannable_id?: number | string | null;
  plannable_type?: string | null;
  plannable_date?: string | null;
  plannable?: { title?: string | null; name?: string | null } | null;
  /** Canvas manda `false` cuando el tipo no admite entregas. */
  submissions?: { submitted?: boolean } | false | null;
  html_url?: string | null;
};

/** Una tarea de Canvas ya traducida, lista para insertar o actualizar. */
export type CanvasTask = {
  externalId: string;
  title: string;
  area: string | null;
  dueDate: string | null;
  dueTime: string | null;
  /** Nombre del curso. Va al cuerpo, que es contexto y no clasificación. */
  body: string | null;
  externalUrl: string | null;
  /** Deducido del tipo de Canvas y del título. */
  kind: TaskKind;
  /** "ECON 342". */
  course: string | null;
};

/* --------------------------------------------------------------- paginación */

/**
 * Siguiente página según el header `Link` de Canvas, o null si era la última.
 * Formato: `<https://…&page=2>; rel="next", <…>; rel="last"`.
 */
export function nextPageUrl(linkHeader: string | null | undefined): string | null {
  if (!linkHeader) return null;
  for (const part of String(linkHeader).split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel\s*=\s*"?next"?/i);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * Clave para cruzar `course_id` con la lista de cursos.
 *
 * Con el header `application/json+canvas-string-ids` los IDs llegan como texto,
 * y sin él como número. Normalizar a texto de los dos lados evita que el cruce
 * falle en silencio y deje todas las tareas sin curso ni área.
 */
const courseKey = (id: number | string | null | undefined) => (id == null ? null : String(id));

/* --------------------------------------------------------------- red */

/** Tope de páginas, por si el header Link apunta en círculo. */
const MAX_PAGES = 20;

type Fetched = { items: unknown[]; linkHeader: string | null };

/**
 * Un fallo de Canvas con código estable (`CANVAS_TOKEN_EXPIRED`, …) para que
 * Ajustes y los logs digan QUÉ pasó, no sólo que algo falló.
 */
export class CanvasError extends IntegrationError {
  constructor(
    code: ErrorCode,
    message: string,
    retryable: boolean,
    /** Cuánto pidió Canvas que esperáramos, si lo dijo. */
    readonly waitMs?: number,
  ) {
    super(code, message, retryable);
    this.name = "CanvasError";
  }
}

export type CanvasGetOptions = {
  /** Cuánto esperar a Canvas antes de rendirse. */
  timeoutMs?: number;
  /** Reintentos ante fallos pasajeros (límite de peticiones, 5xx, red). */
  retries?: number;
  /** Espera antes de reintentar, si Canvas no dice cuánto. */
  backoffMs?: number;
};

/**
 * Sin timeout, un Canvas colgado retenía al reloj hasta que Vercel mataba la
 * función, y con ella el aviso de esa hora: la reserva en `digest_log` quedaba
 * puesta y el aviso no salía nunca, sin un solo error en ningún lado.
 */
const DEFAULTS: Required<CanvasGetOptions> = { timeoutMs: 15_000, retries: 1, backoffMs: 1_500 };

/** Nunca esperar más que esto por un Retry-After: la función tiene un límite de tiempo. */
const MAX_WAIT_MS = 5_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryAfterMs(res: Response): number | undefined {
  const s = Number(res.headers.get("retry-after"));
  return Number.isFinite(s) && s > 0 ? Math.min(MAX_WAIT_MS, s * 1000) : undefined;
}

async function canvasGetOnce(url: string, token: string, timeoutMs: number): Promise<Fetched> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json+canvas-string-ids" },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // El error original no se propaga: su texto podría traer la URL o la
    // cabecera, y no aporta nada que el código no diga ya.
    const name = e instanceof Error ? e.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new CanvasError("CANVAS_TIMEOUT", `Canvas no respondió en ${Math.round(timeoutMs / 1000)} s.`, true);
    }
    throw new CanvasError("CANVAS_NETWORK", "No se pudo conectar con Canvas.", true);
  }

  if (res.status === 401) {
    throw new CanvasError(
      "CANVAS_TOKEN_EXPIRED",
      "Canvas rechazó el token (401): venció o lo revocaron. Genera uno nuevo en Canvas → Account → Settings y actualiza CANVAS_TOKEN.",
      false,
    );
  }

  // Canvas no usa 429 para el límite de peticiones: responde 403 con
  // "Rate Limit Exceeded". Tratarlo como token malo mandaba a Victor a
  // regenerar un token que funcionaba perfectamente.
  if (res.status === 403 || res.status === 429) {
    const text = await res.text().catch(() => "");
    const remaining = res.headers.get("x-rate-limit-remaining");
    const throttled =
      res.status === 429 || /rate limit exceeded/i.test(text) || (remaining != null && Number(remaining) <= 0);
    if (throttled) {
      throw new CanvasError(
        "CANVAS_RATE_LIMITED",
        "Canvas pidió bajar el ritmo (límite de peticiones). Se vuelve a intentar solo en la próxima hora.",
        true,
        retryAfterMs(res),
      );
    }
    throw new CanvasError(
      "CANVAS_FORBIDDEN",
      "Canvas negó el acceso (403): el token no tiene permiso para leer tus tareas.",
      false,
    );
  }

  if (res.status >= 500) {
    throw new CanvasError("CANVAS_UNAVAILABLE", `Canvas está con problemas (${res.status}).`, true, retryAfterMs(res));
  }
  if (!res.ok) {
    throw new CanvasError("CANVAS_BAD_RESPONSE", `Canvas respondió ${res.status} en ${new URL(url).pathname}.`, false);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    // Una página de mantenimiento en HTML con un 200, por ejemplo.
    throw new CanvasError("CANVAS_BAD_RESPONSE", "Canvas respondió algo que no es JSON.", true);
  }
  // Antes, cualquier cosa que no fuera una lista se tomaba como "no hay nada".
  // Una respuesta rara no es una respuesta vacía.
  if (!Array.isArray(body)) {
    throw new CanvasError("CANVAS_BAD_RESPONSE", "Canvas respondió con un formato inesperado.", false);
  }

  return { items: body, linkHeader: res.headers.get("link") };
}

export async function canvasGet(url: string, token: string, opts: CanvasGetOptions = {}): Promise<Fetched> {
  const o = { ...DEFAULTS, ...opts };
  for (let intento = 0; ; intento++) {
    try {
      return await canvasGetOnce(url, token, o.timeoutMs);
    } catch (e) {
      const err = e as CanvasError;
      if (!err.retryable || intento >= o.retries) throw err;
      await sleep(err.waitMs ?? o.backoffMs);
    }
  }
}

/**
 * Recorre todas las páginas siguiendo el `rel="next"` del header Link.
 *
 * `complete` dice si se llegó de verdad a la última página. Si el tope de
 * páginas cortó antes, la lista está incompleta y nadie debería concluir de
 * ella que algo "ya no está en Canvas".
 */
export async function canvasGetAll(
  firstUrl: string,
  token: string,
  opts: CanvasGetOptions = {},
): Promise<{ items: unknown[]; complete: boolean }> {
  const out: unknown[] = [];
  let url: string | null = firstUrl;
  const visited = new Set<string>();

  for (let page = 0; url && page < MAX_PAGES; page++) {
    if (visited.has(url)) return { items: out, complete: false };
    visited.add(url);

    const { items, linkHeader }: Fetched = await canvasGet(url, token, opts);
    out.push(...items);
    url = nextPageUrl(linkHeader);
  }

  return { items: out, complete: url == null };
}

/* --------------------------------------------------------------- cadencia */

/** Cada cuánto tiene sentido volver a preguntarle a Canvas. */
export const HOURS_BETWEEN_SYNCS = 3;

/**
 * ¿Toca sincronizar? Cuenta desde el último sync que SALIÓ BIEN, no desde el
 * último intento. Antes contaba desde el intento, así que un fallo dejaba a
 * Canvas tres horas sin reintentar — y con el token vencido, eso era siempre.
 */
export function canvasSyncDue(lastSuccessAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!lastSuccessAt) return true;
  const t = Date.parse(lastSuccessAt);
  return !Number.isFinite(t) || now - t >= HOURS_BETWEEN_SYNCS * 3600_000;
}

/* ------------------------------------------------------------------- mapeo */

const isPlannableType = (t: unknown): t is PlannableType =>
  typeof t === "string" && (PLANNABLE_TYPES as readonly string[]).includes(t);

/** ¿Ya lo entregó? Entonces no es pendiente y no entra. */
function alreadySubmitted(item: CanvasPlannerItem): boolean {
  const s = item.submissions;
  return typeof s === "object" && s !== null && s.submitted === true;
}

/**
 * Área para un curso. Si alguna del perfil coincide con el nombre o el código
 * del curso, gana esa; si no, la de respaldo (normalmente "SFU", porque todo
 * lo que llega de Canvas es de la universidad).
 */
export function areaForCourse(
  course: CanvasCourse | undefined,
  areas: string[],
  fallback: string | null,
): string | null {
  if (!course) return fallback;
  const haystack = norm([course.name, course.course_code].filter(Boolean).join(" "));
  if (haystack) {
    const hit = areas.find((a) => {
      const n = norm(a);
      return n.length > 1 && haystack.includes(n);
    });
    if (hit) return hit;
  }
  return fallback;
}

/** El área de respaldo: la del perfil que se parezca a "SFU", o la primera. */
export function defaultArea(areas: string[]): string | null {
  return areas.find((a) => norm(a) === "sfu") ?? areas[0] ?? null;
}

/**
 * Qué tipo de entrega es, con reglas fijas sobre lo que Canvas sí dice: el
 * tipo de ítem y el título. Nada se adivina más allá de eso, y se corrige a
 * mano (el sync respeta la corrección).
 *
 * El orden importa: "Final project" es un proyecto, no un final; un quiz que
 * se llama "Midterm 1" es un midterm.
 */
export function classifyKind(type: string | null | undefined, title: string): TaskKind {
  const t = norm(title);
  if (/\b(project|proyecto|term paper|capstone)\b/.test(t)) return "project";
  if (/\b(presentation|presentacion|pitch)\b/.test(t)) return "presentation";
  if (/\b(midterm|mid-term|parcial)\b/.test(t)) return "midterm";
  if (/\b(final exam|examen final)\b/.test(t) || (type === "quiz" && /\bfinal\b/.test(t))) return "final";
  if (type === "quiz" || /\bquiz\b/.test(t)) return "quiz";
  if (/\b(reading|readings|lectura)\b/.test(t)) return "reading";
  if (type === "discussion_topic") return "other";
  return "assignment";
}

/**
 * La etiqueta corta del curso: "ECON 342 D100" → "ECON 342". Si el nombre no
 * tiene esa forma, el código del curso, y si no, el nombre recortado.
 */
export function shortCourse(course: CanvasCourse | undefined): string | null {
  if (!course) return null;
  for (const raw of [course.name, course.course_code]) {
    const m = String(raw ?? "").toUpperCase().match(/^([A-Z]{2,5})\s?(\d{3}[A-Z]?)\b/);
    if (m) return `${m[1]} ${m[2]}`;
  }
  const fallback = (course.course_code || course.name || "").trim();
  return fallback ? fallback.slice(0, 40) : null;
}

export type MapOptions = {
  /** Áreas del perfil, para clasificar los cursos. */
  areas: string[];
  /** Zona del perfil: las fechas de Canvas vienen en UTC. */
  timeZone: string;
  /** Para volver absolutos los `html_url` relativos que manda Canvas. */
  baseUrl?: string;
};

/** Convierte la respuesta cruda de `/planner/items` en filas de `tasks`. */
export function mapPlannerItems(
  items: CanvasPlannerItem[],
  courses: CanvasCourse[],
  opts: MapOptions,
): CanvasTask[] {
  const byId = new Map<string, CanvasCourse>();
  for (const c of courses ?? []) {
    const key = courseKey(c.id);
    if (key) byId.set(key, c);
  }

  const fallback = defaultArea(opts.areas);
  const origin = originOf(opts.baseUrl);

  const out: CanvasTask[] = [];
  const seen = new Set<string>();

  for (const item of items ?? []) {
    if (!isPlannableType(item.plannable_type)) continue;
    if (alreadySubmitted(item)) continue;
    if (item.plannable_id == null) continue;

    const title = (item.plannable?.title ?? item.plannable?.name ?? "").trim();
    if (!title) continue;

    // Dos entradas del planner para el mismo plannable colapsan en una fila,
    // que es justo lo que evita los duplicados al sincronizar.
    const externalId = `canvas:${item.plannable_type}:${item.plannable_id}`;
    if (seen.has(externalId)) continue;
    seen.add(externalId);

    let dueDate: string | null = null;
    let dueTime: string | null = null;
    if (item.plannable_date) {
      const when = new Date(item.plannable_date);
      if (!Number.isNaN(when.getTime())) {
        const local = zonedDayMinute(when.toISOString(), opts.timeZone);
        dueDate = local.date;
        dueTime = minsToTime(local.min);
      }
    }

    const key = courseKey(item.course_id);
    const course = key ? byId.get(key) : undefined;

    out.push({
      externalId,
      title: title.slice(0, 200),
      area: areaForCourse(course, opts.areas, fallback),
      dueDate,
      dueTime,
      body: course?.name?.trim() || null,
      externalUrl: absoluteUrl(item.html_url, origin),
      kind: classifyKind(item.plannable_type, title),
      course: shortCourse(course),
    });
  }

  // Orden estable: dos corridas sobre la misma respuesta producen la misma lista.
  return out.sort((a, b) => a.externalId.localeCompare(b.externalId));
}

function originOf(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
}

function absoluteUrl(href: string | null | undefined, origin: string | null): string | null {
  if (!href) return null;
  if (/^https?:\/\//i.test(href)) return href;
  return origin ? origin + (href.startsWith("/") ? href : "/" + href) : href;
}

/* ------------------------------------------------- filas para la base */

export type TaskInsert = {
  user_id: string;
  title: string;
  area: string | null;
  due_date: string | null;
  due_time: string | null;
  body: string | null;
  source: ItemSource;
  external_id: string;
  external_url: string | null;
  kind: TaskKind;
  course: string | null;
};

/** Sólo lo que el sync tiene permitido refrescar. */
export type TaskPatch = {
  title: string;
  due_date: string | null;
  due_time: string | null;
  area?: string | null;
  body?: string | null;
  external_url?: string | null;
  kind?: TaskKind;
  course?: string | null;
};

export function insertRow(task: CanvasTask, userId: string): TaskInsert {
  return {
    user_id: userId,
    title: task.title,
    area: task.area,
    due_date: task.dueDate,
    due_time: task.dueTime,
    body: task.body,
    source: "canvas",
    external_id: task.externalId,
    external_url: task.externalUrl,
    kind: task.kind,
    course: task.course,
  };
  // Ojo con lo que NO va aquí: `done`, `priority` y `est_minutes` se quedan con
  // el default del esquema, y `user_edited_at` en null — la fila es del sync
  // hasta que Victor la toque.
}

/**
 * Qué puede escribir el sync sobre una fila que ya existe.
 *
 * `protectManual` es el interruptor de la regla dura: con una fila que tiene
 * `user_edited_at`, sólo salen título y fecha.
 */
export function updatePatch(task: CanvasTask, protectManual: boolean): TaskPatch {
  const base: TaskPatch = {
    title: task.title,
    due_date: task.dueDate,
    due_time: task.dueTime,
  };
  if (protectManual) return base;
  return { ...base, area: task.area, body: task.body, external_url: task.externalUrl, kind: task.kind, course: task.course };
}

/**
 * Fila para una tarea que Victor ya tocó: las claves del conflicto más lo
 * único que el sync puede refrescar. Va por `upsert`, así que lo que no está
 * en el objeto es exactamente lo que Postgres deja intacto.
 */
export function safeUpsertRow(task: CanvasTask, userId: string) {
  return {
    user_id: userId,
    source: "canvas" as ItemSource,
    external_id: task.externalId,
    ...updatePatch(task, true),
  };
}

/* ------------------------------------------------------- plan del sync */

export type ExistingRow = {
  external_id: string;
  user_edited_at: string | null;
  done?: boolean;
  deleted_at?: string | null;
  due_date?: string | null;
  title?: string;
  due_time?: string | null;
};

/** Un cambio de verdad en título o fecha, para contarlo en Actividad. */
export type SyncChange = {
  externalId: string;
  /** La fila tenía una edición manual y se respetó (sólo cambió título/fecha). */
  protected: boolean;
  before: { title: string; due_date: string | null; due_time: string | null };
  after: { title: string; due_date: string | null; due_time: string | null };
};

export type SyncPlan = {
  /** Deadlines que todavía no existen. */
  insert: CanvasTask[];
  /** Filas del sync: se refrescan enteras. */
  updateAll: CanvasTask[];
  /** Filas que Victor tocó: sólo título y fecha. */
  updateSafe: CanvasTask[];
  /** Entregadas en Canvas, pendientes aquí y que nadie tocó: se marcan hechas. */
  complete: string[];
  /** Pendientes que Canvas ya no devuelve: van a la papelera. */
  vanished: string[];
  /** Si iban a desaparecer demasiadas de golpe y se frenó, cuántas eran. */
  vanishedHeld: number;
  /** De lo que se actualizó, lo que de verdad cambió de título o fecha. */
  changes: SyncChange[];
};

export type PlanOptions = {
  /** `external_id` de lo que Canvas dice que ya entregaste. */
  submitted?: Iterable<string>;
  /**
   * ¿Llegó la lista de cursos? Sin ella, el área y el curso saldrían en
   * blanco: las filas existentes sólo reciben título y fecha esa vez.
   */
  coursesOk?: boolean;
  /** La ventana que se le pidió a Canvas, y si la respuesta llegó entera. */
  window?: { start: string; end: string; complete: boolean };
};

/**
 * Más de esto desapareciendo de una vez, y además más de la mitad de lo que
 * había, huele a respuesta rota de Canvas y no a un profesor borrando tareas.
 */
const MAX_VANISH_AT_ONCE = 5;

/**
 * Reparte los deadlines entrantes contra lo que ya está en la base.
 *
 * Correr esto dos veces sobre la misma respuesta deja exactamente las mismas
 * filas: la segunda vez no hay nada que insertar y los updates son idénticos.
 *
 * Lo que una fila editada a mano NUNCA recibe: ni el área, ni que la marquen
 * hecha, ni que la manden a la papelera. Sólo título y fecha (CLAUDE.md).
 */
export function planSync(incoming: CanvasTask[], existing: ExistingRow[], opts: PlanOptions = {}): SyncPlan {
  const known = new Map<string, ExistingRow>();
  for (const row of existing) known.set(row.external_id, row);
  const coursesOk = opts.coursesOk ?? true;

  const plan: SyncPlan = {
    insert: [], updateAll: [], updateSafe: [], complete: [], vanished: [], vanishedHeld: 0, changes: [],
  };
  const seen = new Set<string>();

  for (const task of incoming) {
    seen.add(task.externalId);
    const row = known.get(task.externalId);
    if (!row) plan.insert.push(task);
    // La borraste tú: se queda borrada. Ni se recrea ni se actualiza.
    else if (row.deleted_at) continue;
    else {
      if (row.user_edited_at || !coursesOk) plan.updateSafe.push(task);
      else plan.updateAll.push(task);
      if (
        row.title !== undefined &&
        (row.title !== task.title || (row.due_date ?? null) !== task.dueDate || (row.due_time ?? null) !== task.dueTime)
      ) {
        plan.changes.push({
          externalId: task.externalId,
          protected: Boolean(row.user_edited_at),
          before: { title: row.title, due_date: row.due_date ?? null, due_time: row.due_time ?? null },
          after: { title: task.title, due_date: task.dueDate, due_time: task.dueTime },
        });
      }
    }
  }

  // Antes, lo entregado simplemente dejaba de llegar y la fila se quedaba
  // pendiente para siempre: salía en rojo como atrasada y en el aviso de la
  // mañana. Ahora Canvas la da por hecha — si nadie la tocó.
  for (const id of opts.submitted ?? []) {
    seen.add(id);
    const row = known.get(id);
    if (row && !row.deleted_at && !row.user_edited_at && row.done === false) plan.complete.push(id);
  }
  plan.complete.sort();

  // Lo que desapareció de Canvas (el profesor lo borró o lo despublicó) se va a
  // la papelera, de donde se puede sacar. Sólo con una respuesta completa y no
  // vacía, y sólo para fechas bien adentro de la ventana pedida: lo que se
  // salió por el borde no desapareció, simplemente ya no se pregunta por ello.
  const w = opts.window;
  if (w?.complete && seen.size > 0) {
    const lo = addDays(w.start, 1);
    const hi = addDays(w.end, -1);
    const candidates = existing.filter(
      (r) => !r.deleted_at && !r.user_edited_at && r.done === false && r.due_date && r.due_date > lo && r.due_date < hi,
    );
    const gone = candidates.filter((r) => !seen.has(r.external_id)).map((r) => r.external_id).sort();
    if (gone.length > MAX_VANISH_AT_ONCE && gone.length * 2 > candidates.length) plan.vanishedHeld = gone.length;
    else plan.vanished = gone;
  }

  return plan;
}

/** `external_id` de lo que Canvas marca como entregado. */
export function submittedIds(items: CanvasPlannerItem[]): string[] {
  const out = new Set<string>();
  for (const item of items ?? []) {
    if (!isPlannableType(item.plannable_type) || item.plannable_id == null) continue;
    if (alreadySubmitted(item)) out.add(`canvas:${item.plannable_type}:${item.plannable_id}`);
  }
  return [...out].sort();
}
