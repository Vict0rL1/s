import { deleteHabit, pauseHabit, resumeHabit, toggleHabit } from "@/app/actions";
import { compliance, didHabit, lastDays, pctText, streak, type Compliance } from "@/lib/habits";
import { weekdayOf } from "@/lib/date";
import type { Habit } from "@/lib/types";
import { ActionButton } from "./ActionButton";
import { HabitSettings } from "./HabitSettings";

type RowProps = {
  habit: Habit;
  log: Map<string, Set<string>>;
  today: string;
  /** Desde cuándo cuenta (ver `habitSince`): lo de antes no se pinta como fallado. */
  since: string;
};

function Dots({ habit, log, today, days, since }: RowProps & { days: number }) {
  return (
    <span className="dots">
      {lastDays(today, days).map((d) => {
        const scheduled = !habit.days?.length || habit.days.includes(weekdayOf(d));
        const on = didHabit(log, d, habit.id);
        const cls = on ? " on" : d < since ? " pre" : scheduled ? "" : " skip";
        return <span key={d} className={"dot" + cls + (d === today ? " today" : "")} title={d} />;
      })}
    </span>
  );
}

function Check({ habit, today, done }: { habit: Habit; today: string; done: boolean }) {
  return (
    <form action={toggleHabit} className="inline">
      <input type="hidden" name="id" value={habit.id} />
      <input type="hidden" name="day" value={today} />
      <button type="submit" className="chk" aria-pressed={done} aria-label={"Marcar " + habit.name}>
        ✓
      </button>
    </form>
  );
}

/** Fila compacta, la de la vista Hoy. La racha sólo si la rutina la quiere. */
export function HabitRow(props: RowProps) {
  const { habit, log, today } = props;
  const done = didHabit(log, today, habit.id);
  const st = habit.show_streak !== false ? streak(habit, log, today) : null;

  return (
    <div className="hrow">
      <Check habit={habit} today={today} done={done} />
      <span className="hname">{habit.name}</span>
      <Dots {...props} days={7} />
      {st != null ? <span className={"streak" + (st > 0 ? " on" : "")}>{st > 0 ? st + " d" : "—"}</span> : <span className="streak" />}
    </div>
  );
}

const veces = (c: Compliance) => (c.scheduled ? `${c.done} de ${c.scheduled} días en que tocaba` : "Todavía no tocó ningún día");

/**
 * Fila ancha, la de la vista Rutinas: 30 días, el cumplimiento de 7 y de 30,
 * y la racha si está activada. Sin puntos, insignias ni colores de reproche:
 * un día sin hacer es un cuadro gris, no rojo.
 */
export function HabitRowWide(props: RowProps) {
  const { habit, log, today, since } = props;
  const done = didHabit(log, today, habit.id);
  const c7 = compliance(habit, log, today, 7, since);
  const c30 = compliance(habit, log, today, 30, since);
  const st = habit.show_streak !== false ? streak(habit, log, today) : null;

  return (
    <div className="hrow wide">
      <Check habit={habit} today={today} done={done} />

      <div className="hname">
        <b style={{ fontWeight: 600 }}>{habit.name}</b>
        <Dots {...props} days={30} />
        <span className="streak">
          <span title={veces(c7)}>7 días: {pctText(c7)}</span>
          {" · "}
          <span title={veces(c30)}>30 días: {pctText(c30)}</span>
          {st != null ? ` · racha ${st} d` : null}
        </span>
      </div>

      <div className="hacts">
        <HabitSettings habit={habit} />
        <ActionButton action={pauseHabit} id={habit.id} className="btn line sm" title="Sale de Hoy; el historial queda">
          Pausar
        </ActionButton>
      </div>
    </div>
  );
}

/** Una rutina en pausa: se reanuda o, ahora sí, se borra con su historial. */
export function PausedHabitRow({ habit }: { habit: Habit }) {
  return (
    <div className="hrow">
      <span className="hname">{habit.name}</span>
      <ActionButton action={resumeHabit} id={habit.id} className="btn line sm">
        Reanudar
      </ActionButton>
      <ActionButton action={deleteHabit} id={habit.id} className="btn line sm" label={`Borrar ${habit.name} y su historial`}>
        Borrar
      </ActionButton>
    </div>
  );
}
