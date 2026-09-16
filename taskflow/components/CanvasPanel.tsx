"use client";

import { useActionState } from "react";
import { syncCanvasNow } from "@/app/actions";
import { Toast } from "./Toast";

export function CanvasPanel({
  configured,
  lastSynced,
  lastError,
  itemsSynced,
}: {
  configured: boolean;
  /** Ya formateado en la zona del perfil por el servidor. */
  lastSynced: string | null;
  lastError: string | null;
  itemsSynced: number;
}) {
  const [state, formAction, pending] = useActionState(
    async () => await syncCanvasNow(),
    null,
  );

  return (
    <>
      <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--ink-2)" }}>
        Trae los deadlines de SFU solos: tareas, quizzes y discusiones que todavía no
        entregaste. Lo que ya entregaste no entra.
      </p>

      {configured ? (
        <>
          <form action={formAction}>
            <button className="btn" type="submit" disabled={pending}>
              {pending ? "Sincronizando…" : "Sincronizar ahora"}
            </button>
          </form>

          <div className="srcrow" style={{ marginTop: 14 }}>
            <b>Última sincronización</b>
            <span className="mono">{lastSynced ?? "nunca"}</span>
          </div>
          {lastSynced ? (
            <div className="srcrow">
              <b>Deadlines traídos</b>
              <span className="mono">{itemsSynced}</span>
            </div>
          ) : null}
          {lastError ? <div className="err" style={{ marginTop: 12 }}>{lastError}</div> : null}
        </>
      ) : (
        <div className="authnote">
          <p style={{ margin: "0 0 8px" }}>
            Falta el token. Sácalo de Canvas → Account → Settings →{" "}
            <b>+ New Access Token</b>, ponle fecha de expiración y cópialo.
          </p>
          <p style={{ margin: "0 0 8px" }}>
            Va en <code>.env.local</code> como <code>CANVAS_TOKEN</code>, junto con{" "}
            <code>CANVAS_BASE_URL=https://canvas.sfu.ca/api/v1</code>, y en las variables de
            entorno de Vercel.
          </p>
          <p style={{ margin: 0 }}>
            Al repo no va nunca. Si se te filtra, revócalo en Canvas y genera otro — borrar el
            commit no basta.
          </p>
        </div>
      )}

      <Toast result={state} />
    </>
  );
}
