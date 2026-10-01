import Link from "next/link";
import { Timeline } from "@/components/Timeline";
import { HabitRow } from "@/components/HabitRow";
import { EmptyBox, TaskGroup, TaskPills, ViewHead } from "@/components/TaskRow";
import { DayPlanner } from "@/components/DayPlanner";
import { plannerConfigured } from "@/lib/env.server";
import { ActionButton } from "@/components/ActionButton";
import { toggleTask } from "@/app/actions";
import { getCtx, loadBlocks, loadEvents, loadHabitLog, loadHabits, loadTasks } from "@/lib/data";
import { DAYS, MONTHS, addDays, dayOfMonth, minutesInTz, monthOf, weekdayOf, yearOf } from "@/lib/date";
import { HABIT_WINDOW, didHabit, habitSince, habitsOn } from "@/lib/habits";
import { FocusButton } from "@/components/FocusButton";
import { CourseList } from "@/components/Workload";
import { TimerControls } from "@/components/Timer";
import { AutoRefresh } from "@/components/AutoRefresh";
import { todayContext } from "@/lib/today";
import { upcomingWorkload } from "@/lib/workload";

export const metadata = { title: "Hoy · TaskFlow" };

function greeting(minutes: number) {
  const h = Math.floor(minutes / 60);
  return h < 12 ? "Buenos días, Victor" : h < 19 ? "Buenas tardes, Victor" : "Buenas noches, Victor";
}

/** Cuántas tareas de los próximos días se muestran aquí; el resto, en Tareas. */
const PROXIMAS = 6;

/**
 * Hoy, en orden de lo que importa ahora: el siguiente compromiso, lo que está
 * en marcha, lo importante de hoy, la agenda, lo atrasado y lo que viene.
 *
 * El HTML va en ese orden, que es el que siguen el teclado y el lector de
 * pantalla. En el celular es una sola columna; en pantalla ancha la agenda
 * pasa a la derecha sólo con CSS.
 */
