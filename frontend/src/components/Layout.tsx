import { NavLink, Outlet } from 'react-router-dom'
import { ApiUsageBar } from './ApiUsageBar'

// Agrupado por intención, no por orden de construcción: lo primero es la
// pregunta con la que se abre la app ("¿qué miro hoy?"), no el catálogo de
// herramientas.
const NAV_GROUPS: { title: string | null; items: { to: string; label: string }[] }[] = [
  {
    title: null,
    items: [
      { to: '/hoy', label: 'Hoy' },
      { to: '/dashboard', label: 'Mercado' },
      { to: '/ticker', label: 'Acciones' },
    ],
  },
  {
    title: 'Herramientas',
    items: [
      { to: '/screener', label: 'Screener' },
      { to: '/multifactor', label: 'Multifactor' },
      { to: '/resultados', label: 'Resultados' },
      { to: '/valoracion', label: 'Valoración' },
      { to: '/senales', label: 'Señales' },
      { to: '/etfs', label: 'ETFs' },
      { to: '/noticias', label: 'Noticias' },
    ],
  },
  {
    title: 'Mío',
    items: [
      { to: '/portafolio', label: 'Portafolio' },
      { to: '/tesis', label: 'Tesis' },
    ],
  },
]

export function Layout() {
  return (
    <div className="flex min-h-screen bg-slate-50">
      <aside className="flex w-56 shrink-0 flex-col border-r border-slate-200 bg-white px-3 py-5">
        <div className="mb-6 px-3">
          <div className="text-sm font-semibold tracking-tight text-slate-900">
            Análisis Bursátil
          </div>
          {/* Decía «investigación, no señales» y la portada dice COMPRAR: una
              de las dos mentía. La app sí da señales; lo que no hace es
              predecir. */}
          <div className="text-[11px] text-slate-400">reglas, no predicciones</div>
        </div>

        <nav className="flex flex-col gap-5">
          {NAV_GROUPS.map((group, i) => (
            <div key={group.title ?? i} className="flex flex-col gap-0.5">
              {group.title && (
                <div className="mb-1 px-3 text-[10px] font-medium uppercase tracking-wider text-slate-300">
                  {group.title}
                </div>
              )}
              {group.items.map(({ to, label }) => (
                <NavLink
                  key={to}
                  to={to}
                  className={({ isActive }) =>
                    `rounded-md px-3 py-1.5 text-sm transition-colors ${
                      isActive
                        ? 'bg-slate-100 font-medium text-slate-900'
                        : 'text-slate-500 hover:text-slate-900'
                    }`
                  }
                >
                  {label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="mt-auto space-y-3 px-3 pt-6">
          <ApiUsageBar />
          <p className="text-[10px] leading-snug text-slate-400">
            Herramienta personal. Da señales de compra y venta a partir de
            reglas mecánicas escritas — no es asesoría financiera, no predice
            precios y no ejecuta órdenes. La decisión es tuya.
          </p>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-6 py-7">
        <Outlet />
      </main>
    </div>
  )
}
