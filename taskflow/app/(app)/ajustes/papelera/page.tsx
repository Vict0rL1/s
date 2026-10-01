import Link from "next/link";
import { emptyTrash, purgeTrashItem, restoreNote, restoreTask } from "@/app/actions";
import { ActionButton } from "@/components/ActionButton";
import { RunButton } from "@/components/RunButton";
import { EmptyBox, ViewHead } from "@/components/TaskRow";
import { getCtx } from "@/lib/data";
import { MONTHS_SHORT, addDays, dayOfMonth, monthOf, zonedDayMinute } from "@/lib/date";
import { TRASH_DAYS, loadTrash } from "@/lib/trash";

export const metadata = { title: "Papelera · TaskFlow" };

/**
 * Ajustes → Papelera. Lo borrado espera aquí 30 días antes de irse solo.
 */
export default async function PapeleraPage() {
  const ctx = await getCtx();
  const { tasks, notes } = await loadTrash(ctx);

  // "Se borra el 31 oct": el día local en que se cumplen los 30 días.
  const vence = (iso: string) => {
    const d = addDays(zonedDayMinute(iso, ctx.tz).date, TRASH_DAYS);
    return `${dayOfMonth(d)} ${MONTHS_SHORT[monthOf(d)]}`;
  };
  const hay = tasks.length + notes.length > 0;

  return (
    <>
      <ViewHead
        eyebrow="ajustes"
        title="Papelera"
        right={
          <>
            <Link className="btn line sm" href="/ajustes">Volver a Ajustes</Link>
          </>
        }
      />
      <p className="stintro">
        Lo que borras espera aquí {TRASH_DAYS} días y después se va solo. Las tareas de Canvas que
        elimines para siempre no vuelven a aparecer aunque sigan en Canvas.
      </p>

      {hay ? (
        <>
          {tasks.length ? (
            <div className="panel">
              <div className="ph">
                <h2>Tareas</h2>
                <span className="sub">{tasks.length}</span>
              </div>
              <div className="pb tight">
                {tasks.map((t) => (
                  <div className="trashrow" key={t.id}>
                    <div className="tmain">
                      <span className="ttitle">{t.title}</span>
                      <span className="trashmeta">
                        {[t.course, t.source === "canvas" ? "de Canvas" : null, `se borra el ${vence(t.deleted_at)}`].filter(Boolean).join(" · ")}
                      </span>
                    </div>
                    <ActionButton action={restoreTask} id={t.id} className="btn line sm" label={`Restaurar «${t.title}»`}>
                      Restaurar
                    </ActionButton>
                    <ActionButton
                      action={purgeTrashItem}
                      id={t.id}
                      className="btn ghost sm"
                      label={`Eliminar «${t.title}» para siempre`}
                      extra={<input type="hidden" name="type" value="task" />}
                    >
                      Eliminar
                    </ActionButton>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {notes.length ? (
            <div className="panel">
              <div className="ph">
                <h2>Notas</h2>
                <span className="sub">{notes.length}</span>
              </div>
              <div className="pb tight">
                {notes.map((n) => (
                  <div className="trashrow" key={n.id}>
                    <div className="tmain">
                      <span className="ttitle">{n.body.length > 140 ? n.body.slice(0, 139) + "…" : n.body}</span>
                      <span className="trashmeta">se borra el {vence(n.deleted_at)}</span>
                    </div>
                    <ActionButton action={restoreNote} id={n.id} className="btn line sm" label="Restaurar la nota">
                      Restaurar
                    </ActionButton>
                    <ActionButton
                      action={purgeTrashItem}
                      id={n.id}
                      className="btn ghost sm"
                      label="Eliminar la nota para siempre"
                      extra={<input type="hidden" name="type" value="note" />}
                    >
                      Eliminar
                    </ActionButton>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="stactions" style={{ borderTop: "none" }}>
            <RunButton action={emptyTrash} label="Vaciar papelera" busy="Vaciando…" />
          </div>
        </>
      ) : (
        <div className="panel">
          <EmptyBox title="La papelera está vacía" sub="Lo que borres aparece aquí durante 30 días." />
        </div>
      )}
    </>
  );
}
