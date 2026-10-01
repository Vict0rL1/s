"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Volver a la pestaña al minuto de irse no vale un viaje al servidor. */
const MIN_GAP_MS = 60_000;

/**
 * Vuelve a pedir la vista cada tanto, sólo mientras la pestaña está a la
 * vista. Para Hoy: "Próximo: ECON 342 en 42 min" deja de ser cierto si la
 * pestaña se queda abierta toda la mañana.
 */
export function AutoRefresh({ minutes }: { minutes: number }) {
  const router = useRouter();
  useEffect(() => {
    let last = performance.now();
    const tick = () => {
      if (document.visibilityState !== "visible" || performance.now() - last < MIN_GAP_MS) return;
      last = performance.now();
      router.refresh();
    };
    const id = setInterval(tick, minutes * 60_000);
    // Al volver a la pestaña después de un rato, también.
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [minutes, router]);
  return null;
}
