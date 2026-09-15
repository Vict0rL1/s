import { AddHabit } from "@/components/AddHabit";
import { HabitRowWide } from "@/components/HabitRow";
import { EmptyBox, ViewHead } from "@/components/TaskRow";
import { getCtx, loadHabitLog, loadHabits } from "@/lib/data";
import { addDays } from "@/lib/date";
import { HABIT_WINDOW } from "@/lib/habits";

export const metadata = { title: "Rutinas · TaskFlow" };

export default async function RutinasPage() {
  const ctx = await getCtx();
  const d = ctx.today;

  const [habits, log] = await Promise.all([
    loadHabits(ctx),
    loadHabitLog(ctx, addDays(d, -HABIT_WINDOW), d),
  ]);

  return (
    <>
      <ViewHead eyebrow="constancia en 30 días" title="Rutinas" />

      <div className="panel">
        <div className="pb tight">
          {habits.length ? (
            habits.map((h) => <HabitRowWide key={h.id} habit={h} log={log} today={d} />)
          ) : (
            <EmptyBox
              title="Sin rutinas"
              sub="Agrega una abajo y márcala cada día para ver la racha."
            />
          )}
        </div>
        <div className="pb" style={{ borderTop: "1px solid var(--line)" }}>
          <AddHabit />
        </div>
      </div>
    </>
  );
}
