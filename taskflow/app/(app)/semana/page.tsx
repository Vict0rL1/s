import Link from "next/link";
import { ViewHead } from "@/components/TaskRow";
import { TermShape } from "@/components/TermShape";
import { getCtx, loadBlocks, loadEvents, loadTasks } from "@/lib/data";
import { DAYS_SHORT, MONTHS_SHORT, addDays, dayOfMonth, minsToHHMM, monthOf, startOfWeek, weekdayOf, yearOf } from "@/lib/date";

export const metadata = { title: "Semana · TaskFlow" };

const MAX_EVENTS = 6;
const MAX_BLOCKS = 4;

/** Hasta un año en cada dirección: más allá no hay nada que planear. */
const MAX_SEMANAS = 52;

/** La semana se lleva en la URL, como el filtro de Tareas: se recarga y se comparte. */
type Props = { searchParams: Promise<{ w?: string }> };

export default async function SemanaPage({ searchParams }: Props) {
  const { w } = await searchParams;
  const parsed = Number(w);
  const offset = Number.isFinite(parsed)
    ? Math.max(-MAX_SEMANAS, Math.min(MAX_SEMANAS, Math.trunc(parsed)))
    : 0;

  const ctx = await getCtx();
  const d = ctx.today;
  const start = addDays(startOfWeek(d), offset * 7);
  const end = addDays(start, 6);

  const [tasks, events, blocks] = await Promise.all([
    loadTasks(ctx),
    loadEvents(ctx, start, end),
    loadBlocks(ctx, start, end),
  ]);

  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));

  return (
    <>
      <ViewHead
        eyebrow={
          dayOfMonth(start) + " " + MONTHS_SHORT[monthOf(start)] + " – " + dayOfMonth(end) + " " + MONTHS_SHORT[monthOf(end)] +
          (yearOf(start) !== yearOf(d) ? " " + yearOf(start) : "")
        }
        title={offset === 0 ? "Semana" : offset === 1 ? "Próxima semana" : offset === -1 ? "Semana pasada" : "Semana"}
        right={
          <>
            <div className="weeknav">
              <Link
                className="btn line sm"
                href={offset - 1 === 0 ? "/semana" : `/semana?w=${offset - 1}`}
                aria-label="Semana anterior"
                rel="prev"
              >
                ‹
              </Link>
              <Link
                className="btn line sm"
                href="/semana"
                aria-current={offset === 0 ? "page" : undefined}
              >
                Hoy
              </Link>
              <Link
                className="btn line sm"
                href={offset + 1 === 0 ? "/semana" : `/semana?w=${offset + 1}`}
                aria-label="Semana siguiente"
                rel="next"
              >
                ›
              </Link>
            </div>
            <Link className="btn line sm" href="/ajustes">
              Importar calendario
            </Link>
          </>
        }
      />

      <div className="weekgrid">
        {days.map((day) => {
          const evs = events.filter((e) => e.day === day);
          const bs = blocks.filter((b) => b.day === day);
          const ts = tasks.filter((t) => t.due_date === day);
          const hidden = Math.max(0, evs.length - MAX_EVENTS) + Math.max(0, bs.length - MAX_BLOCKS);
          const empty = !evs.length && !bs.length && !ts.length;

          return (
            <div className={"wcol" + (day === d ? " today" : "")} key={day}>
              <header>
                <b>{DAYS_SHORT[weekdayOf(day)]}</b>
                <em>{dayOfMonth(day)}</em>
              </header>

              {evs.slice(0, MAX_EVENTS).map((e) => (
                <div className="wi" key={e.id}>
                  {e.start != null ? <span className="mono">{minsToHHMM(e.start)}</span> : null}{" "}
                  {e.title}
                </div>
              ))}

              {bs.slice(0, MAX_BLOCKS).map((b) => (
                <div className="wi t" key={b.id}>
                  <span className="mono">{minsToHHMM(b.start_min)}</span> {b.title}
                </div>
              ))}

              {ts.map((t) => (
                <div className={"wi t" + (t.done ? " done" : "")} key={t.id}>
                  {t.title}
                </div>
              ))}

              {empty ? <span className="wmore">libre</span> : null}
              {hidden ? <span className="wmore">+{hidden} más</span> : null}
            </div>
          );
        })}
      </div>

      <TermShape tasks={tasks} today={d} viewing={offset} />
    </>
  );
}
