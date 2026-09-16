"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { capture } from "@/app/actions";
import { fmtDur, fmtDate, minsToHHMM } from "@/lib/date";
import { parseInput } from "@/lib/parse";
import { Toast } from "./Toast";

type Mode = "tarea" | "nota" | "bloque";

const PLACEHOLDER: Record<Mode, string> = {
  tarea: "Escribe y presiona Enter…",
  nota: "Suelta la idea…",
  bloque: "Estudiar econ 3pm 90m",
};

const PRIO = ["", "alta", "media", "baja"];

/** La barra de captura rápida. El parser corre aquí en vivo y otra vez en el servidor. */
export function Capture({ areas, today }: { areas: string[]; today: string }) {
  const [mode, setMode] = useState<Mode>("tarea");
  const [text, setText] = useState("");
  const [state, formAction, pending] = useActionState(capture, null);
  const input = useRef<HTMLInputElement>(null);

  // Vacía el campo sólo si el guardado salió bien: si falló, el texto se queda
  // para corregirlo en vez de perderse. Ajuste en render, no en un efecto.
  const [seen, setSeen] = useState(state);
  if (state !== seen) {
    setSeen(state);
    if (state?.ok) setText("");
  }

  // "/" enfoca la captura, como en el reference.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
      if (e.key === "/" && !typing) {
        e.preventDefault();
        input.current?.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <form className="capture" action={formAction} data-pending={pending}>
        <input type="hidden" name="mode" value={mode} />

        <div className="seg" role="group" aria-label="Tipo de captura">
          {(["tarea", "nota", "bloque"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => {
                setMode(m);
                input.current?.focus();
              }}
            >
              {m === "tarea" ? "Tarea" : m === "nota" ? "Nota" : "Bloque"}
            </button>
          ))}
        </div>

        <input
          ref={input}
          type="text"
          name="text"
          autoComplete="off"
          placeholder={PLACEHOLDER[mode]}
          value={text}
          disabled={pending}
          onChange={(e) => setText(e.target.value)}
        />

        <button className="btn" type="submit" disabled={pending || !text.trim()}>
          {pending ? "Guardando…" : "Agregar"}
        </button>

        <div className="hint">
          <Hint raw={text} mode={mode} areas={areas} today={today} />
        </div>
      </form>
      <Toast result={state} />
    </>
  );
}

function Hint({ raw, mode, areas, today }: { raw: string; mode: Mode; areas: string[]; today: string }) {
  if (!raw.trim()) {
    return (
      <>
        <b>#area</b> · <b>!alta</b> · <b>mañana</b> / <b>vie</b> / <b>22 oct</b> · <b>3pm</b> ·{" "}
        <b>45m</b>
      </>
    );
  }

  // Una nota se guarda tal cual; no tiene sentido mostrarle campos parseados.
  if (mode === "nota") return <>→ se guarda tal cual</>;

  const p = parseInput(raw, { areas, today });
  const bits: React.ReactNode[] = [];
  if (p.area) bits.push(<>área <b>{p.area}</b></>);
  if (p.due) bits.push(<>para <b>{fmtDate(p.due, today)}</b></>);
  if (p.start !== null) bits.push(<>a las <b>{minsToHHMM(p.start)}</b></>);
  if (p.dur) bits.push(<><b>{fmtDur(p.dur)}</b></>);
  if (p.prio) bits.push(<>prioridad <b>{PRIO[p.prio]}</b></>);

  if (!bits.length) return null;

  return (
    <>
      → {p.title} —{" "}
      {bits.map((b, i) => (
        <span key={i}>
          {i > 0 ? " · " : ""}
          {b}
        </span>
      ))}
    </>
  );
}
