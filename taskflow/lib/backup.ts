import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Ctx } from "./data";

/**
 * Respaldo: el JSON que baja "Descargar todo" y lo que vuelve a entrar con
 * "Importar respaldo".
 *
 * Importar es **no destructivo**: sólo agrega lo que no tienes. Nunca cambia
 * ni borra una fila existente, ni siquiera si el respaldo trae una versión
 * distinta de la misma tarea. Primero se muestra un resumen; nada se escribe
 * hasta confirmar.
 *
 * Formato: el mismo de siempre más `schemaVersion: 2`. Un respaldo viejo (sin
 * `schemaVersion`) se lee igual; las columnas nuevas quedan en su valor por
 * defecto.
 */

export const SCHEMA_VERSION = 2;

/** Cuántas filas por tabla como máximo: un archivo absurdo no tumba el servidor. */
const MAX_ROWS = 20_000;

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const hms = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/);
const iso = z.string().min(10).max(40);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const opt = <T extends z.ZodTypeAny>(t: T) => t.nullish().transform((v) => v ?? null);

const TaskIn = z.object({
  id: uuid.optional(),
  title: z.string().trim().min(1).max(500),
  area: opt(z.string().max(80)),
  due_date: opt(ymd),
  due_time: opt(hms),
  est_minutes: opt(z.number().int().min(1).max(1440)),
  priority: z.number().int().min(1).max(3).catch(3).default(3),
  done: z.boolean().catch(false).default(false),
  done_at: opt(iso),
  body: opt(z.string().max(10_000)),
  source: z.enum(["manual", "canvas", "gcal", "ics"]).catch("manual").default("manual"),
  external_id: opt(z.string().max(300)),
  external_url: opt(z.string().max(1000)),
  focus_day: opt(ymd),
  user_edited_at: opt(iso),
  deleted_at: opt(iso),
  kind: opt(z.enum(["assignment", "quiz", "midterm", "final", "project", "presentation", "reading", "other"])),
  course: opt(z.string().max(80)),
  weight_pct: opt(z.number().min(0).max(100)),
  difficulty: opt(z.number().int().min(1).max(3)),
  tracked_sec: z.number().int().min(0).catch(0).default(0),
  track_sessions: z.number().int().min(0).catch(0).default(0),
  // Sin fecha, mejor no mandar nada: un null explícito pisa el default de la base.
  created_at: iso.optional(),
});

const NoteIn = z.object({
  id: uuid.optional(),
  body: z.string().trim().min(1).max(20_000),
  pinned: z.boolean().catch(false).default(false),
  deleted_at: opt(iso),
  // Sin fecha, mejor no mandar nada: un null explícito pisa el default de la base.
  created_at: iso.optional(),
});

const HabitIn = z.object({
  id: uuid.optional(),
  name: z.string().trim().min(1).max(80),
  days: z.array(z.number().int().min(0).max(6)).max(7).catch([0, 1, 2, 3, 4, 5, 6]).default([0, 1, 2, 3, 4, 5, 6]),
  archived: z.boolean().catch(false).default(false),
  sort_order: z.number().int().catch(0).default(0),
  show_streak: z.boolean().catch(true).default(true),
  active_from: opt(ymd),
  // Sin fecha, mejor no mandar nada: un null explícito pisa el default de la base.
  created_at: iso.optional(),
});

const HabitLogIn = z.object({ habit_id: uuid, day: ymd });

const EventIn = z
  .object({
    id: uuid.optional(),
    title: z.string().trim().min(1).max(500),
    starts_at: opt(iso),
    ends_at: opt(iso),
    all_day_date: opt(ymd),
    location: opt(z.string().max(300)),
    course_ref: opt(z.string().max(120)),
    source: z.enum(["canvas", "gcal", "ics"]),
    external_id: z.string().min(1).max(300),
  })
  .refine((e) => Boolean(e.starts_at) !== Boolean(e.all_day_date), "con hora o de día completo, no las dos")
  .refine((e) => !e.ends_at || !e.starts_at || e.ends_at >= e.starts_at, "termina antes de empezar");

const BlockIn = z
  .object({
    id: uuid.optional(),
    day: ymd,
    start_min: z.number().int().min(0).max(1439),
    end_min: z.number().int().min(1).max(1440),
    title: z.string().trim().min(1).max(200),
    kind: z.enum(["tarea", "descanso", "clase"]).catch("tarea").default("tarea"),
    task_id: opt(uuid),
  })
  .refine((b) => b.end_min > b.start_min, "termina antes de empezar");

