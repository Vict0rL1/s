"use client";

import { useEffect, useState } from "react";

type Estado =
  | { k: "cargando" }
  | { k: "no-soportado" }
  | { k: "bloqueado" }
  | { k: "sin-permiso" }
  | { k: "sin-suscripcion" }
  | { k: "suscrito"; registrada: boolean };

/**
 * Lo que sólo sabe el navegador: si admite avisos, si diste permiso y si este
 * dispositivo está suscrito. Y lo cruza con el servidor: una suscripción que
 * el navegador tiene pero el servidor no, no recibe nada.
 */
export function PushDeviceStatus({ endpoints }: { endpoints: string[] }) {
  const [e, setE] = useState<Estado>({ k: "cargando" });

  useEffect(() => {
    let vivo = true;
    (async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        return vivo && setE({ k: "no-soportado" });
      }
      if (Notification.permission === "denied") return vivo && setE({ k: "bloqueado" });
      if (Notification.permission !== "granted") return vivo && setE({ k: "sin-permiso" });
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (!vivo) return;
      setE(sub ? { k: "suscrito", registrada: endpoints.includes(sub.endpoint) } : { k: "sin-suscripcion" });
    })().catch(() => vivo && setE({ k: "no-soportado" }));
    return () => {
      vivo = false;
    };
  }, [endpoints]);

  const texto =
    e.k === "cargando" ? "comprobando…"
    : e.k === "no-soportado" ? "este navegador no admite avisos push"
    : e.k === "bloqueado" ? "bloqueaste los avisos para este sitio (se reactivan desde los permisos del navegador)"
    : e.k === "sin-permiso" ? "todavía no diste permiso — Ajustes → Avisos"
    : e.k === "sin-suscripcion" ? "con permiso, pero sin suscripción — Ajustes → Avisos"
    : e.registrada ? "suscrito y registrado en el servidor"
    : "suscrito, pero el servidor no lo tiene: se vuelve a registrar al recargar";

  return <dd>{texto}</dd>;
}
