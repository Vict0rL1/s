import Link from "next/link";
import { deleteIcsSource } from "@/app/actions";
import { ViewHead } from "@/components/TaskRow";
import { AreasForm, HoursForm, ImportIcs, TimezoneForm } from "@/components/SettingsForms";
import { CanvasPanel } from "@/components/CanvasPanel";
import { PushPanel } from "@/components/PushPanel";
import { TelegramPanel } from "@/components/TelegramPanel";
import { ImportBackup } from "@/components/ImportBackup";
import { getCtx, loadIcsSources, loadSyncState } from "@/lib/data";
import { canvasConfigured, telegramConfigured } from "@/lib/env.server";
import { isFailing } from "@/lib/sync-state";
import { VAPID_PUBLIC_KEY } from "@/lib/env";
import { MONTHS_SHORT, dayOfMonth, minsToHHMM, monthOf, zonedDayMinute } from "@/lib/date";

export const metadata = { title: "Ajustes · TaskFlow" };

export default async function AjustesPage() {
  const ctx = await getCtx();
  const [sources, canvasState, telegram] = await Promise.all([
    loadIcsSources(ctx),
    loadSyncState(ctx, "canvas"),
    ctx.supabase
      .from("telegram_chats")
      .select("linked_at, chat_id")
      .eq("user_id", ctx.userId)
      .maybeSingle<{ linked_at: string | null; chat_id: number | null }>()
      .then((r) => r.data),
  ]);

  let telegramLinked: string | null = null;
  if (telegram?.chat_id && telegram.linked_at) {
    const { date, min } = zonedDayMinute(telegram.linked_at, ctx.tz);
    telegramLinked = dayOfMonth(date) + " " + MONTHS_SHORT[monthOf(date)] + " · " + minsToHHMM(min);
  }

  // La fecha se formatea aquí, en la zona del perfil, y viaja ya hecha. Lo que
  // se enseña es el último sync que SALIÓ BIEN: con el token vencido, el último
  // intento es de hace una hora y no dice nada útil.
  let lastSynced: string | null = null;
  if (canvasState?.last_success_at) {
    const { date, min } = zonedDayMinute(canvasState.last_success_at, ctx.tz);
    lastSynced = dayOfMonth(date) + " " + MONTHS_SHORT[monthOf(date)] + " · " + minsToHHMM(min);
  }
  const canvasError = isFailing(canvasState) ? canvasState?.last_error ?? null : null;

  return (
    <>
      <ViewHead
        eyebrow="configuración y datos"
        title="Ajustes"
        right={
          <>
            <Link className="btn line sm" href="/ajustes/estado">Estado del sistema</Link>
            <Link className="btn line sm" href="/ajustes/actividad">Actividad</Link>
            <Link className="btn line sm" href="/ajustes/papelera">Papelera</Link>
          </>
        }
      />

      <div className="grid2">
        <div className="stack">
          <div className="panel">
            <div className="ph">
              <h2>Canvas</h2>
              <span className="sub">fase 2</span>
            </div>
            <div className="pb">
              <CanvasPanel
                configured={canvasConfigured()}
                lastSynced={lastSynced}
                lastError={canvasError}
                itemsSynced={canvasState?.items_synced ?? 0}
              />
            </div>
          </div>

          <div className="panel">
            <div className="ph">
              <h2>Importar calendario</h2>
            </div>
            <div className="pb">
              <ImportIcs />

              {sources.length ? (
                <div style={{ marginTop: 16 }}>
                  {sources.map((s) => (
                    <div className="srcrow" key={s.name}>
                      <b>{s.name}</b>
                      <span className="mono">{s.count} eventos</span>
                      <form action={deleteIcsSource} style={{ marginLeft: "auto" }}>
                        <input type="hidden" name="name" value={s.name} />
                        <button className="btn ghost sm" type="submit">
                          Quitar
                        </button>
                      </form>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </div>

        </div>

        <div className="stack">
          <div className="panel">
            <div className="ph">
              <h2>Áreas</h2>
            </div>
            <div className="pb">
              <AreasForm areas={ctx.profile.areas} />
            </div>
          </div>

          <div className="panel">
            <div className="ph">
              <h2>Horario visible</h2>
            </div>
            <div className="pb">
              <HoursForm dayStart={ctx.profile.day_start} dayEnd={ctx.profile.day_end} />
            </div>
          </div>

          <div className="panel">
            <div className="ph">
              <h2>Zona horaria</h2>
            </div>
            <div className="pb">
              <TimezoneForm timezone={ctx.profile.timezone} />
            </div>
          </div>

          <div className="panel">
            <div className="ph">
              <h2>Avisos</h2>
              <span className="sub">fase 4</span>
            </div>
            <div className="pb">
              <PushPanel vapidPublicKey={VAPID_PUBLIC_KEY ?? null} />
            </div>
          </div>

          <div className="panel">
            <div className="ph">
              <h2>Telegram</h2>
              <span className="sub">fase 4</span>
            </div>
            <div className="pb">
              <TelegramPanel configured={telegramConfigured()} linkedAt={telegramLinked} />
            </div>
          </div>

          <div className="panel">
            <div className="ph">
              <h2>Tus datos</h2>
            </div>
            <div className="pb">
              <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--ink-2)" }}>
                Tus datos ya viven en tu propio proyecto de Supabase. Esto es para tener una
                copia a mano, mirarla, o llevártela si algún día cambias de base.
              </p>
              <div className="row">
                <a className="btn line sm" href="/api/export" download>
                  Descargar todo en JSON
                </a>
                <ImportBackup />
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="ph">
              <h2>Cómo sacar tu .ics</h2>
            </div>
            <div className="pb" style={{ fontSize: 13, color: "var(--ink-2)" }}>
              <p style={{ margin: "0 0 8px" }}>
                <b style={{ color: "var(--ink)" }}>Canvas</b> → Calendario → botón «Calendar Feed»
                abajo a la derecha → copia el link, ábrelo en el navegador y guarda el archivo.
              </p>
              <p style={{ margin: 0 }}>
                <b style={{ color: "var(--ink)" }}>Google Calendar</b> → Configuración → Importar y
                exportar → Exportar. Baja un .zip; descomprímelo y sube el .ics de dentro.
              </p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
