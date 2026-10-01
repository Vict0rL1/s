"use client";

import { useActionState } from "react";
import { updateHabit } from "@/app/actions";
import { DAYS_SHORT } from "@/lib/date";
import type { Habit } from "@/lib/types";
import { Toast } from "./Toast";

/** Nombre, días en que toca y si se muestra la racha. Plegado hasta que se pide. */
export function HabitSettings({ habit }: { habit: Habit }) {
  const [state, formAction, pending] = useActionState(updateHabit, null);
  return (
    <details className="hset">
      <summary className="btn line sm">Ajustar</summary>
      <form action={formAction} className="hsetform">
        <input type="hidden" name="id" value={habit.id} />
        <input
          type="text"
          name="name"
          className="habitname"
          defaultValue={habit.name}
          maxLength={80}
          autoComplete="off"
          aria-label="Nombre de la rutina"
        />
        <fieldset>
          <legend>Días en que toca</legend>
          <div className="row">
            {DAYS_SHORT.map((label, i) => (
              <label className="chip daychip" key={i}>
                <input type="checkbox" name="days" value={i} defaultChecked={!habit.days?.length || habit.days.includes(i)} />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="checkline">
          <input type="checkbox" name="show_streak" defaultChecked={habit.show_streak !== false} /> Mostrar la racha
        </label>
        <button className="btn sm" type="submit" disabled={pending}>
          {pending ? "Guardando…" : "Guardar"}
        </button>
      </form>
      <Toast result={state} />
    </details>
  );
}
