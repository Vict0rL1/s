import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { Placeholder } from './pages/Placeholder'
import { TickerPage } from './pages/TickerPage'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Navigate to="/ticker" replace />} />
          <Route path="/ticker" element={<TickerPage />} />
          <Route path="/ticker/:symbol" element={<TickerPage />} />
          <Route
            path="/dashboard"
            element={<Placeholder title="Dashboard de mercado" phase={2} />}
          />
          <Route
            path="/noticias"
            element={<Placeholder title="Noticias e interpretación" phase={3} />}
          />
          <Route path="/etfs" element={<Placeholder title="ETFs" phase={4} />} />
          <Route path="/screener" element={<Placeholder title="Screener" phase={4} />} />
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
