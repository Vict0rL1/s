# Análisis Bursátil

Aplicación web **local** de investigación de acciones y ETFs: precios,
fundamentales, valoración por escenarios, noticias y registro de tesis.
Herramienta de estudio personal — **no da señales de compra, no predice
precios y no ejecuta órdenes**.

## Principios de diseño (no negociables)

- **Toda cifra lleva fuente y fecha.** El backend nunca entrega un número sin
  `source` y `as_of`; la UI lo muestra siempre (badge junto a cada bloque),
  incluyendo si el dato viene de caché y desde cuándo.
- **Sin predicciones puntuales.** Las proyecciones (fases futuras) son
  escenarios bajista/base/alcista con supuestos visibles y editables, y
  rangos en vez de números únicos.
- **Lo calculado ≠ lo generado por LLM.** Los indicadores y ratios se
  calculan a partir de datos y se marcan como tales; el contenido de LLM
  (Fase 3) queda etiquetado visualmente y registrado en `llm_outputs`.
- **Registro de aciertos.** Toda tesis/escenario se guarda con fecha y precio
  de creación para poder evaluar después cómo envejeció (tablas `scenarios` y
  `evaluations`).
- **Un dato ausente se muestra como “—”, nunca como cero.**

## Stack

- **Backend:** Python 3.11+, FastAPI, SQLAlchemy (SQLite), pandas/numpy.
- **Frontend:** React 19 + Vite + TypeScript, Tailwind CSS 4,
  `lightweight-charts` para precios (Recharts llegará con los módulos de
  fases posteriores).

## Setup

```bash
# 1. Variables de entorno
cp .env.example .env      # y rellena tus API keys

# 2. Backend (puerto 8000)
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload

# 3. Frontend (puerto 5173; proxya /api al backend)
cd frontend
npm install
npm run dev
```

Abre http://localhost:5173. La documentación interactiva del API está en
http://localhost:8000/docs.

### Tests

```bash
cd backend && python -m pytest        # lógica financiera, caché, router de fuentes, API
cd frontend && npm run build          # type-check estricto + build
```

## Fuentes de datos y sus límites (verificado 2026)

| Fuente | Uso | Tier gratuito |
|---|---|---|
| Finnhub | Cotizaciones en vivo (EE. UU.), perfil, fundamentales | ~60 llamadas/min |
| Twelve Data | Histórico de precios, cotizaciones (retraso ~15 min) | ~800 créditos/día |
| Alpha Vantage | Fundamentales y News & Sentiment (fases 2-3) | ~25 llamadas/día |
| SEC EDGAR | Filings e insider trading (Fase 2) | Gratis, sin key (exige User-Agent identificado) |
| FRED | Datos macro (Fase 2) | Gratis con key |
| yfinance | **Solo respaldo** (no oficial, puede romperse) | — |

Notas: el endpoint de velas de Finnhub (`/stock/candle`) dejó de ser gratuito
en 2024, por eso el histórico viene de Twelve Data con yfinance de respaldo.
IEX Cloud cerró en 2024; Polygon.io ahora se llama Massive (no se usan).

## Arquitectura de datos

```
endpoint HTTP → MarketDataService → CacheStore (SQLite, TTL por tipo de dato)
                                  → DataRouter  (orden de fuentes por tipo,
                                                 rate limits, backoff, fallback)
                                  → DataProvider (finnhub | twelvedata | yfinance | ...)
```

- **`DataProvider`** (`backend/app/providers/base.py`): interfaz común; cada
  API es una clase intercambiable. Si una API muere, se reemplaza una clase.
- **Caché primero** (`backend/app/cache/cache.py`): TTLs — cotización 1 min,
  histórico 15 min, fundamentales/perfil/filings 24 h, macro 1 día. Con los
  tiers gratuitos, el caché es diseño central, no optimización.
- **Router de fuentes** (`backend/app/providers/router.py`): orden por tipo
  de dato, salta proveedores sin key o sin llamadas restantes, reintenta con
  backoff exponencial ante errores transitorios y cae a la siguiente fuente
  ante rate limit. Cada llamada real queda en `api_call_log`, que alimenta el
  contador de llamadas restantes visible en la UI.
- **Esquema completo** en `backend/app/db/models.py`: las tablas de fases
  futuras (tesis, escenarios, screener, ETFs...) ya están definidas para que
  el esquema sea estable desde el inicio.

### Decisiones de arquitectura

- **SQLite + `create_all`** (sin Alembic por ahora): app local de un solo
  usuario; se añadirá migración si el esquema empieza a cambiar con datos
  valiosos dentro. La base vive en `backend/data/app.db` (gitignored).
- **Unidades normalizadas:** márgenes, ROE, crecimientos y yields se guardan
  como *fracción* (0.25 = 25 %) sin importar cómo los reporte cada API; la
  conversión ocurre en cada provider, con tests.
- **Las API keys nunca llegan al navegador:** el frontend habla solo con el
  backend local (proxy `/api` en Vite).
- **`DataNotFoundError` no dispara fallback:** si un símbolo no existe,
  probar otra fuente solo quema cuota.

## Estado por fases

- ✅ **Fase 1** — esqueleto FastAPI + React, capa `DataProvider` con caché
  SQLite y router de fuentes, Finnhub + Twelve Data + yfinance, vista de
  ticker con gráfico (velas, volumen, SMA 20/50/200, RSI), fundamentales
  básicos y contador de uso de APIs.
- ⬜ **Fase 2** — análisis fundamental completo, valoración DCF por
  escenarios, comparables, salud financiera, EDGAR, FRED, dashboard.
- ⬜ **Fase 3** — noticias, sentimiento e interpretación LLM (Claude API).
- ⬜ **Fase 4** — ETFs (composición, solapamiento) y screener.
- ⬜ **Fase 5** — watchlist, portafolio, alertas, tesis y registro de aciertos.

Ver `TODO.md` para los pendientes concretos.
