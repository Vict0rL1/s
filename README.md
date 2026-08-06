# Análisis Bursátil

Aplicación web **local** de investigación de acciones y ETFs: precios,
fundamentales, valoración por escenarios, noticias, screener, portafolio y
registro de tesis. Herramienta de estudio personal — **no da señales de
compra, no predice precios y no ejecuta órdenes**.

## Principios de diseño (no negociables)

- **Toda cifra lleva fuente y fecha.** El backend nunca entrega un número sin
  `source` y `as_of`; la UI lo muestra siempre (badge junto a cada bloque),
  incluyendo si el dato viene de caché y desde cuándo.
- **Sin predicciones puntuales.** El DCF devuelve escenarios bajista/base/
  alcista con supuestos editables y una matriz de sensibilidad, nunca un
  precio objetivo único.
- **Lo calculado ≠ lo generado por LLM.** Indicadores y ratios se calculan a
  partir de datos; el contenido de IA aparece con etiqueta morada, modelo
  usado y disclaimer, y queda registrado en `llm_outputs`.
- **Registro de aciertos.** Toda tesis y escenario se guarda con fecha y
  precio ancla; la vista de Tesis compara después cómo envejeció, con tasa de
  acierto y error mediano de estimación. Si el modelo falla seguido, se ve.
- **Un dato ausente se muestra como "—", nunca como cero.** Un filtro del
  screener nunca se aprueba por falta de datos; una posición sin precio no
  vale cero, queda fuera de los totales y la UI lo dice.

## Stack

- **Backend:** Python 3.11+, FastAPI, SQLAlchemy (SQLite), pandas/numpy.
- **Frontend:** React 19 + Vite + TypeScript, Tailwind CSS 4,
  `lightweight-charts` para precios.
- **IA (opcional):** SDK de Anthropic (Claude) para la capa de interpretación.

## Setup

```bash
# 1. Variables de entorno
cp .env.example .env      # y rellena tus API keys

# 2. Backend (puerto 8000)
cd backend
python3 -m venv .venv && source .venv/bin/activate
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
cd backend && python -m pytest        # 101 tests: lógica financiera, caché, router, API
cd frontend && npm run build          # type-check estricto + build
```

## Fuentes de datos y sus límites (verificado 2026)

| Fuente | Uso | Tier gratuito |
|---|---|---|
| **SEC EDGAR** | Estados financieros, filings, insiders | **Gratis, sin key** — fuente prioritaria |
| **FRED** | Macro: tasas, curva, inflación, desempleo | Gratis con key |
| Finnhub | Cotizaciones, perfil, fundamentales TTM, noticias, calendario, pares | ~60 llamadas/min |
| Twelve Data | Histórico de precios | 8/min y ~800 créditos/día |
| yfinance | **Solo respaldo** + composición de ETFs | No oficial, puede romperse |
| Alpha Vantage | *No se usa por defecto* | 25/día no da para un flujo útil |
| Anthropic (Claude) | Interpretación de noticias (opcional) | De pago, solo bajo demanda |

Notas: el endpoint de velas de Finnhub dejó de ser gratuito en 2024, por eso
el histórico viene de Twelve Data. IEX Cloud cerró en 2024; Polygon.io ahora
se llama Massive (no se usan).

## Cómo se minimiza el gasto de API

El coste es una restricción de diseño, no una optimización posterior:

| Palanca | Detalle |
|---|---|
| **EDGAR primero** | Una descarga de `companyfacts` (gratis, caché 24 h) alimenta ratios, crecimiento, DCF, Altman Z y Piotroski F. Ninguna API de pago participa en el análisis fundamental. |
| **TTL por tipo de dato** | Cotización 1 min · histórico 15 min · fundamentales/filings 24 h · calendario 12 h · **pares 7 días · composición de ETFs 7 días**. |
| **Carga perezosa en la UI** | La vista de ticker solo pide datos de la pestaña abierta; el resto no gasta nada hasta que la abres. |
| **LLM bajo demanda** | La interpretación de una noticia solo se genera con botón explícito, con `max_tokens` acotado, y se guarda con hash del prompt: repetirla no vuelve a llamar al API. |
| **Screener acotado** | Evalúa el universo que le das (máx. 25 tickers) con fundamentales cacheados, en vez de fingir un barrido de mercado imposible con tiers gratuitos. |
| **Rate limiter multiventana** | Modela límites simultáneos (Twelve Data: 8/min *y* 800/día) y salta un proveedor sin cuota antes de gastar la llamada. |
| **Contador visible** | Cada API muestra sus llamadas restantes en la barra lateral. |

## Arquitectura de datos

```
endpoint HTTP → MarketDataService → CacheStore (SQLite, TTL por tipo de dato)
                                  → DataRouter  (orden de fuentes por tipo,
                                                 rate limits, backoff, fallback)
                                  → DataProvider (edgar | fred | finnhub |
                                                  twelvedata | yfinance)
```

- **`DataProvider`** (`backend/app/providers/base.py`): interfaz común; cada
  API es una clase intercambiable. Si una API muere, se reemplaza una clase.
- **Caché primero** (`backend/app/cache/cache.py`): toda respuesta se guarda
  con timestamp y conserva su `source` original al servirse desde caché.
- **Router de fuentes** (`backend/app/providers/router.py`): orden por tipo de
  dato, salta proveedores sin key o sin cuota, reintenta con backoff
  exponencial y cae a la siguiente fuente ante rate limit. `DataNotFoundError`
  no dispara fallback: si el símbolo no existe, probar otra fuente solo quema
  cuota.
- **Capa LLM** (`backend/app/llm/`): interfaz `LLMProvider` con implementación
  Anthropic; la app funciona igual sin `ANTHROPIC_API_KEY` (el endpoint
  devuelve 503 explicándolo).

### Decisiones de arquitectura

- **SQLite + `create_all`** (sin Alembic por ahora): app local de un solo
  usuario. La base vive en `backend/data/app.db` (gitignored).
- **Unidades normalizadas:** márgenes, ROE, crecimientos y yields se guardan
  como *fracción* (0.25 = 25 %) sin importar cómo los reporte cada API.
- **Las API keys nunca llegan al navegador:** el frontend habla solo con el
  backend local (proxy `/api` en Vite).
- **El precio ancla se captura al crear el escenario**, no al evaluarlo: sin
  ese ancla el registro de aciertos no podría existir.

## Módulos

| Vista | Qué hace |
|---|---|
| **Mercado** | Índices vía ETFs proxy, sectores SPDR, curva de rendimientos y spread 10A-2A, macro FRED, próximos resultados. |
| **Acciones** | Gráfico de velas con SMA/RSI/MACD, fundamentales, estados financieros de EDGAR, DCF por escenarios con sensibilidad, Altman Z / Piotroski F, riesgo (beta, volatilidad, drawdown), filings e insiders. |
| **Noticias** | Feed por ticker o general, con interpretación de IA bajo demanda claramente etiquetada. |
| **ETFs** | Composición, expense ratio, AUM, desglose sectorial, comparador y **solapamiento entre ETFs**. |
| **Screener** | Filtros combinables con presets que documentan su lógica de inversión. |
| **Portafolio** | Posiciones con P&L realizado y no realizado, pesos, exposición sectorial, avisos de concentración, watchlist y alertas de precio. |
| **Tesis** | Tesis fechadas con criterios de invalidación, escenarios anclados al precio del día y **registro de aciertos** con tasa de acierto y error mediano. |

## Estado

Las cinco fases están completas. Ver `TODO.md` para limitaciones conocidas y
mejoras pendientes.
