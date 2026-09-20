import { toggleHabit } from "@/app/actions";
import { didHabit, lastDays, streak } from "@/lib/habits";
import { weekdayOf } from "@/lib/date";
import type { Habit } from "@/lib/types";
import { ActionButton } from "./ActionButton";
import { deleteHabit } from "@/app/actions";

function Dots({
  habit,
  log,
  today,
  days,
}: {
  habit: Habit;
  log: Map<string, Set<string>>;
  today: string;
  days: number;
}) {
  return (
    <span className="dots">
      {lastDays(today, days).map((d) => {
        const scheduled = !habit.days?.length || habit.days.includes(weekdayOf(d));
        const on = didHabit(log, d, habit.id);
        return (
          <span
            key={d}
            className={"dot" + (on ? " on" : scheduled ? "" : " skip") + (d === today ? " today" : "")}
            title={d}
          />
        );
      })}
    </span>
  );
}

/** Fila compacta, la de la vista Hoy. */
export function HabitRow({
  habit,
  log,
  today,
}: {
  habit: Habit;
  log: Map<string, Set<string>>;
  today: string;
}) {
  const done = didHabit(log, today, habit.id);
  const st = streak(habit, log, today);

  return (
    <div className="hrow">
      <form action={toggleHabit} className="inline">
        <input type="hidden" name="id" value={habit.id} />
        <input type="hidden" name="day" value={today} />
        <button type="submit" className="chk" aria-pressed={done} aria-label={"Marcar " + habit.name}>
          ✓
        </button>
      </form>

      <span className="hname">{habit.name}</span>
      <Dots habit={habit} log={log} today={today} days={7} />
      <span className={"streak" + (st > 0 ? " on" : "")}>{st > 0 ? st + " d" : "—"}</span>
    </div>
  );
}

/** Fila ancha, la de la vista Rutinas: 30 días y el total del mes. */
export function HabitRowWide({
  habit,
  log,
  today,
}: {
  habit: Habit;
  log: Map<string, Set<string>>;
  today: string;
}) {
  const done = didHabit(log, today, habit.id);
  const st = streak(habit, log, today);
  const window = lastDays(today, 30);
  const hits = window.filter((d) => didHabit(log, d, habit.id)).length;
  const scheduled = window.filter(
    (d) => !habit.days?.length || habit.days.includes(weekdayOf(d)),
  ).length;

  return (
    <div className="hrow wide">
      <form action={toggleHabit} className="inline">
        <input type="hidden" name="id" value={habit.id} />
        <input type="hidden" name="day" value={today} />
        <button type="submit" className="chk" aria-pressed={done} aria-label={"Marcar " + habit.name}>
          ✓
        </button>
      </form>

      <div className="hname">
        <b style={{ fontWeight: 600 }}>{habit.name}</b>
        <Dots habit={habit} log={log} today={today} days={30} />
        <span className="streak">
          {hits}/{scheduled} en 30 d · racha {st} d
        </span>
      </div>

      <ActionButton action={deleteHabit} id={habit.id} className="xbtn" label="Eliminar rutina">
        ×
      </ActionButton>
    </div>
  );
}