export default async function HoyPage() {
  const ctx = await getCtx();
  const d = ctx.today;

  const [tasks, events, blocks, habits, log] = await Promise.all([
    loadTasks(ctx),
    loadEvents(ctx, d, d),
    loadBlocks(ctx, d, d),
    loadHabits(ctx),
    loadHabitLog(ctx, addDays(d, -HABIT_WINDOW), d),
  ]);

  const ahora = minutesInTz(ctx.tz);
  const contexto = todayContext({ nowMin: ahora, today: d, dayEnd: ctx.profile.day_end, events, blocks, tasks });

  const open = tasks.filter((t) => !t.done);
  const enMarcha = open.find((t) => t.track_started_at);
  const focus = open.filter((t) => t.focus_day === d);
  const venceHoy = open.filter((t) => t.due_date === d && t.focus_day !== d).sort((a, b) => a.priority - b.priority);
  const atrasadas = open
    .filter((t) => t.due_date && t.due_date < d)
    .sort((a, b) => a.due_date!.localeCompare(b.due_date!) || a.priority - b.priority);
  const proximas = open
    .filter((t) => t.due_date && t.due_date > d && t.due_date <= addDays(d, 7))
    .sort((a, b) => a.due_date!.localeCompare(b.due_date!) || a.priority - b.priority);
  const carga = upcomingWorkload(tasks, d);

  const todayHabits = habitsOn(habits, d);
  const doneHabits = todayHabits.filter((h) => didHabit(log, d, h.id)).length;
  const allDay = events.filter((e) => e.start == null);
  const eyebrow = DAYS[weekdayOf(d)] + " · " + dayOfMonth(d) + " de " + MONTHS[monthOf(d)] + " " + yearOf(d);

  return (
    <>
      <ViewHead eyebrow={eyebrow} title={greeting(ahora)} />
      <CourseList tasks={tasks} />
      <AutoRefresh minutes={5} />

      <div className="hoygrid">
        {/* 1 · lo que viene ahora: datos, no frases */}
        {contexto.lines.length ? (
          <section className="ahora" aria-label="Ahora">
            <ul>
              {contexto.lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* 2 · lo que está en marcha */}
        {enMarcha ? (
          <div className="panel">
            <div className="ph">
              <h2>En marcha</h2>
            </div>
            <div className="pb">
              <p className="enmarcha">{enMarcha.title}</p>
              <TimerControls task={enMarcha} />
            </div>
          </div>
        ) : null}

        {/* 3 · lo importante de hoy: el enfoque y lo que vence hoy */}
        <div className="panel">
          <div className="ph">
            <h2>Importante hoy</h2>
            <span className="sub">{focus.length}/3 en el enfoque</span>
          </div>
          {focus.length || venceHoy.length ? (
            <div className="pb tight">
              {focus.map((t, i) => (
                <div className="focusline" key={t.id}>
                  <span className="fnum">{i + 1}</span>
                  <ActionButton action={toggleTask} id={t.id} className="chk" label={`Completar «${t.title}»`}>
                    ✓
                  </ActionButton>
                  <div className="tmain">
                    <span className="ttitle">{t.title}</span>
                    <TaskPills task={t} today={d} />
                  </div>
                  <FocusButton id={t.id} focused />
                </div>
              ))}
              <TaskGroup title="Vence hoy" list={venceHoy} today={d} />
            </div>
          ) : (
            <EmptyBox title="Nada fijado ni nada que venza hoy" sub="Marca ☆ en hasta 3 tareas para fijar lo que sí o sí sale hoy." />
          )}
        </div>

        {/* 4 · la agenda */}
        <div className="panel hoyside">
          <div className="ph">
            <h2>Agenda</h2>
            <span className="sub">{events.length + blocks.length} bloques</span>
          </div>
          {allDay.length ? (
            <div className="pb" style={{ paddingBottom: 0 }}>
              <div className="chips">
                {allDay.map((e) => (
                  <span className="chip" key={e.id}>{e.title}</span>
                ))}
              </div>
            </div>
          ) : null}
          <div className="pb">
            <Timeline events={events} blocks={blocks} dayStart={ctx.profile.day_start} dayEnd={ctx.profile.day_end} tz={ctx.tz} />
          </div>
          {/* Sin ANTHROPIC_API_KEY no se pinta nada: un botón que siempre
              falla es peor que no tenerlo. */}
          {plannerConfigured() ? (
            <div className="pb" style={{ paddingTop: 0 }}>
              <DayPlanner />
            </div>
          ) : null}
        </div>

        {/* 5 · lo atrasado: el único rojo de la vista */}
        {atrasadas.length ? (
          <div className="panel">
            <div className="pb tight">
              <TaskGroup title="Atrasadas" list={atrasadas} today={d} danger />
            </div>
          </div>
        ) : null}

        {/* 6 · lo que viene */}
        <div className="panel">
          <div className="ph">
            <h2>Próximo</h2>
            <Link className="sub" href="/tareas">ver todo</Link>
          </div>
          <div className="pb tight">
            {carga.line ? <p className="wlline padded">{carga.line}</p> : null}
            {proximas.length ? (
              <TaskGroup title="Próximos 7 días" list={proximas.slice(0, PROXIMAS)} today={d} />
            ) : (
              <EmptyBox title="Nada en los próximos 7 días" sub="Lo que venga después está en Tareas." />
            )}
          </div>
        </div>

        {/* 7 · las rutinas */}
        <div className="panel">
          <div className="ph">
            <h2>Rutinas</h2>
            <span className="sub">{doneHabits}/{todayHabits.length}</span>
          </div>
          {todayHabits.length ? (
            <div className="pb tight">
              {todayHabits.map((h) => (
                <HabitRow key={h.id} habit={h} log={log} today={d} since={habitSince(h, ctx.tz, log)} />
              ))}
            </div>
          ) : (
            <EmptyBox title="Sin rutinas hoy" sub="Agrégalas en la vista Rutinas." />
          )}
        </div>
      </div>
    </>
  );
}
