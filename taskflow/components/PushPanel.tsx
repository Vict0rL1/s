"use client";

import { useActionState, useEffect, useState } from "react";
import { removePushSubscription, savePushSubscription } from "@/app/actions";
import { Toast } from "./Toast";

/** La llave pública VAPID viaja en base64url; el navegador la pide en bytes. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(padded);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

type Estado = "cargando" | "no-soportado" | "bloqueado" | "activo" | "inactivo";

export function PushPanel({ vapidPublicKey }: { vapidPublicKey: string | null }) {
  const [estado, setEstado] = useState<Estado>("cargando");
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState("");
  // `useActionState` devuelve [estado, acción, pendiente].
  const [estadoGuardar, guardar] = useActionState(savePushSubscription, null);
  const [estadoQuitar, quitar] = useActionState(removePushSubscription, null);

  useEffect(() => {
    let vivo = true;
    (async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        return vivo && setEstado("no-soportado");
      }
      if (Notification.permission === "denied") return vivo && setEstado("bloqueado");
      try {
        const reg = await navigator.serviceWorker.register("/sw.js");
        const sub = await reg.pushManager.getSubscription();
        if (vivo) setEstado(sub ? "activo" : "inactivo");
      } catch {
        if (vivo) setEstado("no-soportado");
      }
    })();
    return () => {
      vivo = false;
    };
  }, []);

  async function activar() {
    if (!vapidPublicKey) return setError("Falta NEXT_PUBLIC_VAPID_PUBLIC_KEY");
    setOcupado(true);
    setError("");
    try {
      const permiso = await Notification.requestPermission();
      if (permiso !== "granted") {
        setEstado(permiso === "denied" ? "bloqueado" : "inactivo");
        return;
      }

      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
      });

      const json = sub.toJSON();
      const fd = new FormData();
      fd.set("endpoint", sub.endpoint);
      fd.set("p256dh", json.keys?.p256dh ?? "");
      fd.set("auth", json.keys?.auth ?? "");
      fd.set("user_agent", navigator.userAgent);
      guardar(fd);
      setEstado("activo");
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo activar");
    } finally {
      setOcupado(false);
    }
  }

  async function desactivar() {
    setOcupado(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      const fd = new FormData();
      if (sub) {
        fd.set("endpoint", sub.endpoint);
        await sub.unsubscribe();
      }
      quitar(fd);
      setEstado("inactivo");
    } finally {
      setOcupado(false);
    }
  }

  return (
    <>
      <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--ink-2)" }}>
        Un aviso al día, en la mañana, con lo que vence hoy y lo que está atrasado. Si no hay
        nada que decir, no llega nada.
      </p>

      {error ? <div className="err">{error}</div> : null}

      {estado === "cargando" ? (
        <p className="sk">Comprobando…</p>
      ) : estado === "no-soportado" ? (
        <div className="notice">Este navegador no admite avisos push.</div>
      ) : estado === "bloqueado" ? (
        <div className="notice">
          Bloqueaste los avisos para este sitio. Hay que reactivarlos desde los permisos del
          navegador; desde aquí no se puede.
        </div>
      ) : estado === "activo" ? (
        <>
          <div className="srcrow">
            <b>Avisos</b>
            <span className="mono">activos en este navegador</span>
          </div>
          <button className="btn ghost sm" onClick={desactivar} disabled={ocupado} style={{ marginTop: 12 }}>
            {ocupado ? "Quitando…" : "Desactivar"}
          </button>
        </>
      ) : (
        <button className="btn" onClick={activar} disabled={ocupado || !vapidPublicKey}>
          {ocupado ? "Activando…" : "Activar avisos"}
        </button>
      )}

      {!vapidPublicKey ? (
        <div className="authnote" style={{ marginTop: 12 }}>
          Faltan las llaves VAPID. Genéralas con{" "}
          <code>npx web-push generate-vapid-keys</code> y ponlas como{" "}
          <code>NEXT_PUBLIC_VAPID_PUBLIC_KEY</code> y <code>VAPID_PRIVATE_KEY</code>.
        </div>
      ) : null}

      <Toast result={estadoGuardar} />
      <Toast result={estadoQuitar} />
    </>
  );
}
