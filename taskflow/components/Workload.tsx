import { daysBetween, fmtDate } from "@/lib/date";
import type { Task } from "@/lib/types";
import { upcomingWorkload } from "@/lib/workload";
import { KIND_LABEL } from "./TaskShell";
import { MONTHS_SHORT, dayOfMonth, monthOf } from "@/lib/date";

/**
 * Cursos ya usados, para que el campo "Curso" los sugiera. Uno por página:
 * los inputs lo referencian por id.
 */
export function CourseList({ tasks }: { tasks: Task[] }) {
  const cursos = [...new Set(tasks.map((t) => t.course).filter((c): c is string => Boolean(c)))].sort();
  return (
    <datalist id="tf-courses">
      {cursos.map((c) => (
        <option key={c} value={c} />
      ))}
    </datalist>
  );
}

/**
 * La carga de las próximas dos semanas, contada (no adivinada): qué exámenes y
 * entregas grandes vienen, cuánto pesan si lo sabes, y qué semana se junta.
 * Si no hay nada importante, no se pinta.
 */
export function WorkloadPanel({ tasks, today }: { tasks: Task[]; today: string }) {
  const w = upcomingWorkload(tasks, today);
  if (!w.line) return null;

  return (
    <div className="panel">
      <div className="ph">
        <h2>Carga próxima</h2>
        {w.weight ? (
          <span className="sub">
            {w.weight.pct}% de la nota{w.weight.known < w.majors.length ? ` (en ${w.weight.known} de ${w.majors.length})` : ""}
          </span>
        ) : null}
      </div>
      <div className="pb">
        <p className="wlline">{w.line}</p>
        {w.heavyWeeks.map((s) => (
          <p className="wlheavy" key={s.monday}>
            Semana del {dayOfMonth(s.monday)} {MONTHS_SHORT[monthOf(s.monday)]}: {s.kinds}
          </p>
        ))}
        {w.majors.length ? (
          <ul className="wllist">
            {w.majors.slice(0, 6).map((t) => {
              const d = daysBetween(today, t.due_date!);
              return (
                <li key={t.id}>
                  <span className="mono">{d === 0 ? "hoy" : d === 1 ? "mañana" : `en ${d} días`}</span>
                  <span className="wlwhat">
                    <b>{t.kind ? KIND_LABEL[t.kind] : ""}</b> {t.course ? `· ${t.course} ` : ""}· {t.title}
                  </span>
                  <span className="mono wlwhen">{fmtDate(t.due_date, today)}</span>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
