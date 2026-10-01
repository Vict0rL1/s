"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { startTelegramLink, unlinkTelegram } from "@/app/actions";

/**
 * Conectar TaskFlow con un chat de Telegram.
 *
 * El flujo es el de cualquier bot serio: un botón genera un enlace de un solo
 * uso, el enlace abre Telegram con el bot, y al pulsar "Iniciar" el chat queda
 * conectado. La página no se entera sola de que eso pasó —sería sondear el
 * servidor cada pocos segundos para un evento que ocurre una vez—, así que hay
 * un botón para comprobarlo.
 */
export function TelegramPanel({
  configured,
  linkedAt,
}: {
  configured: boolean;
  /** Ya formateado por el servidor, o null si no hay chat conectado. */
  linkedAt: string | null;
}) {
  const router = useRouter();
  const [enlace, pedirEnlace, pidiendo] = useActionState(async () => await startTelegramLink(), null);
  const [baja, desconectar, desconectando] = useActionState(async () => await unlinkTelegram(), null);

  if (!configured) {
    return (
      <div className="authnote">
        <p style={{ margin: "0 0 8px" }}>
          Los mismos avisos, en un chat de Telegram. Llegan aunque el navegador tenga las
          notificaciones apagadas, y en iPhone no hace falta instalar nada.
        </p>
        <p style={{ margin: "0 0 8px" }}>
          En Telegram, háblale a <b>@BotFather</b>, escribe <code>/newbot</code> y sigue los pasos.
          Te da un token.
        </p>
        <p style={{ margin: 0 }}>
          Ponlo en las variables de entorno de Vercel como <code>TELEGRAM_BOT_TOKEN</code> y vuelve
          a desplegar. Al repo no va nunca.
        </p>
      </div>
    );
  }

  if (linkedAt) {
    return (
      <>
        <div className="srcrow">
          <b>Conectado</b>
          <span className="mono">{linkedAt}</span>
        </div>
        <p style={{ margin: "10px 0 12px", fontSize: 13, color: "var(--ink-2)" }}>
          El resumen de la mañana y el de la noche antes llegan también a ese chat. Desde
          Telegram puedes desconectarlo escribiendo <code>/stop</code>.
        </p>
        <form action={desconectar}>
          <button className="btn line sm" type="submit" disabled={desconectando}>
            {desconectando ? "Desconectando…" : "Desconectar"}
          </button>
        </form>
        {baja && !baja.ok ? <div className="err" style={{ marginTop: 10 }}>{baja.message}</div> : null}
      </>
    );
  }

  return (
    <>
      <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--ink-2)" }}>
        Los mismos avisos, en un chat de Telegram. Llegan aunque el navegador tenga las
        notificaciones apagadas.
      </p>

      {enlace?.ok && enlace.url ? (
        <>
          <div className="row" style={{ gap: 8 }}>
            <a className="btn" href={enlace.url} target="_blank" rel="noreferrer">
              Abrir Telegram
            </a>
            <button className="btn line" type="button" onClick={() => router.refresh()}>
              Ya lo conecté
            </button>
          </div>
          <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--ink-3)" }}>
            Pulsa «Iniciar» en el chat del bot. {enlace.message}.
          </p>
        </>
      ) : (
        <form action={pedirEnlace}>
          <button className="btn" type="submit" disabled={pidiendo}>
            {pidiendo ? "Preparando…" : "Conectar Telegram"}
          </button>
        </form>
      )}

      {enlace && !enlace.ok ? <div className="err" style={{ marginTop: 10 }}>{enlace.message}</div> : null}
    </>
  );
}
