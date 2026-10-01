import "server-only";

import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { AI_FALLBACK, AI_MAX_TOKENS, type AiClient, aiClient, aiModel, checkStop, costOf } from "./ai";
import { IntegrationError } from "./log";
import type { Task } from "./types";

/**
 * Claude pone nombre a las sesiones de un plan de preparación. Nada más.
 *
 * Los días, las horas y las duraciones ya los decidió `lib/schedule.ts` con tu
 * agenda real; aquí Claude sólo recibe CUÁNTAS sesiones hay y cuánto dura cada
 * una, y devuelve qué hacer en cada una ("repasar caps. 1–3", "simulacro").
 * No ve tu agenda ni puede mover nada: si devuelve de más o de menos, se
 * recorta o se completa con los nombres de siempre.
 */

const Schema = z.object({
  sesiones: z.array(z.string()).describe("Un título por sesión, en el mismo orden"),
});

const SYSTEM = [
  "Ayudas a un estudiante universitario a preparar una entrega o un examen.",
  "Te doy cuántas sesiones de estudio tiene y cuánto dura cada una. Las fechas y horas ya están decididas: no las menciones.",
  "Devuelve exactamente un título por sesión, en orden: corto (máximo 8 palabras), empezando por un verbo y concreto",
  '("repasar capítulos 1 a 3", "hacer el problem set de práctica"), no genérico ("estudiar").',
  "Del más básico al más integrador. La última sesión, si es un repaso, es un repaso ligero: nada nuevo.",
  "En español, en minúscula salvo nombres propios.",
].join("\n");

export async function nameSessions(
  task: Task,
  sessions: { minutes: number; review: boolean }[],
  fallback: string[],
  client: AiClient = aiClient(),
): Promise<{ titles: string[]; costUsd: number }> {
  const prompt = [
    `Qué se prepara: ${task.title}`,
    task.course ? `Curso: ${task.course}` : null,
    task.body ? `Detalle: ${task.body.slice(0, 400)}` : null,
    "",
    `Sesiones (${sessions.length}):`,
    ...sessions.map((s, i) => `${i + 1}. ${s.minutes} min${s.review ? " — repaso el día antes" : ""}`),
  ]
    .filter((x) => x !== null)
    .join("\n");

  const response = await client.beta.messages.parse({
    model: aiModel(),
    max_tokens: AI_MAX_TOKENS,
    system: SYSTEM,
    messages: [{ role: "user", content: prompt }],
    output_config: { format: betaZodOutputFormat(Schema), effort: "low" },
    ...AI_FALLBACK,
  });

  checkStop(response.stop_reason);
  const parsed = response.parsed_output;
  if (!parsed) throw new IntegrationError("ANTHROPIC_INVALID_RESPONSE", "La respuesta no vino en el formato esperado.");

  const titles = fallback.map((def, i) => {
    const t = String(parsed.sesiones[i] ?? "").replace(/\s+/g, " ").trim();
    return t ? t.slice(0, 120) : def;
  });
  return { titles, costUsd: costOf(response.model, response.usage) };
}
