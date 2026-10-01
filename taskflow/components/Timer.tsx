"use client";

import { useActionState, useEffect, useState } from "react";
import { finishTimer, pauseTimer, startTimer } from "@/app/actions";
import { fmtClockSec, trackedTotal } from "@/lib/timing";

type T = { id: string; title: string; tracked_sec: number; track_sessions: number; track_started_at: string | null; est_minutes: number | null };

/** Los segundos que lleva, actualizados cada segundo sólo mientras corre. */
function useElapsed(t: Pick<T, "tracked_sec" | "track_started_at">) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    // La primera lectura del reloj también va en un efecto: en el render, el
    // servidor y el navegador darían horas distintas y React se quejaría.
    const tick = () => setNow(Date.now());
    tick();
    if (!t.track_started_at) return;
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [t.track_started_at]);
  return now == null ? t.tracked_sec : trackedTotal(t, now);
}

/**
 * Empezar / Pausar / Terminar. Dice cuánto llevas y, si estimaste, contra qué.
 */
export function TimerControls({ task }: { task: T }) {
  const sec = useElapsed(task);
  const corriendo = Boolean(task.track_started_at);
  const [r1, empezar, p1] = useActionState(startTimer, null);
  const [r2, pausar, p2] = useActionState(pauseTimer, null);
  const [r3, terminar, p3] = useActionState(finishTimer, null);
  const ultimo = [r1, r2, r3].filter(Boolean).at(-1);
  const ocupado = p1 || p2 || p3;

  return (
    <div className="timer">
      <span className={"timerclock mono" + (corriendo ? " on" : "")} aria-live="off">
        {corriendo ? <i aria-hidden="true" /> : null}
        {fmtClockSec(sec)}
        {task.est_minutes ? <small> / {task.est_minutes} min estimados</small> : null}
        {task.track_sessions ? <small> · {task.track_sessions} sesión{task.track_sessions > 1 ? "es" : ""}</small> : null}
      </span>
      {corriendo ? (
        <form action={pausar}>
          <input type="hidden" name="id" value={task.id} />
          <button className="btn line sm" type="submit" disabled={ocupado}>Pausar</button>
        </form>
      ) : (
        <form action={empezar}>
          <input type="hidden" name="id" value={task.id} />
          <button className="btn line sm" type="submit" disabled={ocupado}>Empezar</button>
        </form>
      )}
      <form action={terminar}>
        <input type="hidden" name="id" value={task.id} />
        <button className="btn sm" type="submit" disabled={ocupado}>Terminar</button>
      </form>
      {ultimo ? <span className={"runmsg" + (ultimo.ok ? "" : " bad")} role="status">{ultimo.message}</span> : null}
    </div>
  );
}

/** La marca de "en marcha" dentro de la fila, con el tiempo corriendo. */
export function TimerChip({ task }: { task: Pick<T, "tracked_sec" | "track_started_at" | "title"> }) {
  const sec = useElapsed(task);
  return (
    <span className="timerchip mono" title={`«${task.title}» en marcha`}>
      <i aria-hidden="true" />
      <span className="sr">En marcha: </span>
      {fmtClockSec(sec)}
    </span>
  );
}
