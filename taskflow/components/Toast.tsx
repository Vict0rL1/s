"use client";

import { useEffect, useState } from "react";
import type { ActionResult } from "@/app/actions";

/**
 * El toast del reference. Se dispara cuando llega un objeto de resultado nuevo
 * — cada corrida del Server Action devuelve uno distinto, así que repetir el
 * mismo mensaje vuelve a mostrarlo.
 */
export function Toast({ result }: { result: ActionResult | null }) {
  // Ajuste en render, no en un efecto: React lo recomienda para derivar estado
  // de una prop que cambió, y evita el re-render en cascada.
  const [seen, setSeen] = useState(result);
  const [msg, setMsg] = useState("");
  if (result !== seen) {
    setSeen(result);
    setMsg(result?.message ?? "");
  }

  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(""), 2600);
    return () => clearTimeout(t);
  }, [msg]);

  if (!msg) return null;
  return (
    <div className="toast" role="status">
      {msg}
    </div>
  );
}

/** Igual, pero para mensajes que no vienen de un Server Action. */
export function useToast() {
  const [result, setResult] = useState<ActionResult | null>(null);
  return { result, toast: (message: string) => setResult({ ok: true, message }) };
}
