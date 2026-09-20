import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { ANTHROPIC_API_KEY, PLANNER_MODEL } from "./env.server";
import { minsToHHMM } from "./date";
import type { Block, DayEvent, Profile, Task } from "./types";

/**
 * El planificador del día.
 *
 * La idea viene de `PLAN.md` y del artifact de referencia, pero con tres
 * cambios que importan:
 *
 *  1. **Propone, no aplica.** El de referencia sobreescribía los bloques del
 *     día de un golpe (`byDate[d] = made`). Eso borra en silencio lo que
 *     pusiste a mano, que es exactamente lo que `CLAUDE.md` prohíbe para el
 *     sync. Aquí la propuesta vuelve al navegador, la miras, y sólo se escribe
 *     si le das a aceptar.
 *  2. **Los huecos se calculan aquí, no los adivina el modelo.** Las clases,
 *     los eventos y tus bloques de hoy salen de la base; este archivo resta y
 *     entrega los ratos libres ya masticados. Un modelo al que le pides que
 *     "respete los compromisos" se los pisa de vez en cuando; uno al que sólo
 *     le das huecos, no puede.
 *  3. **Se le da el tiempo real que queda.** Nada antes de la hora actual.
 */

/* ------------------------------------------------------------------ huecos */

export type Gap = { start: number; end: number };

/** Un hueco por debajo de esto no sirve para nada: ni empiezas. */
const MIN_GAP = 20;

/**
 * Los ratos libres de hoy, en minutos locales.
 *
 * `busy` son los compromisos: clases, eventos con hora y los bloques que ya
 * tengas puestos. Se fusionan los solapados antes de restar, porque dos
 * eventos encimados dejarían un hueco negativo.
 */
export function freeGaps(busy: Gap[], from: number, to: number): Gap[] {
  const ocupado = busy
    .map((b) => ({ start: Math.max(b.start, from), end: Math.min(b.end, to) }))
    .filter((b) => b.end > b.start)
    .sort((a, b) => a.start - b.start);

  const fusionado: Gap[] = [];
  for (const b of ocupado) {
    const ultimo = fusionado[fusionado.length - 1];
    if (ultimo && b.start <= ultimo.end) ultimo.end = Math.max(ultimo.end, b.end);
    else fusionado.push({ ...b });
  }

  const libres: Gap[] = [];
  let cursor = from;
  for (const b of fusionado) {
    if (b.start - cursor >= MIN_GAP) libres.push({ start: cursor, end: b.start });
    cursor = Math.max(cursor, b.end);
  }
  if (to - cursor >= MIN_GAP) libres.push({ start: cursor, end: to });
  return libres;
}

/* ------------------------------------------------------- forma de la salida */

const ProposedBlock = z.object({
  inicio: z.string().describe('Hora de inicio, "HH:MM" en formato de 24 horas'),
  fin: z.string().describe('Hora de fin, "HH:MM" en formato de 24 horas'),
  titulo: z.string().describe("Qué se hace en ese rato, corto y concreto"),
  tipo: z.enum(["tarea", "descanso"]),
  taskId: z
    .string()
    .nullable()
    .describe("El id exacto de la tarea que este bloque adelanta, o null si es un descanso"),
});

const PlanSchema = z.object({
  bloques: z.array(ProposedBlock),
  nota: z.string().describe("Una frase sobre el criterio del plan, para el usuario"),
});

export type PlannedBlock = {
  start: number;
  end: number;
  title: string;
  kind: "tarea" | "descanso";
  taskId: string | null;
};

export type Plan = { blocks: PlannedBlock[]; note: string; costUsd: number };

const HHMM = /^(\d{1,2}):(\d{2})$/;

