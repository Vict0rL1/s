import { Capture } from "@/components/Capture";
import { Rail } from "@/components/Rail";
import { getCtx, loadCounts } from "@/lib/data";

/**
 * Ninguna de las seis vistas es estática: todas dependen de la sesión y de
 * filas que cambian. Declararlo aquí evita que el build intente prerenderizarlas.
 */
export const dynamic = "force-dynamic";

/** El riel y la barra de captura viven aquí: se ven en las seis vistas. */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getCtx();
  const counts = await loadCounts(ctx);
  const { data: auth } = await ctx.supabase.auth.getUser();

  return (
    <div className="shell">
      <Rail counts={counts} email={auth.user?.email ?? ""} />
      <main>
        <Capture areas={ctx.profile.areas} today={ctx.today} />
        {children}
      </main>
    </div>
  );
}
