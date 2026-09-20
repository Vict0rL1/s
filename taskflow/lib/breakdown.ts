import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { ANTHROPIC_API_KEY, PLANNER_MODEL } from "./env.server";
import { PRICE_PER_MTOK } from "./planner";
import type { Task } from "./types";

/**
 * Partir una tarea grande en pasos con fecha propia.
 *
 * El caso que lo motiva: el proyecto de ECON 370 son 28% de la nota repartidos
 * entre una propuesta el 9 de noviembre y un trabajo final el 7 de diciembre.
 * En la app eso era **una sola fila** que decía "Proyecto final". Una fila así
 * no es un plan: es una pared que aparece el día que ya no hay tiempo.
 *
 * Dos decisiones que lo separan de "pídele subtareas a un modelo":
 *
 *  1. **Planificación hacia atrás.** Los pasos se reparten entre hoy y el
 *     vencimiento, y el último cae ANTES de la fecha, no encima. Terminar el
 *     día de la entrega es no tener margen para nada.
 *  2. **Propone, no dispone**, igual que el planificador. Las tareas nuevas
 *     sólo se escriben si las aceptas.
 */

const Step = z.object({
  titulo: z.string().describe("El paso, empezando por un verbo. Concreto y comprobable."),
  fecha: z.string().describe('Cuándo hacerlo, "YYYY-MM-DD". Entre hoy y el día antes del vencimiento.'),
  minutos: z.number().int().describe("Cuánto va a costar, en minutos. Realista, no optimista."),
});

const BreakdownSchema = z.object({
  pasos: z.array(Step),
  nota: z.string().describe("Una frase sobre cómo repartiste el trabajo."),
});

export type ProposedStep = { title: string; date: string; minutes: number };
export type Breakdown = { steps: ProposedStep[]; note: string; costUsd: number };

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const MAX_STEPS = 7;

const SYSTEM = [
  "Partes el trabajo de un estudiante universitario en pasos con fecha.",
  "",
  "Reglas:",
  "- Entre 3 y 6 pasos. Menos no ayuda; más se abandona.",
  "- Cada paso empieza por un verbo y se puede dar por terminado sin discusión",
  '  ("escribir el borrador de la sección de costos", no "avanzar el proyecto").',
  "- Repártelos entre las fechas que te doy. El último paso NO cae el día del",
  "  vencimiento: deja al menos un día de margen.",
  "- Carga más trabajo al principio que al final. Lo que se deja para el final",
  "  se hace mal.",
  "- Los minutos son realistas. Escribir ocho páginas no son 60 minutos.",
  "- En español, en minúscula salvo nombres propios.",
].join("\n");

export async function breakDown(task: Task, today: string): Promise<Breakdown> {
  if (!task.due_date) {
    throw new Error("Esta tarea no tiene fecha, así que no hay entre qué repartir los pasos.");
  }
  const ultimo = addDaysStr(task.due_date, -1);
  if (ultimo < today) {
    throw new Error("La fecha es hoy o ya pasó. No queda margen que repartir.");
  }

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const model = PLANNER_MODEL;

  const prompt = [
    `Tarea: ${task.title}`,
    task.area ? `Área: ${task.area}` : null,
    task.body ? `Detalle: ${task.body}` : null,
    `Vence: ${task.due_date}`,
    task.est_minutes ? `Estimado total del usuario: ${task.est_minutes} minutos` : null,
    "",
    `Hoy es ${today}. Reparte los pasos entre ${today} y ${ultimo} inclusive.`,
  ]
    .filter(Boolean)
    .join("\n");

  const response = await client.messages.parse({
    model,
    max_tokens: 4000,
    system: SYSTEM,
    messages: [{ role: "user", content: prompt }],
    output_config: { format: zodOutputFormat(BreakdownSchema) },
  });

  if (response.stop_reason === "refusal") throw new Error("El modelo no quiso responder a esto.");
  const parsed = response.parsed_output;
  if (!parsed) throw new Error("La respuesta no vino en el formato esperado.");

  const precio = PRICE_PER_MTOK[model] ?? PRICE_PER_MTOK["claude-opus-5"];
  const costUsd =
    (response.usage.input_tokens / 1e6) * precio.in +
    (response.usage.output_tokens / 1e6) * precio.out;

  // El esquema garantiza la forma, no que las fechas caigan donde deben. Un
  // paso fuera de la ventana se recorta al borde en vez de descartarse: la
  // intención del paso sigue siendo buena aunque la fecha se haya ido.
  const steps: ProposedStep[] = [];
  for (const p of parsed.pasos.slice(0, MAX_STEPS)) {
    const titulo = String(p.titulo ?? "").trim();
    if (!titulo) continue;
    let fecha = YMD.test(p.fecha) ? p.fecha : ultimo;
    if (fecha < today) fecha = today;
    if (fecha > ultimo) fecha = ultimo;
    steps.push({
      title: titulo.slice(0, 120),
      date: fecha,
      minutes: Math.min(480, Math.max(10, Math.round(p.minutos || 45))),
    });
  }

  if (!steps.length) throw new Error("No salió ningún paso utilizable. Intenta otra vez.");

  steps.sort((a, b) => a.date.localeCompare(b.date));
  return { steps, note: parsed.nota, costUsd };
}

function addDaysStr(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