type TaskIn = z.infer<typeof TaskIn>;
type NoteIn = z.infer<typeof NoteIn>;
type HabitIn = z.infer<typeof HabitIn>;
type HabitLogIn = z.infer<typeof HabitLogIn>;
type EventIn = z.infer<typeof EventIn>;
type BlockIn = z.infer<typeof BlockIn>;

export type TableCount = { total: number; new: number; duplicates: number; invalid: number };
export type BackupSummary = {
  version: 1 | 2;
  exportedAt: string | null;
  tasks: TableCount;
  notes: TableCount;
  habits: TableCount;
  habit_log: TableCount;
  events: TableCount;
  blocks: TableCount;
};

export class BackupError extends Error {}

/** Valida fila por fila: una fila mala se cuenta y se salta, no tumba el archivo. */
function rows<T>(raw: unknown, schema: z.ZodType<T>): { ok: T[]; invalid: number } {
  if (raw == null) return { ok: [], invalid: 0 };
  if (!Array.isArray(raw)) throw new BackupError("El respaldo tiene una tabla que no es una lista.");
  if (raw.length > MAX_ROWS) throw new BackupError(`El respaldo trae más de ${MAX_ROWS} filas en una tabla.`);
  const ok: T[] = [];
  let invalid = 0;
  for (const r of raw) {
    const p = schema.safeParse(r);
    if (p.success) ok.push(p.data);
    else invalid++;
  }
  return { ok, invalid };
}

export type ParsedBackup = {
  version: 1 | 2;
  exportedAt: string | null;
  tasks: { ok: TaskIn[]; invalid: number };
  notes: { ok: NoteIn[]; invalid: number };
  habits: { ok: HabitIn[]; invalid: number };
  habit_log: { ok: HabitLogIn[]; invalid: number };
  events: { ok: EventIn[]; invalid: number };
  blocks: { ok: BlockIn[]; invalid: number };
};

export function parseBackup(json: unknown): ParsedBackup {
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new BackupError("Eso no es un respaldo de TaskFlow.");
  const o = json as Record<string, unknown>;
  const v = o.schemaVersion;
  if (v != null && v !== 1 && v !== 2) {
    throw new BackupError("Este respaldo es de una versión más nueva de TaskFlow. Actualiza la app antes de importarlo.");
  }
  const tablas = ["tasks", "notes", "habits", "habit_log", "events", "blocks"];
  if (!tablas.some((t) => Array.isArray(o[t]))) throw new BackupError("Eso no es un respaldo de TaskFlow: no trae ninguna tabla.");

  return {
    version: v === 2 ? 2 : 1,
    exportedAt: typeof o.exportado_en === "string" ? o.exportado_en : null,
    tasks: rows(o.tasks, TaskIn),
    notes: rows(o.notes, NoteIn),
    habits: rows(o.habits, HabitIn),
    habit_log: rows(o.habit_log, HabitLogIn),
    events: rows(o.events, EventIn),
    blocks: rows(o.blocks, BlockIn),
  };
}

/* ------------------------------------------------------ qué es nuevo */

type Plan = {
  tasks: TaskIn[];
  notes: NoteIn[];
  habits: HabitIn[];
  habit_log: HabitLogIn[];
  events: EventIn[];
  blocks: BlockIn[];
  /** id del respaldo → id en tu cuenta, para tareas y rutinas que ya tenías. */
  taskMap: Map<string, string>;
  habitMap: Map<string, string>;
  summary: BackupSummary;
};

const k = (...xs: unknown[]) => xs.map((x) => String(x ?? "")).join("|");

/**
 * Compara el respaldo con lo que ya tienes. Duplicado es: el mismo id, la
 * misma clave externa (Canvas, .ics), o — para lo que no tiene ninguna de las
 * dos — el mismo título y fecha (tareas), el mismo texto (notas), el mismo
 * nombre (rutinas).
 */
