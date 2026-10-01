"use client";

import { useActionState } from "react";
import type { ActionResult } from "@/app/actions";

/**
 * Un botón que corre una acción del servidor y dice cómo salió, ahí mismo.
 *
 * Mientras corre está deshabilitado, así que un doble clic no la dispara dos
 * veces. El resultado queda escrito al lado (no en un toast que desaparece):
 * en una pantalla de diagnóstico, lo que pasó tiene que poder leerse con calma.
 */
export function RunButton({
  action,
  label,
  busy,
  disabled,
  kind = "line",
}: {
  action: () => Promise<ActionResult>;
  label: string;
  busy: string;
  disabled?: boolean;
  kind?: "line" | "solid";
}) {
  const [state, run, pending] = useActionState(async () => await action(), null);
  return (
    <form action={run} className="runbtn">
      <button className={"btn sm" + (kind === "line" ? " line" : "")} type="submit" disabled={pending || disabled}>
        {pending ? busy : label}
      </button>
      <span className={"runmsg" + (state && !state.ok ? " bad" : "")} role="status" aria-live="polite">
        {pending ? "" : state?.message}
      </span>
    </form>
  );
}
