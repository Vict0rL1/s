import Link from "next/link";
import { clearDoneTasks } from "@/app/actions";
import { EmptyBox, TaskGroup, TaskRow, ViewHead } from "@/components/TaskRow";
import { getCtx, loadTasks } from "@/lib/data";
import { daysBetween } from "@/lib/date";
import type { Task } from "@/lib/types";

export const metadata = { title: "Tareas · TaskFlow" };

/** El filtro por área vive en la URL, no en la base: así se comparte y se recarga bien. */
type Props = { searchParams: Promise<{ area?: string }> };

export default async function TareasPage({ searchParams }: Props) {
  const { area } = await searchParams;
  const ctx = await getCtx();
  const d = ctx.today;

  const all = await loadTasks(ctx);
  const list = area ? all.filter((t) => t.area === area) : all;

  const open = list.filter((t) => !t.done);
  const done = list
    .filter((t) => t.done)
    .sort((a, b) => String(b.done_at ?? "").localeCompare(String(a.done_at ?? "")))
    .slice(0, 12);

  // Dentro de un grupo que ya está definido por fecha, manda la fecha y la
  // prioridad desempata. El artifact de referencia ordenaba al revés, y con
  // fechas repartidas por todo un semestre eso deja un "2 nov" debajo de un
  // "7 dic", que se lee como un error aunque no lo sea.
  const byDate = (a: Task, b: Task) =>
    String(a.due_date ?? "9").localeCompare(String(b.due_date ?? "9")) || a.priority - b.priority;

  // Sin fecha no hay nada que ordenar salvo la prioridad.
  const byPriority = (a: Task, b: Task) => a.priority - b.priority;

  const late = open.filter((t) => t.due_date && t.due_date < d).sort(byDate);
  const hoy = open.filter((t) => t.due_date === d).sort(byPriority);
  const week = open
    .filter((t) => t.due_date && t.due_date > d && daysBetween(d, t.due_date) <= 7)
    .sort(byDate);
  const later = open.filter((t) => t.due_date && daysBetween(d, t.due_date) > 7).sort(byDate);
  const none = open.filter((t) => !t.due_date).sort(byPriority);

  const chips = (
    <div className="chips">
      <Link className="chip" href="/tareas" aria-pressed={!area}>
        Todas
      </Link>
      {ctx.profile.areas.map((a) => (
        <Link
          key={a}
          className="chip"
          href={"/tareas?area=" + encodeURIComponent(a)}
          aria-pressed={area === a}
        >
          {a}
        </Link>
      ))}
    </div>
  );

  const hasAny = late.length + hoy.length + week.length + later.length + none.length > 0;

  return (
    <>
      <ViewHead
        eyebrow={open.length + " pendientes · " + done.length + " listas recientemente"}
        title="Tareas"
        right={chips}
      />

      <div className="panel">
        <div className="pb tight">
          {hasAny ? (
            <>
              <TaskGroup title="Atrasadas" list={late} today={d} danger />
              <TaskGroup title="Hoy" list={hoy} today={d} />
              <TaskGroup title="Próximos 7 días" list={week} today={d} />
              <TaskGroup title="Más adelante" list={later} today={d} />
              <TaskGroup title="Sin fecha" list={none} today={d} />
            </>
          ) : (
            <EmptyBox
              title="Bandeja limpia"
              sub="Captura algo arriba: «Leer cap 4 #SFU vie 45m»"
            />
          )}
        </div>
      </div>

      {done.length ? (
        <div className="panel">
          <div className="ph">
            <h2>Completadas</h2>
            <form action={clearDoneTasks} style={{ marginLeft: "auto" }}>
              <button className="btn ghost sm" type="submit">
                Limpiar
              </button>
            </form>
          </div>
          <div className="pb tight">
            {done.map((t) => (
              <TaskRow key={t.id} task={t} today={d} />
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}
