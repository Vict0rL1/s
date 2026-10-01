import Link from "next/link";
import { EmptyBox, ViewHead } from "@/components/TaskRow";
import { ACTIVITY_RETENTION_DAYS, ACTORS, type Actor, loadActivity } from "@/lib/activity";
import { getCtx } from "@/lib/data";
import { DAYS_SHORT, MONTHS_SHORT, addDays, dayOfMonth, minsToHHMM, monthOf, weekdayOf, zonedDayMinute } from "@/lib/date";

export const metadata = { title: "Actividad · TaskFlow" };

const QUIEN: Record<Actor, string> = { user: "Tú", canvas: "Canvas", system: "Sistema", ai: "Claude" };

type Props = { searchParams: Promise<{ actor?: string }> };

/**
 * Ajustes → Actividad: qué pasó y quién lo hizo.
 *
 * Responde a "¿por qué esta tarea dice otra fecha?" o "¿llegó el resumen de
 * anoche?" sin adivinar. El filtro va en la URL, como en Tareas.
 */
export default async function ActividadPage({ searchParams }: Props) {
  const { actor: raw } = await searchParams;
  const actor = ACTORS.includes(raw as Actor) ? (raw as Actor) : null;
  const ctx = await getCtx();
  const rows = await loadActivity(ctx, actor);

  // Agrupado por día LOCAL: un sync a las 23:30 de Vancouver es de ese día,
  // aunque en UTC ya sea mañana.
  const grupos = new Map<string, { min: number; row: (typeof rows)[number] }[]>();
  for (const row of rows) {
    const { date, min } = zonedDayMinute(row.at, ctx.tz);
    const g = grupos.get(date) ?? [];
    g.push({ min, row });
    grupos.set(date, g);
  }
  const titulo = (d: string) =>
    d === ctx.today ? "Hoy" : d === addDays(ctx.today, -1) ? "Ayer"
      : `${DAYS_SHORT[weekdayOf(d)]} ${dayOfMonth(d)} ${MONTHS_SHORT[monthOf(d)]}`;

  return (
    <>
      <ViewHead
        eyebrow="ajustes"
        title="Actividad"
        right={<Link className="btn line sm" href="/ajustes">Volver a Ajustes</Link>}
      />

      <nav className="chips" aria-label="Filtrar por quién lo hizo" style={{ marginBottom: 14 }}>
        <Link className="chip" href="/ajustes/actividad" aria-pressed={!actor}>Todo</Link>
        {ACTORS.map((a) => (
          <Link key={a} className="chip" href={`/ajustes/actividad?actor=${a}`} aria-pressed={actor === a}>
            {QUIEN[a]}
          </Link>
        ))}
      </nav>

      <div className="panel">
        {rows.length ? (
          <div className="pb tight">
            {[...grupos].map(([dia, items]) => (
              <section className="actday" key={dia} aria-label={titulo(dia)}>
                <h3>{titulo(dia)}</h3>
                <ol>
                  {items.map(({ min, row }) => (
                    <li key={row.id} className="actrow">
                      <time className="mono" dateTime={row.at}>{minsToHHMM(min)}</time>
                      <span className={"actwho " + row.actor}>{QUIEN[row.actor]}</span>
                      <span className="actwhat">{row.summary}</span>
                    </li>
                  ))}
                </ol>
              </section>
            ))}
          </div>
        ) : (
          <EmptyBox
            title="Nada todavía"
            sub={actor ? "No hay actividad de este tipo en los últimos días." : "Aquí aparece lo que hacen Canvas, el reloj, Claude y tú."}
          />
        )}
      </div>
      <p className="actfoot">Se guarda {ACTIVITY_RETENTION_DAYS} días. Sin el contenido de tus notas ni datos de las APIs.</p>
    </>
  );
}
