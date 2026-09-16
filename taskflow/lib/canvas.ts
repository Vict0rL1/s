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

import { minsToTime, norm, zonedDayMinute } from "./date";
import type { ItemSource } from "./types";

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

export async function canvasGet(url: string, token: string): Promise<Fetched> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json+canvas-string-ids" },
    cache: "no-store",
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error("Canvas rechazó el token (401/403). Genera uno nuevo y actualiza CANVAS_TOKEN.");
  }
  if (!res.ok) {
    throw new Error(`Canvas respondió ${res.status} en ${new URL(url).pathname}`);
  }

  const body = await res.json();
  return {
    items: Array.isArray(body) ? body : [],
    linkHeader: res.headers.get("link"),
  };
}

/** Recorre todas las páginas siguiendo el `rel="next"` del header Link. */
export async function canvasGetAll(firstUrl: string, token: string): Promise<unknown[]> {
  const out: unknown[] = [];
  let url: string | null = firstUrl;
  const visited = new Set<string>();

  for (let page = 0; url && page < MAX_PAGES; page++) {
    if (visited.has(url)) break;
    visited.add(url);

    const { items, linkHeader }: Fetched = await canvasGet(url, token);
    out.push(...items);
    url = nextPageUrl(linkHeader);
  }

  return out;
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
};

/** Sólo lo que el sync tiene permitido refrescar. */
export type TaskPatch = {
  title: string;
  due_date: string | null;
  due_time: string | null;
  area?: string | null;
  body?: string | null;
  external_url?: string | null;
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
  return { ...base, area: task.area, body: task.body, external_url: task.externalUrl };
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

export type ExistingRow = { external_id: string; user_edited_at: string | null };

export type SyncPlan = {
  /** Deadlines que todavía no existen. */
  insert: CanvasTask[];
  /** Filas del sync: se refrescan enteras. */
  updateAll: CanvasTask[];
  /** Filas que Victor tocó: sólo título y fecha. */
  updateSafe: CanvasTask[];
};

/**
 * Reparte los deadlines entrantes contra lo que ya está en la base.
 *
 * Correr esto dos veces sobre la misma respuesta deja exactamente las mismas
 * filas: la segunda vez no hay nada que insertar y los updates son idénticos.
 */
export function planSync(incoming: CanvasTask[], existing: ExistingRow[]): SyncPlan {
  const known = new Map<string, ExistingRow>();
  for (const row of existing) known.set(row.external_id, row);

  const plan: SyncPlan = { insert: [], updateAll: [], updateSafe: [] };

  for (const task of incoming) {
    const row = known.get(task.externalId);
    if (!row) plan.insert.push(task);
    else if (row.user_edited_at) plan.updateSafe.push(task);
    else plan.updateAll.push(task);
  }

  return plan;
}