function toMinutes(v: string): number | null {
  const m = HHMM.exec(v.trim());
  if (!m) return null;
  const h = +m[1], min = +m[2];
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/* ------------------------------------------------------------------ prompt */

const SYSTEM = [
  "Organizas el día de un estudiante universitario. Tu trabajo es repartir sus tareas",
  "pendientes en los ratos que de verdad tiene libres, no llenarle la agenda.",
  "",
  "Reglas que no se rompen:",
  "- Sólo puedes usar los huecos que te doy. No inventes tiempo ni muevas nada de lo fijo.",
  "- Un bloque cabe entero dentro de un solo hueco. No lo partas entre dos.",
  "- Respeta los minutos estimados de cada tarea cuando los traiga.",
  "- Lo que vence antes va antes. A igualdad de fecha, manda la prioridad.",
  "- Después de dos bloques largos seguidos, mete un descanso de 10 a 15 minutos.",
  "- Deja aire. Es mejor un plan de tres bloques que se cumple que uno de nueve que se abandona.",
  "- Máximo 8 bloques.",
  "",
  "Los títulos van en español, en minúscula salvo nombres propios, y dicen qué se hace",
  '("terminar el problem set 3", no "trabajar en tareas").',
].join("\n");

function buildPrompt(input: {
  today: string;
  now: number;
  gaps: Gap[];
  fixed: string[];
  tasks: { id: string; titulo: string; area: string | null; vence: string; minutos: number; prioridad: number }[];
}): string {
  return [
    `Hoy es ${input.today}. Son las ${minsToHHMM(input.now)}.`,
    "",
    "Ya comprometido (no se toca, sólo para que entiendas la forma del día):",
    input.fixed.length ? input.fixed.map((f) => `  ${f}`).join("\n") : "  (nada)",
    "",
    "Ratos libres, los únicos que puedes usar:",
    input.gaps.map((g) => `  ${minsToHHMM(g.start)}–${minsToHHMM(g.end)} (${g.end - g.start} min)`).join("\n"),
    "",
    "Tareas pendientes (usa el id tal cual viene):",
    JSON.stringify(input.tasks, null, 1),
  ].join("\n");
}

/* -------------------------------------------------------------------- call */

/**
 * Precios de la API por millón de tokens, para poder decirle al usuario lo que
 * costó en vez de que se entere en la factura. Lo comparte `lib/breakdown.ts`.
 */
export const PRICE_PER_MTOK: Record<string, { in: number; out: number }> = {
  "claude-opus-5": { in: 5, out: 25 },
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

export type PlanInput = {
  profile: Profile;
  today: string;
  now: number;
  tasks: Task[];
  events: DayEvent[];
  blocks: Block[];
};

export async function planDay(input: PlanInput): Promise<Plan> {
  const { profile, today, now, tasks, events, blocks } = input;

  // La ventana del día: lo que queda, redondeado al cuarto de hora siguiente
  // para no proponer algo que empieza "ya mismo".
  const desde = Math.max(profile.day_start * 60, Math.ceil(now / 15) * 15);
  const hasta = profile.day_end * 60;
  if (hasta - desde < MIN_GAP) {
    throw new Error("Ya casi no queda día. Prueba mañana por la mañana.");
  }

  const busy: Gap[] = [
    ...events.filter((e) => e.start != null).map((e) => ({ start: e.start!, end: e.end ?? e.start! + 60 })),
    ...blocks.map((b) => ({ start: b.start_min, end: b.end_min })),
  ];
  const gaps = freeGaps(busy, desde, hasta);
  if (!gaps.length) throw new Error("No te queda ningún hueco libre hoy.");

  const candidatas = tasks
    .filter((t) => !t.done)
    .filter((t) => !t.due_date || t.due_date <= addDaysStr(today, 10))
    .sort(
      (a, b) =>
        String(a.due_date ?? "9").localeCompare(String(b.due_date ?? "9")) || a.priority - b.priority,
    )
    .slice(0, 14)
    .map((t) => ({
      id: t.id,
      titulo: t.title,
      area: t.area,
      vence: t.due_date ?? "sin fecha",
      minutos: t.est_minutes ?? 45,
      prioridad: t.priority,
    }));

  if (!candidatas.length) throw new Error("No hay tareas pendientes que agendar.");

  const fixed = events
    .filter((e) => e.start != null)
    .sort((a, b) => a.start! - b.start!)
    .map((e) => `${minsToHHMM(e.start!)}–${minsToHHMM(e.end ?? e.start! + 60)} ${e.title}`);

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const model = PLANNER_MODEL;

  const response = await client.messages.parse({
    model,
    max_tokens: 4000,
    system: SYSTEM,
    messages: [{ role: "user", content: buildPrompt({ today, now, gaps, fixed, tasks: candidatas }) }],
    output_config: { format: zodOutputFormat(PlanSchema) },
  });

  if (response.stop_reason === "refusal") {
    throw new Error("El modelo no quiso responder a esto.");
  }

  const parsed = response.parsed_output;
  if (!parsed) throw new Error("La respuesta no vino en el formato esperado.");

  const precio = PRICE_PER_MTOK[model] ?? PRICE_PER_MTOK["claude-opus-5"];
  const costUsd =
    (response.usage.input_tokens / 1e6) * precio.in +
    (response.usage.output_tokens / 1e6) * precio.out;

  const idsValidos = new Set(candidatas.map((t) => t.id));

  // Se valida todo otra vez contra los huecos. El esquema garantiza la forma,
  // no que las horas tengan sentido: un bloque que se sale de un hueco o que
  // referencia una tarea inventada se descarta aquí, no se escribe en la base.
  const blocksOut: PlannedBlock[] = [];
  for (const b of parsed.bloques.slice(0, 8)) {
    const start = toMinutes(b.inicio);
    const end = toMinutes(b.fin);
    if (start == null || end == null || end <= start) continue;
    if (!gaps.some((g) => start >= g.start && end <= g.end)) continue;
    if (blocksOut.some((x) => start < x.end && end > x.start)) continue;
    blocksOut.push({
      start,
      end,
      title: (b.titulo || "Bloque").slice(0, 120),
      kind: b.tipo === "descanso" ? "descanso" : "tarea",
      taskId: b.taskId && idsValidos.has(b.taskId) ? b.taskId : null,
    });
  }

  if (!blocksOut.length) throw new Error("El plan que salió no cabía en tus huecos. Intenta otra vez.");

  blocksOut.sort((a, b) => a.start - b.start);
  return { blocks: blocksOut, note: parsed.nota, costUsd };
}

/** Local y diminuta: `lib/date` no se puede importar entero aquí sin arrastrar más. */
function addDaysStr(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
