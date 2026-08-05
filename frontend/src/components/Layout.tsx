import { NavLink, Outlet } from 'react-router-dom'
import { ApiUsageBar } from './ApiUsageBar'

const NAV = [
  { to: '/dashboard', label: 'Mercado' },
  { to: '/ticker', label: 'Acciones' },
  { to: '/noticias', label: 'Noticias' },
  { to: '/etfs', label: 'ETFs' },
  { to: '/screener', label: 'Screener' },
  { to: '/portafolio', label: 'Portafolio' },
  { to: '/tesis', label: 'Tesis' },
]

export function Layout() {
  return (
    <div className="flex min-h-screen bg-slate-50">
      <aside className="flex w-52 shrink-0 flex-col bg-slate-900 p-4 text-slate-200">
        <div className="mb-6">
          <div className="text-sm font-semibold tracking-wide text-white">
            Análisis Bursátil
          </div>
          <div className="text-xs text-slate-400">investigación, no señales</div>
        </div>
        <nav className="flex flex-col gap-1">
          {NAV.map(({ to, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `rounded-md px-3 py-2 text-sm ${
                  isActive
                    ? 'bg-slate-700 font-medium text-white'
                    : 'text-slate-300 hover:bg-slate-800'
                }`
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto space-y-3 pt-6">
          <ApiUsageBar />
          <p className="text-[10px] leading-snug text-slate-500">
            Herramienta de investigación personal. No es asesoría financiera ni
            genera recomendaciones de compra o venta.
          </p>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-6">
        <Outlet />
      </main>
    </div>
  )
}
