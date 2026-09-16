"use client";

import { useActionState, useState } from "react";
import { applyPlan } from "@/app/actions";
import { minsToHHMM } from "@/lib/date";

type PlannedBlock = {
  start: number;
  end: number;
  title: string;
  kind: "tarea" | "descanso";
  taskId: string | null;
};

type Plan = { blocks: PlannedBlock[]; note: string; costUsd: number };

/**
 * El botón de "Planear mi día" y su propuesta.
 *
 * El patrón es el de Sunsama y compañía: la máquina propone, tú decides. Nada
 * se escribe hasta que le das a aceptar, y lo que ya tenías en la agenda no se
 * toca — los bloques nuevos se suman.
 *
 * Es deliberado que la propuesta se vea con las horas y los huecos, en vez de
 * aplicarse sola: una sugerencia que puedes rechazar en dos segundos se usa;
 * una que te reescribe el día, se desinstala.
 */
export function DayPlanner() {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState("");
  const [cargando, setCargando] = useState(false);
  const [guardado, guardar, guardando] = useActionState(applyPlan, null);
  const [visto, setVisto] = useState<typeof guardado>(null);

  // Guardado con éxito: la propuesta ya es parte de la agenda, sobra en
  // pantalla. Se compara contra el último resultado ya atendido — si sólo
  // mirara `guardado.ok`, seguiría siendo cierto para siempre y borraría al
  // instante el SIGUIENTE plan que pidieras.
  if (guardado !== visto) {
    setVisto(guardado);
    if (guardado?.ok && plan) setPlan(null);
  }

  async function pedir() {
    setCargando(true);
    setError("");
    setPlan(null);
    try {
      const r = await fetch("/api/plan", { method: "POST" });
      const data = await r.json();
      if (!data.ok) setError(data.message || "No se pudo armar el plan");
      else setPlan({ blocks: data.blocks, note: data.note, costUsd: data.costUsd });
    } catch {
      setError("No se pudo hablar con el servidor");
    } finally {
      setCargando(false);
    }
  }

  const total = plan?.blocks.reduce((a, b) => a + (b.end - b.start), 0) ?? 0;

  return (
    <div className="planner">
      {!plan ? (
        <button className="btn line sm" onClick={pedir} disabled={cargando} type="button">
          {cargando ? "Pensando…" : "Planear mi día"}
        </button>
      ) : null}

      {error ? <p className="plannererr">{error}</p> : null}

      {plan ? (
        <div className="planbox">
          <div className="planhead">
            <span className="eyebrow">Propuesta</span>
            <span className="sub">
              {plan.blocks.length} bloques · {Math.round(total / 60 * 10) / 10} h
            </span>
          </div>

          <ol className="planlist">
            {plan.blocks.map((b, i) => (
              <li key={i} className={b.kind === "descanso" ? "planrow rest" : "planrow"}>
                <span className="mono">
                  {minsToHHMM(b.start)}–{minsToHHMM(b.end)}
                </span>
                <span className="plantitle">{b.title}</span>
                <span className="mono planmin">{b.end - b.start}m</span>
              </li>
            ))}
          </ol>

          {plan.note ? <p className="plannote">{plan.note}</p> : null}

          <div className="planfoot">
            <form action={guardar}>
              <input type="hidden" name="plan" value={JSON.stringify(plan.blocks)} />
              <button className="btn sm" disabled={guardando} type="submit">
                {guardando ? "Guardando…" : "Agendar"}
              </button>
            </form>
            <button className="btn ghost sm" onClick={() => setPlan(null)} type="button">
              Descartar
            </button>
            {/* El costo se enseña siempre. Es dinero real y es de quien paga la
                key saber cuánto se va en cada botón. */}
            <span className="plancost mono" title="Lo que costó esta llamada a la API">
              ${plan.costUsd < 0.01 ? plan.costUsd.toFixed(4) : plan.costUsd.toFixed(3)}
            </span>
          </div>
        </div>
      ) : null}

      {guardado && !guardado.ok ? <p className="plannererr">{guardado.message}</p> : null}
    </div>
  );
}
