import { NoteList, type NoteView } from "@/components/NoteList";
import { getCtx, loadNotes } from "@/lib/data";
import { MONTHS_SHORT, minsToHHMM, monthOf, dayOfMonth, zonedDayMinute } from "@/lib/date";

export const metadata = { title: "Notas · TaskFlow" };

export default async function NotasPage() {
  const ctx = await getCtx();
  const notes = await loadNotes(ctx);

  // La fecha se formatea aquí, en la zona del perfil, y viaja ya hecha: así el
  // cliente no la recalcula con la zona del dispositivo.
  const view: NoteView[] = notes.map((n) => {
    const { date, min } = zonedDayMinute(n.created_at, ctx.tz);
    return {
      id: n.id,
      body: n.body,
      pinned: n.pinned,
      when: dayOfMonth(date) + " " + MONTHS_SHORT[monthOf(date)] + " · " + minsToHHMM(min),
    };
  });

  return <NoteList notes={view} />;
}
