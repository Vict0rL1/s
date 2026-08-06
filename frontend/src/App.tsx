import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { DashboardPage } from './pages/DashboardPage'
import { EtfsPage } from './pages/EtfsPage'
import { NewsPage } from './pages/NewsPage'
import { PortfolioPage } from './pages/PortfolioPage'
import { ScreenerPage } from './pages/ScreenerPage'
import { ThesesPage } from './pages/ThesesPage'
import { TickerPage } from './pages/TickerPage'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/ticker" element={<TickerPage />} />
          <Route path="/ticker/:symbol" element={<TickerPage />} />
          <Route path="/noticias" element={<NewsPage />} />
          <Route path="/etfs" element={<EtfsPage />} />
          <Route path="/screener" element={<ScreenerPage />} />
          <Route path="/portafolio" element={<PortfolioPage />} />
          <Route path="/tesis" element={<ThesesPage />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
