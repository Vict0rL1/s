import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Layout } from './components/Layout'
import { DashboardPage } from './pages/DashboardPage'
import { EarningsPage } from './pages/EarningsPage'
import { EtfsPage } from './pages/EtfsPage'
import { MultifactorPage } from './pages/MultifactorPage'
import { NewsPage } from './pages/NewsPage'
import { PortfolioPage } from './pages/PortfolioPage'
import { ScreenerPage } from './pages/ScreenerPage'
import { SignalsPage } from './pages/SignalsPage'
import { ThesesPage } from './pages/ThesesPage'
import { ValuationPage } from './pages/ValuationPage'
import { VigilanciaPage } from './pages/VigilanciaPage'
import { TickerPage } from './pages/TickerPage'
import { TodayPage } from './pages/TodayPage'

export default function App() {
  return (
    <BrowserRouter>
      <ErrorBoundary>
        <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Navigate to="/hoy" replace />} />
          <Route path="/hoy" element={<TodayPage />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/ticker" element={<TickerPage />} />
          <Route path="/ticker/:symbol" element={<TickerPage />} />
          <Route path="/noticias" element={<NewsPage />} />
          <Route path="/etfs" element={<EtfsPage />} />
          <Route path="/screener" element={<ScreenerPage />} />
          <Route path="/multifactor" element={<MultifactorPage />} />
          <Route path="/resultados" element={<EarningsPage />} />
          <Route path="/valoracion" element={<ValuationPage />} />
          <Route path="/senales" element={<SignalsPage />} />
          <Route path="/portafolio" element={<PortfolioPage />} />
          <Route path="/tesis" element={<ThesesPage />} />
          <Route path="/vigilancia" element={<VigilanciaPage />} />
          <Route path="*" element={<Navigate to="/hoy" replace />} />
        </Route>
        </Routes>
      </ErrorBoundary>
    </BrowserRouter>
  )
}
