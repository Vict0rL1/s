"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { syncCanvasNow } from "@/app/actions";
import { fold } from "@/lib/search-query";

type Results = {
  tasks: { id: string; title: string; due_date: string | null; course: string | null; done: boolean }[];
  notes: { id: string; excerpt: string }[];
  courses: string[];
  habits: { id: string; name: string }[];
};

/** Datos, no funciones: lo que hace cada ítem se decide en `ejecutar`. */
type Item = { id: string; group: string; label: string; hint?: string; href?: string; action?: "tarea" | "nota" | "canvas" };

/** Pide a la barra de captura que se enfoque en ese modo (la escucha `Capture`). */
function capture(mode: "tarea" | "nota") {
  window.dispatchEvent(new CustomEvent("taskflow:capture", { detail: { mode } }));
}

/**
 * La paleta de comandos: ⌘K / Ctrl+K (o el botón "Buscar" en el celular).
 *
 * Busca tareas, notas, cursos y rutinas mientras escribes, y tiene a mano las
 * acciones de siempre. Todo con teclado: flechas para moverte, Enter para
 * ejecutar, Escape para cerrar. Es un `<dialog>` nativo: el navegador ya
 * resuelve el foco y el Escape, sin una librería encima.
 */
export function CommandPalette({ canvas, planner }: { canvas: boolean; planner: boolean }) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const previo = useRef<HTMLElement | null>(null);
  const [q, setQ] = useState("");
  const [res, setRes] = useState<Results | null>(null);
  const [activo, setActivo] = useState(0);
  const [msg, setMsg] = useState("");
  const [buscando, setBuscando] = useState(false);

  const abrir = useCallback(() => {
    const d = dialog.current;
    if (!d || d.open) return;
    previo.current = document.activeElement as HTMLElement | null;
    setQ("");
    setRes(null);
    setMsg("");
    setActivo(0);
    d.showModal();
    input.current?.focus();
  }, []);

  const cerrar = useCallback(() => dialog.current?.close(), []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (dialog.current?.open) cerrar();
        else abrir();
      }
    }
    const onOpen = () => abrir();
    document.addEventListener("keydown", onKey);
    window.addEventListener("taskflow:palette", onOpen);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("taskflow:palette", onOpen);
    };
  }, [abrir, cerrar]);

  // Búsqueda mientras escribes, con un respiro de 150 ms y cancelando la
  // anterior: escribir rápido no dispara una petición por letra.
  useEffect(() => {
    const t = q.trim();
    if (t.length < 2) return;
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      setBuscando(true);
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(t)}`, { signal: ctrl.signal });
        if (r.ok) setRes(await r.json());
      } catch {
        /* cancelada o sin red: se queda lo de antes */
      } finally {
        if (!ctrl.signal.aborted) setBuscando(false);
      }
    }, 150);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [q]);

  async function ejecutar(it: Item) {
    if (it.href) {
      cerrar();
      router.push(it.href);
    } else if (it.action === "tarea" || it.action === "nota") {
      cerrar();
      capture(it.action);
    } else if (it.action === "canvas") {
      setMsg("Sincronizando Canvas…");
      const r = await syncCanvasNow();
      setMsg(r.message || (r.ok ? "Listo" : "Falló"));
      router.refresh();
    }
  }

  const acciones: Item[] = [
    { id: "a-tarea", group: "Acciones", label: "Nueva tarea", action: "tarea" },
    { id: "a-nota", group: "Acciones", label: "Nueva nota", action: "nota" },
    ...(planner ? [{ id: "a-plan", group: "Acciones", label: "Planear mi día", hint: "Hoy", href: "/hoy#planear" }] : []),
    ...(canvas ? [{ id: "a-canvas", group: "Acciones", label: "Sincronizar Canvas", action: "canvas" as const }] : []),
    { id: "v-hoy", group: "Ir a", label: "Hoy", href: "/hoy" },
    { id: "v-semana", group: "Ir a", label: "Semana", href: "/semana" },
    { id: "v-tareas", group: "Ir a", label: "Tareas", href: "/tareas" },
    { id: "v-notas", group: "Ir a", label: "Notas", href: "/notas" },
    { id: "v-rutinas", group: "Ir a", label: "Rutinas", href: "/rutinas" },
    { id: "v-ajustes", group: "Ir a", label: "Ajustes", href: "/ajustes" },
    { id: "v-estado", group: "Ir a", label: "Estado del sistema", href: "/ajustes/estado" },
    { id: "v-actividad", group: "Ir a", label: "Actividad", href: "/ajustes/actividad" },
    { id: "v-papelera", group: "Ir a", label: "Papelera", href: "/ajustes/papelera" },
  ];

  const f = fold(q.trim());
  const usar = q.trim().length >= 2 ? res : null;
  const items: Item[] = [
    ...acciones.filter((a) => !f || fold(a.label).includes(f) || fold(a.group).includes(f)),
    ...(usar?.tasks ?? []).map((t) => ({
      id: "t-" + t.id, group: "Tareas", label: t.title,
      hint: [t.course, t.due_date, t.done ? "hecha" : null].filter(Boolean).join(" · "),
      href: `/tareas?t=${t.id}#t-${t.id}`,
    })),
    ...(usar?.notes ?? []).map((n) => ({ id: "n-" + n.id, group: "Notas", label: n.excerpt, href: `/notas#n-${n.id}` })),
    ...(usar?.courses ?? []).map((c) => ({ id: "c-" + c, group: "Cursos", label: c, href: `/tareas?curso=${encodeURIComponent(c)}` })),
    ...(usar?.habits ?? []).map((h) => ({ id: "h-" + h.id, group: "Rutinas", label: h.name, href: "/rutinas" })),
  ];
  const sel = Math.min(activo, Math.max(0, items.length - 1));

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActivo((sel + 1) % Math.max(1, items.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActivo((sel - 1 + items.length) % Math.max(1, items.length));
    } else if (e.key === "Enter" && items[sel]) {
      e.preventDefault();
      void ejecutar(items[sel]);
    }
  }

  // Al cerrar, el foco vuelve a donde estaba.
  useEffect(() => {
    const d = dialog.current;
    const onClose = () => previo.current?.focus?.();
    d?.addEventListener("close", onClose);
    return () => d?.removeEventListener("close", onClose);
  }, []);

  useEffect(() => {
    document.getElementById(`pal-${sel}`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  let grupo = "";
  return (
    <dialog
      ref={dialog}
      className="palette"
      aria-label="Buscar y comandos"
      onClick={(e) => {
        // Un clic en el fondo (fuera de la caja) cierra.
        if (e.target === dialog.current) cerrar();
      }}
    >
      <div className="palbox">
        <input
          ref={input}
          className="palinput"
          type="text"
          role="combobox"
          aria-expanded={items.length > 0}
          aria-controls="pal-list"
          aria-activedescendant={items[sel] ? `pal-${sel}` : undefined}
          aria-autocomplete="list"
          aria-label="Buscar tareas, notas, cursos o un comando"
          placeholder="Busca tareas, notas, cursos… o escribe un comando"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActivo(0);
            if (e.target.value.trim().length < 2) setRes(null);
          }}
          onKeyDown={onKeyDown}
          autoComplete="off"
        />
        {msg ? <p className="palmsg" role="status">{msg}</p> : null}
        <ul id="pal-list" role="listbox" className="pallist" aria-label="Resultados">
          {items.map((it, i) => {
            const cabecera = it.group !== grupo ? (grupo = it.group) : null;
            return (
              <li key={it.id} role="presentation">
                {cabecera ? <span className="palgroup" aria-hidden="true">{cabecera}</span> : null}
                <div
                  id={`pal-${i}`}
                  role="option"
                  aria-selected={i === sel}
                  className="palitem"
                  onMouseMove={() => setActivo(i)}
                  onClick={() => void ejecutar(it)}
                >
                  <span className="pallabel">{it.label}</span>
                  {it.hint ? <span className="palhint">{it.hint}</span> : null}
                </div>
              </li>
            );
          })}
          {q.trim().length >= 2 && !buscando && items.length === 0 ? (
            <li className="palempty" role="presentation">Nada con «{q.trim()}».</li>
          ) : null}
        </ul>
        <p className="palfoot" aria-hidden="true">↑↓ para moverte · Enter para abrir · Esc para cerrar</p>
      </div>
    </dialog>
  );
}
