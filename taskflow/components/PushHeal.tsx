"use client";

import { useEffect } from "react";
import { syncPushSubscription } from "@/app/actions";

/**
 * Una vez por sesión, si este navegador está suscrito a los avisos, se lo
 * vuelve a decir al servidor (en silencio; es un upsert).
 *
 * Cubre la deriva que antes nadie veía: el navegador suscrito, el servidor sin
 * la suscripción (se borró tras un fallo, el navegador la rotó), Ajustes
 * diciendo "activos" y ningún aviso llegando.
 */
export function PushHeal() {
  // El service worker se registra en cada carga, no sólo al activar los
  // avisos: es también el que muestra la página sin conexión.
  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);

  useEffect(() => {
    try {
      if (sessionStorage.getItem("taskflow.pushHeal")) return;
      sessionStorage.setItem("taskflow.pushHeal", "1");
    } catch {
      /* almacenamiento bloqueado: se intenta igual, es barato */
    }
    if (!("serviceWorker" in navigator) || !("Notification" in window)) return;
    if (Notification.permission !== "granted") return;

    navigator.serviceWorker
      .getRegistration()
      .then((reg) => reg?.pushManager.getSubscription())
      .then((sub) => {
        if (!sub) return;
        const k = sub.toJSON().keys ?? {};
        if (k.p256dh && k.auth) return syncPushSubscription({ endpoint: sub.endpoint, p256dh: k.p256dh, auth: k.auth });
      })
      .catch(() => {
        /* sin red o sin service worker: la próxima sesión lo intenta otra vez */
      });
  }, []);
  return null;
}
