import Link from "next/link";
import { clearDoneTasks } from "@/app/actions";
import { EmptyBox, TaskGroup, TaskRow, ViewHead } from "@/components/TaskRow";
import { getCtx, loadTasks } from "@/lib/data";
import { daysBetween } from "@/lib/date";
import { kindLabel, upcomingWorkload } from "@/lib/workload";
import { estimateStats, statsLine } from "@/lib/timing";
import { CourseList } from "@/components/Workload";
import type { Task } from "@/lib/types";

export const metadata = { title: "Tareas · TaskFlow" };

/** El filtro por área vive en la URL, no en la base: así se comparte y se recarga bien. */
type Props = { searchParams: Promise<{ area?: string; curso?: string; t?: string }> };

export default async function TareasPage({ searchParams }: Props) {
  const { area, curso, t: abrir } = await searchParams;
  const ctx = await getCtx();
  const d = ctx.today;

  const all = await loadTasks(ctx);
  const list = all.filter((t) => (!area || t.area === area) && (!curso || t.course === curso));

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
      <Link className="chip" href="/tareas" aria-pressed={!area && !curso}>
        Todas
      </Link>
      {curso ? (
        <Link className="chip" href="/tareas" aria-pressed aria-label={`Quitar el filtro del curso ${curso}`}>
          {curso} ×
        </Link>
      ) : null}
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

  const carga = upcomingWorkload(list, d);
  // Sobre todas las terminadas, no sólo las 12 que se muestran.
  const tiempo = estimateStats(all);

  const hasAny = late.length + hoy.length + week.length + later.length + none.length > 0;

  return (
    <>
      <ViewHead
        eyebrow={open.length + " pendientes · " + done.length + " listas recientemente"}
        title="Tareas"
        right={chips}
      />

      <CourseList tasks={all} />
      {carga.line ? <p className="tareasload">{carga.line}</p> : null}

      <div className="panel">
        <div className="pb tight">
          {hasAny ? (
            <>
              <TaskGroup title="Atrasadas" list={late} today={d} danger openId={abrir} />
              <TaskGroup title="Hoy" list={hoy} today={d} openId={abrir} />
              <TaskGroup title="Próximos 7 días" list={week} today={d} openId={abrir} />
              <TaskGroup title="Más adelante" list={later} today={d} openId={abrir} />
              <TaskGroup title="Sin fecha" list={none} today={d} openId={abrir} />
            </>
          ) : (
            <EmptyBox
              title="Bandeja limpia"
              sub="Captura algo arriba: «Leer cap 4 #SFU vie 45m»"
            />
          )}
        </div>
      </div>

      {tiempo ? (
        <div className="panel">
          <div className="ph">
            <h2>Tu tiempo</h2>
            <span className="sub">{tiempo.samples} tareas medidas</span>
          </div>
          <div className="pb">
            <p className="wlline">{statsLine(tiempo)}</p>
            {tiempo.byKind.map((k) => (
              <p className="tiempokind" key={k.kind}>
                {kindLabel(k.kind, 2)[0].toUpperCase() + kindLabel(k.kind, 2).slice(1)}: estimas {k.est} min, tardas {k.real} min
              </p>
            ))}
            <p className="propwhy">Con las tareas terminadas que tenían estimado y cronómetro. Medianas: una tarea rara no tuerce el número.</p>
          </div>
        </div>
      ) : null}

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
              <TaskRow key={t.id} task={t} today={d} open={t.id === abrir} />
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}
