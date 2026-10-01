"use client";

import { useActionState, useEffect, useRef } from "react";
import { addHabit } from "@/app/actions";
import { DAYS_SHORT } from "@/lib/date";
import { Toast } from "./Toast";

export function AddHabit() {
  const [state, formAction, pending] = useActionState(addHabit, null);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state?.ok) form.current?.reset();
  }, [state]);

  return (
    <>
      <form action={formAction} ref={form}>
        <div className="row">
          <input
            type="text"
            name="name"
            className="habitname"
            autoComplete="off"
            placeholder="Nueva rutina…"
            aria-label="Nombre de la rutina"
          />
          {DAYS_SHORT.map((label, i) => (
            <label className="chip daychip" key={i}>
              <input type="checkbox" name="days" value={i} defaultChecked />
              {label}
            </label>
          ))}
          <button className="btn sm" type="submit" disabled={pending}>
            {pending ? "Agregando…" : "Agregar"}
          </button>
        </div>
      </form>
      <Toast result={state} />
    </>
  );
}
