import { deleteTask, toggleTask } from "@/app/actions";
import { daysBetween, fmtDur, fmtDate, minsToHHMM, timeToMins } from "@/lib/date";
import { plannerConfigured } from "@/lib/env.server";
import type { Task } from "@/lib/types";
import { ActionButton } from "./ActionButton";
import { FocusButton } from "./FocusButton";
import { TaskSplit } from "./TaskSplit";
import { TaskTitle } from "./TaskTitle";

export function TaskPills({ task, today }: { task: Task; today: string }) {
  const min = timeToMins(task.due_time);
  const bits: React.ReactNode[] = [];

  if (task.area) bits.push(<span key="a" className="pill area">{task.area}</span>);

  if (task.due_date) {
    const d = daysBetween(today, task.due_date);
    const kind = d < 0 ? "late" : d <= 1 ? "soon" : "";
    bits.push(
      <span key="d" className={"pill " + kind}>
        {fmtDate(task.due_date, today)}
        {min != null ? " " + minsToHHMM(min) : ""}
      </span>,
    );
  }

  if (task.est_minutes) bits.push(<span key="e" className="pill est">{fmtDur(task.est_minutes)}</span>);

  if (!bits.length) return null;
  return <div className="tmeta">{bits}</div>;
}

/**
 * Cuántos días de margen hacen falta para que partir la tarea signifique algo.
 * Con menos, los pasos se amontonan en uno o dos días y el resultado es la
 * misma pared con más filas.
 */
const MIN_DIAS_PARA_PARTIR = 3;

export function TaskRow({ task, today }: { task: Task; today: string }) {
  const focused = task.focus_day === today;

  const partible =
    plannerConfigured() &&
    !task.done &&
    !!task.due_date &&
    daysBetween(today, task.due_date) >= MIN_DIAS_PARA_PARTIR;

  const contenido = (
    <>
      <div className={"prio p" + (task.priority ?? 0)} />

      <ActionButton
        action={toggleTask}
        id={task.id}
        className="chk"
        label={task.done ? "Desmarcar" : "Completar"}
      >
        ✓
      </ActionButton>

      <div className="tmain">
        <TaskTitle id={task.id} title={task.title} />
        <TaskPills task={task} today={today} />
      </div>

      <FocusButton id={task.id} focused={focused} />

      <ActionButton action={deleteTask} id={task.id} className="xbtn" label="Eliminar">
        ×
      </ActionButton>
    </>
  );

  // `TaskSplit` aporta el botón y el panel de la propuesta, y tiene que envolver
  // la fila porque el panel va debajo, no dentro. Sin él, la fila es la de
  // siempre y no se manda nada de más al navegador.
  if (partible) {
    return (
      <TaskSplit task={task} today={today}>
        {contenido}
      </TaskSplit>
    );
  }

  return <div className={"task" + (task.done ? " done" : "")}>{contenido}</div>;
}

export function TaskGroup({
  title,
  list,
  today,
  danger,
}: {
  title: string;
  list: Task[];
  today: string;
  danger?: boolean;
}) {
  if (!list.length) return null;
  return (
    <div className={"tgroup" + (danger ? " danger" : "")}>
      <h3>
        {title} <em>{list.length}</em>
      </h3>
      {list.map((t) => (
        <TaskRow key={t.id} task={t} today={today} />
      ))}
    </div>
  );
}

export function EmptyBox({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="empty">
      <b>{title}</b>
      {sub}
    </div>
  );
}

export function ViewHead({
  eyebrow,
  title,
  right,
}: {
  eyebrow: string;
  title: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="viewhead">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
      </div>
      <div className="row">{right}</div>
    </div>
  );
}
