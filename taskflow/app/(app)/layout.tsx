import Link from "next/link";
import { Capture } from "@/components/Capture";
import { PushHeal } from "@/components/PushHeal";
import { CommandPalette } from "@/components/CommandPalette";
import { canvasConfigured, plannerConfigured } from "@/lib/env.server";
import { Rail } from "@/components/Rail";
import { getCtx, loadCounts } from "@/lib/data";
import { loadStatus } from "@/lib/status";

/**
 * Ninguna de las seis vistas es estática: todas dependen de la sesión y de
 * filas que cambian. Declararlo aquí evita que el build intente prerenderizarlas.
 */
export const dynamic = "force-dynamic";

/** El riel y la barra de captura viven aquí: se ven en las seis vistas. */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getCtx();
  const [counts, status] = await Promise.all([loadCounts(ctx), loadStatus(ctx)]);
  const { health } = status;
  const alerta = health.alerts[0];

  return (
    <div className="shell">
      <Rail
        counts={counts}
        email={ctx.email ?? ""}
        health={alerta ? { level: alerta.level, text: `${alerta.label}: revisar` } : { level: "ok", text: "al día" }}
      />
      <main>
        {/* Si algo que corre solo está fallando, se dice arriba de cada vista
            — también en el celular, donde el riel no muestra la marca. */}
        {alerta ? (
          <Link className={"healthbar " + alerta.level} href="/ajustes/estado">
            <span>
              <b>{alerta.label}:</b> {alerta.summary}
              {health.alerts.length > 1 ? ` (y ${health.alerts.length - 1} más)` : ""}
            </span>
            <em>Ver estado</em>
          </Link>
        ) : null}
        <Capture areas={ctx.profile.areas} today={ctx.today} />
        {children}
      </main>
      <PushHeal />
      <CommandPalette canvas={canvasConfigured()} planner={plannerConfigured()} />
    </div>
  );
}
