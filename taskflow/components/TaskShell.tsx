"use client";

import { useActionState, useId, useState } from "react";
import { applyBreakdown, discardProposal, updateTaskDetails } from "@/app/actions";
import { fmtDate, fmtDur } from "@/lib/date";
import { TASK_KINDS, type Task, type TaskKind } from "@/lib/types";
import { Prep, Replan } from "./TaskPlanning";
import { TimerChip, TimerControls } from "./Timer";

type Step = { title: string; date: string; minutes: number };

export const KIND_LABEL: Record<TaskKind, string> = {
  assignment: "Tarea",
  quiz: "Quiz",
  midterm: "Midterm",
  final: "Final",
  project: "Proyecto",
  presentation: "Presentación",
  reading: "Lectura",
  other: "Otro",
};

/**
 * Una tarea con su panel de detalles.
 *
 * El "⋯" abre, DEBAJO de la fila, lo que no cabe en ella: tipo, curso, peso en
 * la nota, dificultad y estimado, más las acciones (partir en pasos con
 * Claude). Va debajo y no en un modal: en el celular un modal tapa justo la
 * lista que estás ordenando.
 *
 * Envuelve la fila entera porque el panel tiene que salir debajo, no dentro:
 * `.task` es una fila flex y meterle un bloque la rompe.
 */
export function TaskShell({
  task,
  today,
  canSplit,
  prep,
  ai,
  defaultOpen = false,
  children,
}: {
  task: Task;
  today: string;
  /** Hay Claude y la tarea tiene margen para repartir pasos. */
  canSplit: boolean;
  /** Tiempo total sugerido si la tarea admite plan de preparación; null si no. */
  prep: number | null;
  /** Hay Claude configurado. */
  ai: boolean;
  /** Abierta al cargar: la que se eligió en la paleta (⌘K). */
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const panelId = useId();
  const [open, setOpen] = useState(defaultOpen);

  return (
    <>
      <div
        id={"t-" + task.id}
        className={"task" + (task.done ? " done" : "") + (open ? " open" : "") + (task.track_started_at ? " running" : "")}
      >
        {children}
        {task.track_started_at ? <TimerChip task={task} /> : null}
        <button
          className="xbtn more"
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={open ? `Cerrar detalles de «${task.title}»` : `Detalles de «${task.title}»`}
          title="Detalles"
          onClick={() => setOpen((o) => !o)}
        >
          ⋯
        </button>
      </div>
      {open ? (
        <div className="taskpanel" id={panelId}>
          {!task.done ? <TimerControls task={task} /> : null}
          <Details task={task} />
          {!task.done ? (
            <div className="taskacts row">
              <Replan task={task} today={today} />
              {prep != null ? <Prep task={task} today={today} suggested={prep} ai={ai} /> : null}
            </div>
          ) : null}
          {canSplit ? <Split task={task} today={today} /> : null}
        </div>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------- detalles */

function Details({ task }: { task: Task }) {
  const [state, save, pending] = useActionState(updateTaskDetails, null);
  const id = (k: string) => `${task.id}-${k}`;
  return (
    <form action={save} className="details">
      <input type="hidden" name="id" value={task.id} />
      <div className="field">
        <label htmlFor={id("kind")}>Tipo</label>
        <select id={id("kind")} name="kind" defaultValue={task.kind ?? ""}>
          <option value="">—</option>
          {TASK_KINDS.map((k) => (
            <option key={k} value={k}>{KIND_LABEL[k]}</option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor={id("course")}>Curso</label>
        <input id={id("course")} name="course" list="tf-courses" maxLength={80} defaultValue={task.course ?? ""} placeholder="ECON 342" />
      </div>

      <div className="field">
        <label htmlFor={id("weight")}>% de la nota</label>
        <input
          id={id("weight")} name="weight_pct" type="number" inputMode="decimal" min={0} max={100} step={0.5}
          defaultValue={task.weight_pct ?? ""} placeholder="—"
        />
      </div>

      <div className="field">
        <label htmlFor={id("difficulty")}>Dificultad</label>
        <select id={id("difficulty")} name="difficulty" defaultValue={task.difficulty ?? ""}>
          <option value="">—</option>
          <option value="1">Baja</option>
          <option value="2">Media</option>
          <option value="3">Alta</option>
        </select>
      </div>

      <div className="field">
        <label htmlFor={id("est")}>Tiempo total (min)</label>
        <input
          id={id("est")} name="est_minutes" type="number" inputMode="numeric" min={1} max={1440} step={5}
          defaultValue={task.est_minutes ?? ""} placeholder="—"
        />
      </div>

      <div className="detailsfoot">
        <button className="btn sm" type="submit" disabled={pending}>{pending ? "Guardando…" : "Guardar"}</button>
        <span className={"runmsg" + (state && !state.ok ? " bad" : "")} role="status" aria-live="polite">
          {pending ? "" : state?.message}
        </span>
      </div>
    </form>
  );
}

/* ------------------------------------------------- partir con Claude */

function Split({ task, today }: { task: Task; today: string }) {
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
    <div className="taskacts">
      {!steps ? (
        <button className="btn line sm" onClick={pedir} disabled={cargando} type="button">
          {cargando ? "Pensando…" : "Partir en pasos con Claude"}
        </button>
      ) : null}

      {error ? <p className="plannererr" role="alert">{error}</p> : null}
      {guardado && !guardado.ok ? <p className="plannererr" role="alert">{guardado.message}</p> : null}
      {guardado?.ok && !steps ? <p className="runmsg" role="status">{guardado.message}</p> : null}

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
              <input type="hidden" name="parent" value={task.title} />
              <button className="btn sm" disabled={guardando} type="submit">
                {guardando ? "Guardando…" : "Agregar"}
              </button>
            </form>
            <button
              className="btn ghost sm"
              onClick={() => {
                setSteps(null);
                void discardProposal("breakdown", task.title).catch(() => {});
              }}
              type="button"
            >
              Descartar
            </button>
            <span className="plancost mono" title="Lo que costó esta llamada a la API">
              ${costo < 0.01 ? costo.toFixed(4) : costo.toFixed(3)}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
