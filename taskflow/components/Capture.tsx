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

/* ------------------------------------------------- cola sin conexión */

/** La misma clave que usa `public/offline.html`. */
const QUEUE = "taskflow.offlineQueue";
type Queued = { cid: string; text: string; mode: Mode; at: string };

function readQueue(): Queued[] {
  try {
    const q = JSON.parse(localStorage.getItem(QUEUE) || "[]");
    return Array.isArray(q) ? q : [];
  } catch {
    return [];
  }
}
function writeQueue(q: Queued[]): boolean {
  try {
    if (q.length) localStorage.setItem(QUEUE, JSON.stringify(q));
    else localStorage.removeItem(QUEUE);
    return true;
  } catch {
    return false;
  }
}

/** Para que dos pestañas (o el doble efecto de desarrollo) no suban lo mismo a la vez. */
let subiendo = false;

/**
 * Sube lo que se anotó sin conexión, de a uno y en orden. Cada uno lleva su
 * id (`cid`), así que si una subida llegó pero la respuesta no, repetirla no
 * duplica: el servidor contesta "ya estaba". Si se corta la red a la mitad,
 * lo que falta se queda para la próxima.
 */
async function flushQueue(): Promise<number> {
  if (subiendo || !navigator.onLine) return 0;
  subiendo = true;
  let subidas = 0;
  try {
    for (const it of readQueue()) {
      const fd = new FormData();
      fd.set("text", it.text);
      fd.set("mode", it.mode);
      fd.set("cid", it.cid);
      let r;
      try {
        r = await capture(null, fd);
      } catch {
        break; // sin red otra vez: se reintenta después
      }
      // Bien, o repetida: se quita de la cola. Con un error de validación
      // ("falta el texto") también: reintentarla para siempre no la arregla.
      writeQueue(readQueue().filter((x) => x.cid !== it.cid));
      if (r.ok) subidas++;
    }
  } finally {
    subiendo = false;
  }
  return subidas;
}

const nuevoId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () => ((Math.random() * 16) | 0).toString(16));

/** La barra de captura rápida. El parser corre aquí en vivo y otra vez en el servidor. */
export function Capture({ areas, today }: { areas: string[]; today: string }) {
  const [mode, setMode] = useState<Mode>("tarea");
  const [text, setText] = useState("");
  const [state, formAction, pending] = useActionState(capture, null);
  const [local, setLocal] = useState<{ ok: boolean; message: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  // Al abrir y al volver la red, se sube lo anotado sin conexión (aquí o en
  // la página offline).
  useEffect(() => {
    async function subir() {
      const n = await flushQueue();
      if (n) setLocal({ ok: true, message: `Se subieron ${n} captura${n > 1 ? "s" : ""} guardada${n > 1 ? "s" : ""} sin conexión` });
    }
    void subir();
    window.addEventListener("online", subir);
    return () => window.removeEventListener("online", subir);
  }, []);

  // Sin red, la captura no se pierde: queda en el dispositivo. Con red, va con
  // su propio id, para que un reintento no la duplique.
  function enviar(fd: FormData) {
    const cid = nuevoId();
    if (!navigator.onLine) {
      const t = String(fd.get("text") ?? "").trim();
      if (!t) return;
      const ok = writeQueue([...readQueue(), { cid, text: t.slice(0, 500), mode, at: new Date().toISOString() }]);
      setLocal(ok
        ? { ok: true, message: "Sin conexión: quedó guardada en este dispositivo y se sube al volver la red" }
        : { ok: false, message: "Sin conexión, y este navegador no deja guardar nada" });
      if (ok) setText("");
      return;
    }
    fd.set("cid", cid);
    formAction(fd);
  }

  // Vacía el campo sólo si el guardado salió bien: si falló, el texto se queda
  // para corregirlo en vez de perderse. Ajuste en render, no en un efecto.
  const [seen, setSeen] = useState(state);
  if (state !== seen) {
    setSeen(state);
    if (state?.ok) setText("");
  }

  // "Nueva tarea" / "Nueva nota" desde la paleta (⌘K) o desde los atajos del
  // ícono instalado (`?capturar=nota`).
  useEffect(() => {
    function onCapture(e: Event) {
      const m = (e as CustomEvent<{ mode?: Mode }>).detail?.mode;
      if (m === "tarea" || m === "nota" || m === "bloque") setMode(m);
      // Después de que el diálogo devuelva el foco.
      setTimeout(() => input.current?.focus(), 0);
    }
    window.addEventListener("taskflow:capture", onCapture);
    const pedido = new URLSearchParams(window.location.search).get("capturar");
    if (pedido) window.dispatchEvent(new CustomEvent("taskflow:capture", { detail: { mode: pedido } }));
    return () => window.removeEventListener("taskflow:capture", onCapture);
  }, []);

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
      <form className="capture" action={enviar} data-pending={pending}>
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
          <span className="hinttext">
            <Hint raw={text} mode={mode} areas={areas} today={today} />
          </span>
          <button
            type="button"
            className="palbtn"
            onClick={() => window.dispatchEvent(new Event("taskflow:palette"))}
            aria-label="Buscar y comandos (Ctrl+K)"
            title="Buscar y comandos (Ctrl+K)"
          >
            Buscar <kbd>⌘K</kbd>
          </button>
        </div>
      </form>
      <Toast result={state} />
      <Toast result={local} />
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
