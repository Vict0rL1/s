import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { DashboardPage } from './pages/DashboardPage'
import { EtfsPage } from './pages/EtfsPage'
import { NewsPage } from './pages/NewsPage'
import { Placeholder } from './pages/Placeholder'
import { ScreenerPage } from './pages/ScreenerPage'
import { TickerPage } from './pages/TickerPage'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Navigate to="/ticker" replace />} />
          <Route path="/ticker" element={<TickerPage />} />
          <Route path="/ticker/:symbol" element={<TickerPage />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/noticias" element={<NewsPage />} />
          <Route path="/etfs" element={<EtfsPage />} />
          <Route path="/screener" element={<ScreenerPage />} />
          <Route
            path="/portafolio"
            element={<Placeholder title="Watchlist y portafolio" phase={5} />}
          />
          <Route
            path="/tesis"
            element={<Placeholder title="Escenarios y notas de tesis" phase={5} />}
          />
          <Route path="*" element={<Navigate to="/ticker" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