export async function planImport(ctx: Pick<Ctx, "supabase" | "userId">, b: ParsedBackup): Promise<Plan> {
  const [t, n, h, hl, e, bl] = await Promise.all([
    ctx.supabase.from("tasks").select("id, title, due_date, source, external_id").eq("user_id", ctx.userId)
      .returns<{ id: string; title: string; due_date: string | null; source: string; external_id: string | null }[]>(),
    ctx.supabase.from("notes").select("id, body").eq("user_id", ctx.userId).returns<{ id: string; body: string }[]>(),
    ctx.supabase.from("habits").select("id, name").eq("user_id", ctx.userId).returns<{ id: string; name: string }[]>(),
    ctx.supabase.from("habit_log").select("habit_id, day").eq("user_id", ctx.userId).returns<{ habit_id: string; day: string }[]>(),
    ctx.supabase.from("events").select("source, external_id").eq("user_id", ctx.userId).returns<{ source: string; external_id: string }[]>(),
    ctx.supabase.from("blocks").select("id, day, start_min, end_min, title").eq("user_id", ctx.userId)
      .returns<{ id: string; day: string; start_min: number; end_min: number; title: string }[]>(),
  ]);
  for (const r of [t, n, h, hl, e, bl]) {
    if (r.error) throw new BackupError("No se pudo leer lo que ya tienes: " + r.error.message);
  }

  /* tareas */
  const taskIds = new Set(t.data!.map((x) => x.id));
  const taskExt = new Map(t.data!.filter((x) => x.external_id).map((x) => [k(x.source, x.external_id), x.id]));
  const taskManual = new Map(t.data!.map((x) => [k(x.title, x.due_date), x.id]));
  const taskMap = new Map<string, string>();
  const tasks: TaskIn[] = [];
  const vistos = new Set<string>();
  for (const r of b.tasks.ok) {
    const existente =
      (r.id && taskIds.has(r.id) ? r.id : undefined) ??
      (r.external_id ? taskExt.get(k(r.source, r.external_id)) : undefined) ??
      (!r.external_id ? taskManual.get(k(r.title, r.due_date)) : undefined);
    const clave = r.external_id ? k(r.source, r.external_id) : k(r.title, r.due_date);
    if (existente) {
      if (r.id) taskMap.set(r.id, existente);
    } else if (!vistos.has(clave)) {
      vistos.add(clave);
      tasks.push(r);
    }
  }

  /* notas */
  const noteIds = new Set(n.data!.map((x) => x.id));
  const noteBodies = new Set(n.data!.map((x) => x.body));
  const notes: NoteIn[] = [];
  for (const r of b.notes.ok) {
    if ((r.id && noteIds.has(r.id)) || noteBodies.has(r.body)) continue;
    noteBodies.add(r.body);
    notes.push(r);
  }

  /* rutinas */
  const habitIds = new Set(h.data!.map((x) => x.id));
  const habitNames = new Map(h.data!.map((x) => [x.name.toLowerCase(), x.id]));
  const habitMap = new Map<string, string>();
  const habits: HabitIn[] = [];
  for (const r of b.habits.ok) {
    const existente = (r.id && habitIds.has(r.id) ? r.id : undefined) ?? habitNames.get(r.name.toLowerCase());
    if (existente) {
      if (r.id) habitMap.set(r.id, existente);
    } else {
      habitNames.set(r.name.toLowerCase(), "nueva");
      habits.push(r);
    }
  }
  const nuevasRutinas = new Set(habits.map((x) => x.id).filter(Boolean));
  const logHay = new Set(hl.data!.map((x) => k(x.habit_id, x.day)));
  const habit_log = b.habit_log.ok.filter((r) => {
    const destino = habitMap.get(r.habit_id) ?? (nuevasRutinas.has(r.habit_id) ? r.habit_id : null);
    if (!destino) return false;
    const key = k(destino, r.day);
    if (logHay.has(key)) return false;
    logHay.add(key);
    return true;
  });

  /* eventos */
  const evHay = new Set(e.data!.map((x) => k(x.source, x.external_id)));
  const events = b.events.ok.filter((r) => {
    const key = k(r.source, r.external_id);
    if (evHay.has(key)) return false;
    evHay.add(key);
    return true;
  });

  /* bloques */
  const blIds = new Set(bl.data!.map((x) => x.id));
  const blKey = new Set(bl.data!.map((x) => k(x.day, x.start_min, x.end_min, x.title)));
  const blocks = b.blocks.ok.filter((r) => {
    const key = k(r.day, r.start_min, r.end_min, r.title);
    if ((r.id && blIds.has(r.id)) || blKey.has(key)) return false;
    blKey.add(key);
    return true;
  });

  const cuenta = (raw: { ok: unknown[]; invalid: number }, nuevos: unknown[]): TableCount => ({
    total: raw.ok.length + raw.invalid,
    new: nuevos.length,
    duplicates: raw.ok.length - nuevos.length,
    invalid: raw.invalid,
  });

  return {
    tasks, notes, habits, habit_log, events, blocks, taskMap, habitMap,
    summary: {
      version: b.version,
      exportedAt: b.exportedAt,
      tasks: cuenta(b.tasks, tasks),
      notes: cuenta(b.notes, notes),
      habits: cuenta(b.habits, habits),
      habit_log: cuenta(b.habit_log, habit_log),
      events: cuenta(b.events, events),
      blocks: cuenta(b.blocks, blocks),
    },
  };
}

