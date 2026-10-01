"use client";

import { useActionState } from "react";
import { toggleFocus } from "@/app/actions";
import { Toast } from "./Toast";

/**
 * La estrella del enfoque. Es cliente y no un <form> pelón porque el servidor
 * puede contestar "Máximo 3 en el enfoque" y eso hay que mostrarlo.
 */
export function FocusButton({ id, focused }: { id: string; focused: boolean }) {
  const [state, formAction, pending] = useActionState(toggleFocus, null);

  return (
    <>
      <form action={formAction} className="inline">
        <input type="hidden" name="id" value={id} />
        <button
          type="submit"
          className={"xbtn star" + (focused ? " on" : "")}
          aria-label={focused ? "Quitar del enfoque de hoy" : "Fijar en el enfoque de hoy"}
          aria-pressed={focused}
          disabled={pending}
        >
          {focused ? "★" : "☆"}
        </button>
      </form>
      <Toast result={state} />
    </>
  );
}
