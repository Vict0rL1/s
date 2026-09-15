import { Timeline } from "@/components/Timeline";
import { HabitRow } from "@/components/HabitRow";
import { EmptyBox, TaskGroup, TaskPills, ViewHead } from "@/components/TaskRow";
import { ActionButton } from "@/components/ActionButton";
import { toggleTask } from "@/app/actions";
import { getCtx, loadBlocks, loadEvents, loadHabitLog, loadHabits, loadTasks } from "@/lib/data";
import { DAYS, MONTHS, addDays, dayOfMonth, minutesInTz, monthOf, weekdayOf, yearOf } from "@/lib/date";
import { HABIT_WINDOW, didHabit, habitsOn } from "@/lib/habits";
import { FocusButton } from "@/components/FocusButton";

export const metadata = { title: "Hoy · TaskFlow" };

function greeting(minutes: number) {
  const h = Math.floor(minutes / 60);
  return h < 12 ? "Buenos días, Victor" : h < 19 ? "Buenas tardes, Victor" : "Buenas noches, Victor";
}

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

  const open = tasks.filter((t) => !t.done);
  const due = open
    .filter((t) => t.due_date && t.due_date <= d)
    .sort((a, b) =>
      a.due_date! < b.due_date! ? -1 : a.due_date! > b.due_date! ? 1 : a.priority - b.priority,
    );
  const late = due.filter((t) => t.due_date! < d);
  const now = due.filter((t) => t.due_date === d);

  const focus = open.filter((t) => t.focus_day === d);
  const todayHabits = habitsOn(habits, d);
  const doneHabits = todayHabits.filter((h) => didHabit(log, d, h.id)).length;

  const allDay = events.filter((e) => e.start == null);
  const eyebrow =
    DAYS[weekdayOf(d)] + " · " + dayOfMonth(d) + " de " + MONTHS[monthOf(d)] + " " + yearOf(d);

  return (
    <>
      <ViewHead eyebrow={eyebrow} title={greeting(minutesInTz(ctx.tz))} />

      <div className="grid2">
        <div className="stack">
          <div className="panel">
            <div className="ph">
              <h2>Agenda</h2>
              <span className="sub">{events.length + blocks.length} bloques</span>
            </div>

            {allDay.length ? (
              <div className="pb" style={{ paddingBottom: 0 }}>
                <div className="chips">
                  {allDay.map((e) => (
                    <span className="chip" key={e.id}>
                      {e.title}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="pb">
              <Timeline
                events={events}
                blocks={blocks}
                dayStart={ctx.profile.day_start}
                dayEnd={ctx.profile.day_end}
                tz={ctx.tz}
              />
            </div>
          </div>
        </div>

        <div className="stack">
          <div className="panel">
            <div className="ph">
              <h2>Enfoque del día</h2>
              <span className="sub">{focus.length}/3</span>
            </div>
            {focus.length ? (
              <div className="pb tight">
                {focus.map((t, i) => (
                  <div className="focusline" key={t.id}>
                    <span className="fnum">{i + 1}</span>
                    <ActionButton action={toggleTask} id={t.id} className="chk" label="Completar">
                      ✓
                    </ActionButton>
                    <div className="tmain">
                      <span className="ttitle">{t.title}</span>
                      <TaskPills task={t} today={d} />
                    </div>
                    <FocusButton id={t.id} focused />
                  </div>
                ))}
              </div>
            ) : (
              <EmptyBox
                title="Sin enfoque todavía"
                sub="Marca ☆ en hasta 3 tareas para fijar lo que sí o sí sale hoy."
              />
            )}
          </div>

          <div className="panel">
            <div className="ph">
              <h2>Para hoy</h2>
              <span className="sub">{due.length} pendientes</span>
            </div>
            {due.length ? (
              <div className="pb tight">
                <TaskGroup title="Atrasadas" list={late} today={d} danger />
                <TaskGroup title="Vence hoy" list={now} today={d} />
              </div>
            ) : (
              <EmptyBox
                title="Nada vence hoy"
                sub="Buen momento para adelantar algo de la semana."
              />
            )}
          </div>

          <div className="panel">
            <div className="ph">
              <h2>Rutinas</h2>
              <span className="sub">
                {doneHabits}/{todayHabits.length}
              </span>
            </div>
            {todayHabits.length ? (
              <div className="pb tight">
                {todayHabits.map((h) => (
                  <HabitRow key={h.id} habit={h} log={log} today={d} />
                ))}
              </div>
            ) : (
              <EmptyBox title="Sin rutinas hoy" sub="Agrégalas en la vista Rutinas." />
            )}
          </div>
        </div>
      </div>
    </>
  );
}
