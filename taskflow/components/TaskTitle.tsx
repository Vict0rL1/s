"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { renameTask } from "@/app/actions";
import { Toast } from "./Toast";

/**
 * El título de una tarea, editable al tocarlo.
 *
 * Guarda con Enter, cancela con Escape. El texto pasa por el mismo parser de
 * la captura rápida, así que «Leer cap 4 mañana» arregla el título y mueve la
 * fecha a la vez, sin inventar otra interfaz para editar campos.
 */
export function TaskTitle({ id, title }: { id: string; title: string }) {
  const [editando, setEditando] = useState(false);
  const [state, formAction, pending] = useActionState(renameTask, null);
  const input = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);

  // Al terminar bien, cerrar. Ajuste en render, no en un efecto.
  const [visto, setVisto] = useState(state);
  if (state !== visto) {
    setVisto(state);
    if (state?.ok) setEditando(false);
  }

  useEffect(() => {
    if (editando) input.current?.select();
  }, [editando]);

  if (!editando) {
    return (
      <button
        type="button"
        className="ttitle edit"
        onClick={() => setEditando(true)}
        title="Tocar para editar"
        aria-label={`Editar «${title}»`}
      >
        {title}
      </button>
    );
  }

  return (
    <>
      <form action={formAction} ref={form} className="titleform">
        <input type="hidden" name="id" value={id} />
        <input
          ref={input}
          type="text"
          name="text"
          defaultValue={title}
          disabled={pending}
          aria-label="Título de la tarea"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setEditando(false);
            }
          }}
          // Guardar al salir del campo, salvo que se haya cancelado.
          onBlur={() => form.current?.requestSubmit()}
        />
      </form>
      <Toast result={state} />
    </>
  );
}
