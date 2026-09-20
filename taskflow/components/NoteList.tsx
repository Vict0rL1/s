"use client";

import { useActionState, useState } from "react";
import { deleteNote, noteToTask, togglePin } from "@/app/actions";
import { norm } from "@/lib/date";
import { Toast } from "./Toast";

export type NoteView = { id: string; body: string; pinned: boolean; when: string };

function NoteRow({ note }: { note: NoteView }) {
  const [state, convert, pending] = useActionState(noteToTask, null);

  return (
    <div className={"note" + (note.pinned ? " pinned" : "")}>
      <form action={togglePin} className="inline">
        <input type="hidden" name="id" value={note.id} />
        <button type="submit" className="pin" aria-label="Fijar" aria-pressed={note.pinned}>
          ★
        </button>
      </form>

      <p>
        {note.body}
        <span className="when">{note.when}</span>
      </p>

      <form action={convert} className="inline">
        <input type="hidden" name="id" value={note.id} />
        <button type="submit" className="btn ghost sm" disabled={pending}>
          → tarea
        </button>
      </form>

      <form action={deleteNote} className="inline">
        <input type="hidden" name="id" value={note.id} />
        <button type="submit" className="xbtn" aria-label="Eliminar">
          ×
        </button>
      </form>

      <Toast result={state} />
    </div>
  );
}

export function NoteList({ notes }: { notes: NoteView[] }) {
  const [q, setQ] = useState("");
  const needle = norm(q);
  const shown = needle ? notes.filter((n) => norm(n.body).includes(needle)) : notes;

  return (
    <>
      <div className="viewhead">
        <div>
          <span className="eyebrow">{notes.length} capturadas</span>
          <h1>Notas</h1>
        </div>
        <div className="row">
          <input
            type="text"
            className="notesearch"
            placeholder="Buscar…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Buscar en las notas"
          />
        </div>
      </div>

      <div className="panel">
        <div className="pb tight">
          {shown.length ? (
            shown.map((n) => <NoteRow key={n.id} note={n} />)
          ) : (
            <div className="empty">
              <b>{notes.length ? "Nada con esa búsqueda" : "Sin notas"}</b>
              {notes.length
                ? "Prueba con otra palabra."
                : "Cambia a «Nota» arriba y suelta la idea antes de que se te olvide."}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
