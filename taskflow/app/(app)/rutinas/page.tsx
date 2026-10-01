import { AddHabit } from "@/components/AddHabit";
import { HabitRowWide, PausedHabitRow } from "@/components/HabitRow";
import { EmptyBox, ViewHead } from "@/components/TaskRow";
import { getCtx, loadHabitLog, loadHabits } from "@/lib/data";
import { addDays } from "@/lib/date";
import { HABIT_WINDOW, habitSince } from "@/lib/habits";

export const metadata = { title: "Rutinas · TaskFlow" };

export default async function RutinasPage() {
  const ctx = await getCtx();
  const d = ctx.today;

  const [habits, paused, log] = await Promise.all([
    loadHabits(ctx),
    loadHabits(ctx, { paused: true }),
    loadHabitLog(ctx, addDays(d, -HABIT_WINDOW), d),
  ]);

  return (
    <>
      <ViewHead eyebrow="constancia en 30 días" title="Rutinas" />

      <div className="panel">
        <div className="pb tight">
          {habits.length ? (
            habits.map((h) => <HabitRowWide key={h.id} habit={h} log={log} today={d} since={habitSince(h, ctx.tz, log)} />)
          ) : (
            <EmptyBox
              title="Sin rutinas"
              sub="Agrega una abajo y márcala los días en que toca."
            />
          )}
        </div>
        <div className="pb" style={{ borderTop: "1px solid var(--line)" }}>
          <AddHabit />
        </div>
      </div>

      {paused.length ? (
        <details className="panel pausedlist">
          <summary className="ph">
            <h2>En pausa</h2>
            <span className="sub">{paused.length}</span>
          </summary>
          <div className="pb tight">
            {paused.map((h) => (
              <PausedHabitRow key={h.id} habit={h} />
            ))}
          </div>
        </details>
      ) : null}
    </>
  );
}
