"use client";

import { useActionState, useId, useState } from "react";
import { applyPrepPlan, applyReplan, discardProposal } from "@/app/actions";
import { fmtDate, fmtDur, minsToHHMM } from "@/lib/date";
import type { Task } from "@/lib/types";

/* ------------------------------------------------------ replanificar */

type Scope = "today" | "tomorrow" | "week" | "date" | "auto";
const SCOPES: [Scope, string][] = [
  ["today", "Hoy"],
  ["tomorrow", "Mañana"],
  ["week", "Esta semana"],
  ["date", "Elegir fecha"],
  ["auto", "Automático"],
];

type Slot = { day: string; start: number; end: number; why: string };

/**
 * Replanificar: elegir CUÁNDO trabajar en la tarea. Busca un hueco libre de
 * verdad (lib/schedule.ts), lo muestra, y sólo lo agenda si aceptas. Nunca
 * borra ni mueve lo que ya tienes.
 */
export function Replan({ task, today }: { task: Task; today: string }) {
  const gid = useId();
  const [abierto, setAbierto] = useState(false);
  const [scope, setScope] = useState<Scope>("auto");
  const [fecha, setFecha] = useState("");
  const [minutos, setMinutos] = useState(Math.min(240, task.est_minutes ?? 60));
  const [buscando, setBuscando] = useState(false);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [aviso, setAviso] = useState("");
  const [atrasada, setAtrasada] = useState(false);
  const [mover, setMover] = useState(task.source === "manual" && Boolean(task.due_date && task.due_date < today));
  const [guardado, guardar, guardando] = useActionState(applyReplan, null);
  const [visto, setVisto] = useState<typeof guardado>(null);

  if (guardado !== visto) {
    setVisto(guardado);
    if (guardado?.ok) setSlot(null);
  }

  async function buscar() {
    setBuscando(true);
    setAviso("");
    setSlot(null);
    try {
      const r = await fetch("/api/replan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId: task.id, scope, date: fecha || undefined, minutes: minutos }),
      });
      const data = await r.json();
      if (!data.ok) setAviso(data.message || "No se pudo buscar");
      else {
        setSlot(data.slot);
        setAtrasada(Boolean(data.overdue));
        if (!data.slot) setAviso(data.message);
      }
    } catch {
      setAviso("No se pudo hablar con el servidor");
    } finally {
      setBuscando(false);
    }
  }

  if (!abierto) {
    return (
      <button className="btn line sm" type="button" onClick={() => setAbierto(true)}>
        Replanificar
      </button>
    );
  }

  return (
    <section className="planner-sub" aria-label="Replanificar">
      <div className="seg wrap" role="group" aria-label="Cuándo">
        {SCOPES.map(([k, label]) => (
          <button key={k} type="button" aria-pressed={scope === k} onClick={() => setScope(k)}>
            {label}
          </button>
        ))}
      </div>
      <div className="inlinefields">
        {scope === "date" ? (
          <span className="field">
            <label htmlFor={gid + "f"}>Día</label>
            <input id={gid + "f"} type="date" min={today} max={task.due_date && task.due_date >= today ? task.due_date : undefined}
              value={fecha} onChange={(e) => setFecha(e.target.value)} />
          </span>
        ) : null}
        <span className="field">
          <label htmlFor={gid + "m"}>Duración (min)</label>
          <input id={gid + "m"} type="number" min={15} max={240} step={15} value={minutos}
            onChange={(e) => setMinutos(Number(e.target.value))} />
        </span>
        <button className="btn sm" type="button" onClick={buscar} disabled={buscando || (scope === "date" && !fecha)}>
          {buscando ? "Buscando…" : "Buscar hueco"}
        </button>
      </div>

      {aviso ? <p className="runmsg bad" role="status">{aviso}</p> : null}
      {guardado?.ok && !slot ? <p className="runmsg" role="status">{guardado.message}</p> : null}
      {guardado && !guardado.ok ? <p className="runmsg bad" role="alert">{guardado.message}</p> : null}

      {slot ? (
        <div className="proposal">
          <p className="propline">
            <b>{fmtDate(slot.day, today)} · {minsToHHMM(slot.start)}–{minsToHHMM(slot.end)}</b>{" "}
            <span className="mono">({fmtDur(slot.end - slot.start)})</span>
          </p>
          <p className="propwhy">Por qué ahí: {slot.why}.</p>
          {atrasada ? <p className="propwhy">Ojo: esta tarea ya venció{task.due_date ? ` (${fmtDate(task.due_date, today)})` : ""}.</p> : null}
          <form action={guardar} className="propfoot">
            <input type="hidden" name="taskId" value={task.id} />
            <input type="hidden" name="day" value={slot.day} />
            <input type="hidden" name="start" value={slot.start} />
            <input type="hidden" name="end" value={slot.end} />
            {task.source === "manual" ? (
              <label className="check">
                <input type="checkbox" name="moveDate" value="1" checked={mover} onChange={(e) => setMover(e.target.checked)} />
                Mover también la fecha de la tarea a ese día
              </label>
            ) : (
              <span className="propwhy">La fecha de entrega la pone Canvas: esto sólo agenda el rato para trabajarla.</span>
            )}
            <button className="btn sm" type="submit" disabled={guardando}>{guardando ? "Agendando…" : "Agendar"}</button>
            <button className="btn ghost sm" type="button" onClick={() => setSlot(null)}>Descartar</button>
          </form>
        </div>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------ plan de preparación */

type Session = { day: string; start: number; end: number; minutes: number; why: string; review: boolean; title: string };

/**
 * Crear plan de preparación: sesiones repartidas entre hoy y el día antes del
 * deadline, en tus huecos de verdad. Claude, si lo pides, sólo les pone
 * nombre. Se ve todo (qué, cuándo, cuánto y por qué) antes de agendar.
 */
export function Prep({ task, today, suggested, ai }: { task: Task; today: string; suggested: number; ai: boolean }) {
  const gid = useId();
  const [abierto, setAbierto] = useState(false);
  const [total, setTotal] = useState(suggested);
  const [sesion, setSesion] = useState(60);
  const [conClaude, setConClaude] = useState(false);
  const [cargando, setCargando] = useState(false);
  const [plan, setPlan] = useState<{ sessions: Session[]; shortfall: number; costUsd: number; aiNote: string } | null>(null);
  const [aviso, setAviso] = useState("");
  const [guardado, guardar, guardando] = useActionState(applyPrepPlan, null);
  const [visto, setVisto] = useState<typeof guardado>(null);

  if (guardado !== visto) {
    setVisto(guardado);
    if (guardado?.ok) setPlan(null);
  }

  async function proponer() {
    setCargando(true);
    setAviso("");
    setPlan(null);
    try {
      const r = await fetch("/api/prep", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId: task.id, totalMin: total, sessionMin: sesion, ai: conClaude }),
      });
      const data = await r.json();
      if (!data.ok) setAviso(data.message || "No se pudo armar el plan");
      else setPlan({ sessions: data.sessions, shortfall: data.shortfall, costUsd: data.costUsd ?? 0, aiNote: data.aiNote ?? "" });
    } catch {
      setAviso("No se pudo hablar con el servidor");
    } finally {
      setCargando(false);
    }
  }

  if (!abierto) {
    return (
      <button className="btn line sm" type="button" onClick={() => setAbierto(true)}>
        Crear plan de preparación
      </button>
    );
  }

  const colocado = plan?.sessions.reduce((a, s) => a + s.minutes, 0) ?? 0;

  return (
    <section className="planner-sub" aria-label="Plan de preparación">
      <div className="inlinefields">
        <span className="field">
          <label htmlFor={gid + "t"}>Tiempo total (min)</label>
          <input id={gid + "t"} type="number" min={30} max={3000} step={30} value={total} onChange={(e) => setTotal(Number(e.target.value))} />
        </span>
        <span className="field">
          <label htmlFor={gid + "s"}>Sesiones de</label>
          <select id={gid + "s"} value={sesion} onChange={(e) => setSesion(Number(e.target.value))}>
            <option value={45}>45 min</option>
            <option value={60}>60 min</option>
            <option value={90}>90 min</option>
          </select>
        </span>
        {ai ? (
          <label className="check">
            <input type="checkbox" checked={conClaude} onChange={(e) => setConClaude(e.target.checked)} />
            Que Claude ponga nombre a cada sesión
          </label>
        ) : null}
        <button className="btn sm" type="button" onClick={proponer} disabled={cargando}>
          {cargando ? "Armando…" : "Proponer"}
        </button>
      </div>
      {!task.est_minutes ? (
        <p className="propwhy">El tiempo total es una sugerencia por el tipo de entrega: cámbialo si sabes cuánto te lleva.</p>
      ) : null}

      {aviso ? <p className="runmsg bad" role="status">{aviso}</p> : null}
      {guardado?.ok && !plan ? <p className="runmsg" role="status">{guardado.message}</p> : null}
      {guardado && !guardado.ok ? <p className="runmsg bad" role="alert">{guardado.message}</p> : null}

      {plan ? (
        <div className="planbox">
          <div className="planhead">
            <span className="eyebrow">Propuesta</span>
            <span className="sub">{plan.sessions.length} sesiones · {fmtDur(colocado)}</span>
          </div>
          {plan.sessions.length ? (
            <ol className="planlist">
              {plan.sessions.map((s, i) => (
                <li key={i} className={"planrow prep" + (s.review ? " rest" : "")}>
                  <span className="mono">{fmtDate(s.day, today)} {minsToHHMM(s.start)}–{minsToHHMM(s.end)}</span>
                  <span className="plantitle">
                    {s.title}
                    <small>{s.why}</small>
                  </span>
                  <span className="mono planmin">{s.minutes}m</span>
                </li>
              ))}
            </ol>
          ) : null}
          {plan.shortfall ? (
            <p className="plannererr">
              Faltan {fmtDur(plan.shortfall)}: no hay más huecos libres antes del {fmtDate(task.due_date, today)} sin pisar tus clases,
              otros deadlines o el día anterior.
            </p>
          ) : null}
          {plan.aiNote ? <p className="plannote">{plan.aiNote}</p> : null}
          <div className="planfoot">
            {plan.sessions.length ? (
              <form action={guardar}>
                <input type="hidden" name="taskId" value={task.id} />
                <input type="hidden" name="sessions" value={JSON.stringify(plan.sessions)} />
                <button className="btn sm" type="submit" disabled={guardando}>{guardando ? "Agendando…" : "Agendar todo"}</button>
              </form>
            ) : null}
            <button
              className="btn ghost sm"
              type="button"
              onClick={() => {
                setPlan(null);
                void discardProposal("prep", task.title).catch(() => {});
              }}
            >
              Descartar
            </button>
            {plan.costUsd ? (
              <span className="plancost mono" title="Lo que costó nombrar las sesiones">
                ${plan.costUsd < 0.01 ? plan.costUsd.toFixed(4) : plan.costUsd.toFixed(3)}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
