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
| **Señales** | Modelo cuantitativo de factores con validación walk-forward. Ver abajo. |
| **Tesis** | Tesis fechadas con criterios de invalidación, escenarios anclados al precio del día y **registro de aciertos** con tasa de acierto y error mediano. |

## Motor de señales cuantitativas

Puntúa un universo de empresas **unas contra otras** (z-score transversal, no
umbrales absolutos) combinando cuatro familias de factores: valor (30 %),
calidad (30 %), momentum (30 %) y sentimiento de noticias (10 %). Horizonte
6-12 meses.

**La regla que gobierna el módulo: una probabilidad solo se publica si sale de
un backtest con muestra suficiente** (≥ 30 observaciones en su rango). Sin
calibrar, la app enseña la puntuación relativa y dice explícitamente que no
hay probabilidad estimada. Inventar un "72 % de subida" a partir de un z-score
sería la falsa precisión que esta app existe para evitar.

**Backtest walk-forward con disciplina point-in-time.** El error que arruina
los backtests caseros es el sesgo de anticipación: puntuar enero de 2023 con
el balance del ejercicio 2023, publicado en 2024. Aquí cada fecha de
rebalanceo usa solo estados financieros cuya **fecha de filing** es anterior
(con retardo conservador de 90 días si no se conoce), y el resultado se mide
hacia delante contra la mediana del universo. El factor de sentimiento queda
**excluido del backtest** porque las APIs gratuitas no dan histórico de
noticias — fingir que sí lo dan sería peor que omitirlo.

Los intervalos de confianza usan el **método de Wilson**, no la aproximación
normal: con muestras pequeñas o tasas extremas la normal produce intervalos
fuera de [0, 1] y subestima la incertidumbre, justo el régimen en el que
opera este modelo.

**Descubrimiento automático.** La pestaña *Descubrir* escanea universos
curados completos (mega caps, tecnología, salud, financiero, consumo, energía,
dividendos, o tu propia watchlist) y devuelve las mejor puntuadas sin que
escribas ningún ticker. El coste se controla así: el momentum de todo el
universo se descarga en **una sola operación** vía yfinance (gratis — pedirlo
a Twelve Data serían 30 créditos y 4 minutos por su límite de 8/min), los
fundamentales quedan cacheados 24 h, y el perfil (nombre y sector) solo se
pide para las finalistas, no para las 30. Si la cuota se agota a mitad, se
devuelve lo puntuado y se reporta lo que quedó fuera.

Los universos **sectoriales** dan comparaciones más limpias: contrastar el P/E
de un banco con el de una tecnológica distorsiona el factor valor.

**Etiquetas deliberadamente no accionables** — *muy favorable / favorable /
neutral / desfavorable / muy desfavorable*, nunca "comprar" o "vender". La
señal describe cómo puntúa la empresa en el modelo; qué hacer con tu dinero
depende de tu cartera, tu horizonte y tu tolerancia al riesgo, que el modelo
no conoce.

### Papel del LLM

Claude tiene exactamente dos funciones aquí, y **emitir la señal no es
ninguna de ellas** — un modelo de lenguaje predice tokens, no retornos:

1. **Clasificar noticias** en eventos estructurados (guidance al alza, riesgo
   regulatorio, dilución…) con un nivel de confianza. Los pesos numéricos los
   fija una tabla en el código, no el modelo, para que el factor sea auditable.
2. **Explicar** una señal ya calculada: qué factor tira hacia arriba, cuál
   hacia abajo, cuál es la debilidad del análisis y qué la invalidaría.

Todo lo generado por IA aparece con etiqueta morada, modelo usado y
disclaimer, y se registra en `llm_outputs`.

## Estado

Las cinco fases están completas. Ver `TODO.md` para limitaciones conocidas y
mejoras pendientes.
