import { deleteIcsSource } from "@/app/actions";
import { ViewHead } from "@/components/TaskRow";
import { AreasForm, HoursForm, ImportIcs, TimezoneForm } from "@/components/SettingsForms";
import { CanvasPanel } from "@/components/CanvasPanel";
import { PushPanel } from "@/components/PushPanel";
import { getCtx, loadIcsSources, loadSyncState } from "@/lib/data";
import { canvasConfigured } from "@/lib/env.server";
import { VAPID_PUBLIC_KEY } from "@/lib/env";
import { MONTHS_SHORT, dayOfMonth, minsToHHMM, monthOf, zonedDayMinute } from "@/lib/date";

export const metadata = { title: "Ajustes · TaskFlow" };

export default async function AjustesPage() {
  const ctx = await getCtx();
  const [sources, canvasState] = await Promise.all([
    loadIcsSources(ctx),
    loadSyncState(ctx, "canvas"),
  ]);

  // La fecha se formatea aquí, en la zona del perfil, y viaja ya hecha.
  let lastSynced: string | null = null;
  if (canvasState?.last_synced_at) {
    const { date, min } = zonedDayMinute(canvasState.last_synced_at, ctx.tz);
    lastSynced = dayOfMonth(date) + " " + MONTHS_SHORT[monthOf(date)] + " · " + minsToHHMM(min);
  }

  return (
    <>
      <ViewHead eyebrow="configuración y datos" title="Ajustes" />

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
                lastError={canvasState?.last_error ?? null}
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
              <h2>Tus datos</h2>
            </div>
            <div className="pb">
              <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--ink-2)" }}>
                Tus datos ya viven en tu propio proyecto de Supabase. Esto es para tener una
                copia a mano, mirarla, o llevártela si algún día cambias de base.
              </p>
              <a className="btn line sm" href="/api/export" download>
                Descargar todo en JSON
              </a>
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