/* ---------------------------------------------------------- escribir */

/** La fila sin su id viejo: en tu cuenta recibe uno nuevo. */
function sinId<T extends { id?: string }>(r: T): Omit<T, "id"> {
  const copia = { ...r };
  delete copia.id;
  return copia;
}

async function insertChunks(ctx: Pick<Ctx, "supabase">, table: string, rowsIn: Record<string, unknown>[]) {
  for (let i = 0; i < rowsIn.length; i += 200) {
    const { error } = await ctx.supabase.from(table).insert(rowsIn.slice(i, i + 200));
    if (error) throw new BackupError(`No se pudo importar ${table}: ${error.message}`);
  }
}

/**
 * Inserta lo nuevo, con ids nuevos y a tu nombre. Las referencias (el bloque
 * a su tarea, la marca a su rutina) se traducen a los ids de tu cuenta.
 */
export async function applyImport(ctx: Pick<Ctx, "supabase" | "userId">, plan: Plan): Promise<BackupSummary> {
  const taskMap = new Map(plan.taskMap);
  const habitMap = new Map(plan.habitMap);
  const nuevo = (old: string | undefined, map: Map<string, string>) => {
    const id = randomUUID();
    if (old) map.set(old, id);
    return id;
  };

  await insertChunks(ctx, "tasks", plan.tasks.map(({ id, ...r }) => ({
    ...r, id: nuevo(id, taskMap), user_id: ctx.userId, track_started_at: null,
  })));
  await insertChunks(ctx, "habits", plan.habits.map(({ id, ...r }) => ({ ...r, id: nuevo(id, habitMap), user_id: ctx.userId })));
  await insertChunks(ctx, "habit_log", plan.habit_log
    .map((r) => ({ habit_id: habitMap.get(r.habit_id), day: r.day, user_id: ctx.userId }))
    .filter((r) => r.habit_id));
  await insertChunks(ctx, "events", plan.events.map((r) => ({ ...sinId(r), user_id: ctx.userId })));
  await insertChunks(ctx, "notes", plan.notes.map((r) => ({ ...sinId(r), user_id: ctx.userId })));
  await insertChunks(ctx, "blocks", plan.blocks.map((r) => ({
    ...sinId(r), user_id: ctx.userId, task_id: r.task_id ? taskMap.get(r.task_id) ?? null : null,
  })));

  return plan.summary;
}

/* ---------------------------------------------------------- exportar */

const EXPORT_TABLES = ["tasks", "events", "notes", "habits", "habit_log", "blocks", "sync_state"] as const;

/**
 * El respaldo completo, en el formato de siempre más `schemaVersion`. Las
 * lápidas de Canvas no van (son una marca interna), ni las columnas de
 * búsqueda (Postgres las rehace solo).
 */
export async function buildExport(ctx: Pick<Ctx, "supabase" | "userId" | "profile" | "tz">, cols: { tasks: string; notes: string }) {
  const out: Record<string, unknown> = {
    schemaVersion: SCHEMA_VERSION,
    app: "TaskFlow",
    exportado_en: new Date().toISOString(),
    zona_horaria: ctx.tz,
    perfil: ctx.profile,
  };
  for (const tabla of EXPORT_TABLES) {
    let q = ctx.supabase
      .from(tabla)
      .select(tabla === "tasks" ? cols.tasks : tabla === "notes" ? cols.notes : "*")
      .eq("user_id", ctx.userId);
    if (tabla === "tasks") q = q.is("purged_at", null);
    const { data, error } = await q;
    if (error) throw new BackupError(`No se pudo leer ${tabla}: ${error.message}`);
    out[tabla] = data ?? [];
  }
  return out;
}
