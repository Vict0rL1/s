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

Una sola terminal, un solo comando:

```bash
./start.sh
```

La primera vez crea el entorno virtual de Python, instala las dependencias de
backend y frontend y genera `.env` a partir de la plantilla (tarda un par de
minutos). Después arranca directo en unos segundos. `Ctrl+C` para los dos
procesos a la vez.

Antes de la primera ejecución real, rellena tus API keys:

```bash
open -e .env      # macOS; en Linux, el editor que uses
```

Abre http://localhost:5173. La documentación interactiva del API está en
http://localhost:8000/docs. Los logs quedan en `/tmp/bolsa-backend.log` y
`/tmp/bolsa-frontend.log`.

`start.sh` reinstala las dependencias de Python solo si `requirements.txt`
cambió (compara un hash), y libera los puertos 8000 y 5173 si quedaron
ocupados por una ejecución anterior que no cerró bien.

<details>
<summary>Arranque manual (dos terminales)</summary>

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

</details>

### Tests

```bash
cd backend && .venv/bin/python -m pytest   # lógica financiera, caché, router, API
cd frontend && npm run build               # type-check estricto + build
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
| **Hoy** | Pantalla de entrada. S&P 500, NASDAQ y grandes canadienses puntuadas y ordenadas en una sola lista, sin elegir nada. Ver abajo. |
| **Mercado** | Índices vía ETFs proxy, sectores SPDR, curva de rendimientos y spread 10A-2A, macro FRED, próximos resultados. |
| **Acciones** | Gráfico de velas con SMA/RSI/MACD, fundamentales, estados financieros de EDGAR, DCF por escenarios con sensibilidad, Altman Z / Piotroski F, riesgo (beta, volatilidad, drawdown), filings e insiders. |
| **Noticias** | Feed por ticker o general, con interpretación de IA bajo demanda claramente etiquetada. |
| **ETFs** | Composición, expense ratio, AUM, desglose sectorial, comparador y **solapamiento entre ETFs**. |
| **Screener** | Filtros combinables con presets que documentan su lógica de inversión. |
| **Portafolio** | Posiciones con P&L realizado y no realizado, pesos, exposición sectorial, avisos de concentración, watchlist y alertas de precio. |
| **Señales** | Modelo cuantitativo de factores con validación walk-forward. Ver abajo. |
| **Tesis** | Tesis fechadas con criterios de invalidación, escenarios anclados al precio del día y **registro de aciertos** con tasa de acierto y error mediano. |

## Informe de analista (pestaña «Informe completo»)

Deep dive por empresa que reúne negocio, crecimiento, márgenes, deuda, caja,
valoración, riesgos, catalizadores y una lectura conjunta. **Todo se calcula a
partir de datos** (EDGAR + precios cacheados); la narrativa en prosa es un
botón aparte, opcional, y va etiquetada como IA.

La pieza que no existía en ningún otro sitio de la app es **valoración frente
a su propia historia**: series de P/E, P/B y FCF yield reconstruidas mes a mes
con disciplina point-in-time (cada punto usa el ejercicio que ya estaba
publicado en esa fecha), y el percentil donde cae el múltiplo actual dentro de
su propio rango de 10 años. Responde a "¿está cara o barata frente a sí
misma?", que suele informar más que compararla con el mercado.

Va con dos advertencias que el módulo no esconde: los múltiplos usan el EPS
anual publicado (no TTM trimestral), así que la serie es más rugosa que la de
un terminal profesional; y **cotizar barato frente a su historia no implica
estar infravalorada** — una empresa en declive estructural se abarata de forma
permanente. Esa es la trampa de valor clásica, y la app la nombra.

La sección **Lectura conjunta** sintetiza qué dicen los datos con su postura
(constructiva / mixta / cautelosa), lo que juega a favor y en contra, y —
siempre — **qué observaciones futuras romperían esa lectura**. No dice
"comprar": qué hacer depende de tu cartera, horizonte y tolerancia al riesgo,
que el modelo no conoce.

## La vista «Hoy»

La app abre con una lista única: todas las empresas del mercado elegido,
puntuadas y ordenadas de mejor a peor, separadas en **favorables**
(puntuación ≥ 0,35) y **a evitar** (≤ −0,35). No hay que elegir universo ni
configurar nada — se filtra por sector si se quiere, y cada fila se despliega
para ver de dónde sale la puntuación.

### Mercados

| Mercado | Empresas | Por qué así |
|---|---|---|
| **EE. UU. — S&P 500** | 502 | Los componentes del índice, por sector GICS. Todas reportan a la SEC, así que EDGAR cubre sus fundamentales gratis. |
| **NASDAQ — grandes cotizadas** | 310 | Las mayores del NASDAQ por bolsa y tamaño. **No se presenta como el índice Nasdaq-100**: no hay fuente pública de su composición que se pueda automatizar, y afirmar que lo es sería atribuirle una precisión que el dato no tiene. |
| **Canadá — cotizadas en EE. UU.** | 44 | Grandes canadienses con cotización en NYSE/NASDAQ. **Se usan sus tickers estadounidenses a propósito**: esas empresas presentan formulario 40-F ante la SEC, así que tienen los mismos datos que una estadounidense. Con los tickers de Toronto habría que bajar a yfinance, que el proyecto solo admite como respaldo. |

**Los mercados son vistas, no particiones.** El NASDAQ se solapa con el S&P 500
(unas 150 empresas) y eso es correcto: se mira un mercado cada vez, y una
empresa puntúa distinto en cada lista porque cambia con quién se la compara —
NVDA frente a las tecnológicas del S&P no es lo mismo que frente a las del
NASDAQ. La excepción es Canadá, que es un mercado *residual*: excluye lo que ya
cubre el S&P 500, donde esas empresas tienen comparables más limpios.

**Se puntúa dentro de cada sector y luego se mezclan los resultados.** Es más
caro que un z-score global (uno por sector en vez de uno solo) pero es la única
forma honesta de producir una lista única: comparar el P/E de un banco con el
de una tecnológica premiaría a sectores enteros por tener múltiplos
estructuralmente bajos. Un sector con menos de 3 empresas puntuables se
descarta entero en vez de contaminar la lista con z-scores sin sentido.

### Cobertura incremental

El S&P 500 son ~500 empresas y los tiers gratuitos dan 60 llamadas/minuto. El
limitador de cuota **descarta, no espera**, así que lanzar 500 llamadas de
golpe puntuaría las primeras 60 y perdería el resto. En su lugar cada petición
descarga como mucho 120 fundamentales nuevos, los cachea 24 h y deja el resto
pendiente; la siguiente pasada sigue por donde iba, porque lo ya cacheado sale
gratis. La UI muestra la barra de cobertura y un botón para continuar. Los
nombres de las empresas salen del propio archivo del universo: pedirlos al API
costaría otras 500 llamadas por información puramente cosmética.

### De dónde salen las listas

`backend/app/data/universe_*.csv` los genera `scripts/refresh_universes.py`
desde fuentes públicas citables — nunca escritas a mano, porque son ~550
empresas con su sector y un sector equivocado no es cosmético: distorsiona el
z-score de todos sus comparables.

```bash
cd backend && python scripts/refresh_universes.py
```

- **S&P 500:** [datasets/s-and-p-500-companies](https://github.com/datasets/s-and-p-500-companies) (Open Data Commons PDDL).
- **NASDAQ y Canadá:** [JerBouma/FinanceDatabase](https://github.com/JerBouma/FinanceDatabase) (MIT), filtrando por bolsa, tamaño y país.

El script descarta lo que no es acción ordinaria (warrants tipo `CVE-WT`,
preferentes, notas), deduplica contra el S&P 500 y lleva una lista corta de
defectos conocidos de la fuente, cada uno con su motivo: `AQNB` son notas
subordinadas de Algonquin y no su acción, e `IOT` (Samsara) es estadounidense
pese a figurar como canadiense. `universes_meta.json` guarda la procedencia y
la fecha, y la UI muestra cuándo se actualizó el universo.

**Qué significa «favorable», y qué no.** Que una empresa encabece la lista
significa que puntúa mejor que sus comparables *de su propio sector* en valor,
calidad y momentum. No significa que vaya a subir, ni que convenga comprarla:
eso depende de la cartera, el horizonte y la tolerancia al riesgo de cada uno.
La lista sirve para decidir **qué mirar primero**, no qué comprar — y la app lo
dice en pantalla, no en la letra pequeña.

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

#### Activarlo

Pon `ANTHROPIC_API_KEY` en `.env` (se saca en
https://console.anthropic.com/settings/keys) y reinicia con `./start.sh`. La
barra superior muestra **IA activa** con el modelo en uso, o **IA off**
tachado si la key falta.

**Sin key la app funciona entera**: precios, fundamentales, valoración, salud,
señales, backtest e informe cuantitativo no tocan el LLM — solo desaparecen
los tres botones de interpretación escrita. Es la única API de pago del
proyecto (las demás tienen tier gratuito), así que solo corre cuando pulsas
uno de esos botones, con `max_tokens` acotado, y el resultado se guarda por
hash del prompt: repetir la misma consulta no vuelve a cobrar.

## Estado

Las cinco fases están completas. Ver `TODO.md` para limitaciones conocidas y
mejoras pendientes.
