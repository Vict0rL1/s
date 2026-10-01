import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { telegramConfigured, telegramWebhookSecret } from "@/lib/env.server";
import { parseStart } from "@/lib/telegram";
import { logActivity } from "@/lib/activity";

export const dynamic = "force-dynamic";

type Update = {
  message?: {
    text?: string;
    chat?: { id?: number; type?: string };
  };
};

/**
 * `POST /api/telegram` — el webhook del bot.
 *
 * Sólo entiende dos cosas: `/start <código>`, que conecta este chat con la
 * cuenta que generó el código, y `/stop`, que lo desconecta. Todo lo demás
 * recibe una línea de ayuda.
 *
 * Corre sin sesión (quien llama es Telegram), así que usa la service role y
 * **salta la RLS**. Por eso cada consulta va acotada por el código o por el
 * chat, nunca "la fila que haya".
 *
 * Las respuestas al usuario viajan en el cuerpo de la propia respuesta HTTP
 * (`{method: "sendMessage", ...}`), que Telegram ejecuta por su cuenta: una
 * llamada saliente menos, y nada que pueda fallar a medias.
 */
export async function POST(request: Request) {
  if (!telegramConfigured()) {
    return NextResponse.json({ ok: false }, { status: 503 });
  }

  // Sin el secreto correcto, esto no es Telegram. Comparación en tiempo
  // constante para no regalar el secreto carácter a carácter.
  const recibido = Buffer.from(request.headers.get("x-telegram-bot-api-secret-token") ?? "");
  const esperado = Buffer.from(telegramWebhookSecret());
  if (recibido.length !== esperado.length || !timingSafeEqual(recibido, esperado)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let update: Update;
  try {
    update = (await request.json()) as Update;
  } catch {
    return NextResponse.json({ ok: true });
  }

  const text = update.message?.text?.trim();
  const chatId = update.message?.chat?.id;
  // Cualquier otra cosa (fotos, ediciones, un grupo) se ignora con un 200:
  // si respondiéramos error, Telegram reintentaría el mismo mensaje.
  if (!text || typeof chatId !== "number") return NextResponse.json({ ok: true });

  const responder = (msg: string) =>
    NextResponse.json({ method: "sendMessage", chat_id: chatId, text: msg });

  // Sólo chats privados: un grupo no debería poder recibir tus tareas.
  if (update.message?.chat?.type !== "private") {
    return responder("TaskFlow sólo manda avisos a chats privados.");
  }

  const admin = createAdminClient();

  if (/^\/stop(@\w+)?$/.test(text)) {
    const { data: soltados } = await admin.from("telegram_chats").delete().eq("chat_id", chatId).select("user_id");
    for (const r of soltados ?? []) {
      await logActivity({ supabase: admin as never, userId: r.user_id }, {
        actor: "user", kind: "telegram.unlinked", summary: "Desconectaste Telegram con /stop desde el chat",
      });
    }
    return responder("Desconectado. Ya no te llegan avisos aquí.");
  }

  const codigo = parseStart(text);
  if (codigo === null) {
    return responder("Aquí sólo llegan los avisos de TaskFlow. Para desconectar, escribe /stop.");
  }
  if (!codigo) {
    return responder("Para conectar, entra a TaskFlow → Ajustes → Telegram → Conectar.");
  }

  const { data: fila } = await admin
    .from("telegram_chats")
    .select("user_id, link_expires_at")
    .eq("link_code", codigo)
    .maybeSingle<{ user_id: string; link_expires_at: string | null }>();

  if (!fila || !fila.link_expires_at || new Date(fila.link_expires_at).getTime() < Date.now()) {
    return responder("Ese enlace ya no sirve. Genera otro en TaskFlow → Ajustes → Telegram.");
  }

  // `chat_id` es único: si este chat estaba conectado a otra cuenta, se suelta
  // de ella antes de atarlo a esta.
  await admin.from("telegram_chats").delete().eq("chat_id", chatId).neq("user_id", fila.user_id);

  const { error } = await admin
    .from("telegram_chats")
    .update({
      chat_id: chatId,
      link_code: null,
      link_expires_at: null,
      linked_at: new Date().toISOString(),
    })
    .eq("user_id", fila.user_id)
    .eq("link_code", codigo);

  if (error) return responder("No se pudo conectar. Intenta otra vez desde Ajustes.");

  await logActivity({ supabase: admin as never, userId: fila.user_id }, {
    actor: "user", kind: "telegram.linked", summary: "Conectaste un chat de Telegram",
  });

  return responder(
    "Listo. Aquí te llegan los avisos de TaskFlow: el resumen de la mañana y el de la noche antes. Para desconectar, escribe /stop.",
  );
}
