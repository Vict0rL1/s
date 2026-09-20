"use client";

import { useActionState, useState } from "react";
import { applyBreakdown } from "@/app/actions";
import { fmtDate, fmtDur } from "@/lib/date";
import type { Task } from "@/lib/types";

type Step = { title: string; date: string; minutes: number };

/**
 * El botón de partir una tarea y su propuesta.
 *
 * Envuelve la fila entera porque el panel tiene que salir DEBAJO, no dentro:
 * `.task` es una fila flex y meterle un bloque la rompe. Devuelve un fragmento,
 * así que no añade ningún nodo extra al DOM cuando no hay propuesta.
 *
 * Sólo aparece en tareas con fecha futura: sin fecha no hay entre qué repartir
 * los pasos, y un botón que siempre da error es peor que no tenerlo.
 */
export function TaskSplit({
  task,
  today,
  children,
}: {
  task: Task;
  today: string;
  children: React.ReactNode;
}) {
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [nota, setNota] = useState("");
  const [costo, setCosto] = useState(0);
  const [error, setError] = useState("");
  const [cargando, setCargando] = useState(false);
  const [guardado, guardar, guardando] = useActionState(applyBreakdown, null);
  const [visto, setVisto] = useState<typeof guardado>(null);

  if (guardado !== visto) {
    setVisto(guardado);
    if (guardado?.ok && steps) setSteps(null);
  }

  async function pedir() {
    setCargando(true);
    setError("");
    setSteps(null);
    try {
      const r = await fetch("/api/breakdown", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId: task.id }),
      });
      const data = await r.json();
      if (!data.ok) setError(data.message || "No se pudieron armar los pasos");
      else {
        setSteps(data.steps);
        setNota(data.note ?? "");
        setCosto(data.costUsd ?? 0);
      }
    } catch {
      setError("No se pudo hablar con el servidor");
    } finally {
      setCargando(false);
    }
  }

  return (
    <>
      <div className={"task" + (task.done ? " done" : "")}>
        {children}
        <button
          className="xbtn split"
          onClick={pedir}
          disabled={cargando}
          type="button"
          title="Partir en pasos con fecha"
          aria-label="Partir en pasos"
        >
          {cargando ? "…" : "⋮⋮"}
        </button>
      </div>

      {error ? <p className="plannererr splitmsg">{error}</p> : null}
      {guardado && !guardado.ok ? <p className="plannererr splitmsg">{guardado.message}</p> : null}

      {steps ? (
        <div className="planbox splitbox">
          <div className="planhead">
            <span className="eyebrow">Pasos propuestos</span>
            <span className="sub">
              {steps.length} · {fmtDur(steps.reduce((a, s) => a + s.minutes, 0))}
            </span>
          </div>

          <ol className="planlist">
            {steps.map((s, i) => (
              <li key={i} className="planrow">
                <span className="mono">{fmtDate(s.date, today)}</span>
                <span className="plantitle">{s.title}</span>
                <span className="mono planmin">{s.minutes}m</span>
              </li>
            ))}
          </ol>

          {nota ? <p className="plannote">{nota}</p> : null}

          <div className="planfoot">
            <form action={guardar}>
              <input type="hidden" name="steps" value={JSON.stringify(steps)} />
              <input type="hidden" name="area" value={task.area ?? ""} />
              <button className="btn sm" disabled={guardando} type="submit">
                {guardando ? "Guardando…" : "Agregar"}
              </button>
            </form>
            <button className="btn ghost sm" onClick={() => setSteps(null)} type="button">
              Descartar
            </button>
            <span className="plancost mono" title="Lo que costó esta llamada a la API">
              ${costo < 0.01 ? costo.toFixed(4) : costo.toFixed(3)}
            </span>
          </div>
        </div>
      ) : null}
    </>
  );
}
