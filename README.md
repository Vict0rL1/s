# Análisis Bursátil

Aplicación web **local** de investigación y decisión sobre acciones y ETFs:
precios, fundamentales, valoración por escenarios, noticias, screener,
portafolio, registro de tesis y un **motor de decisión que dice qué comprar, a
qué precio, con qué stop y cuándo vender**. Herramienta personal — **no predice
precios y no ejecuta órdenes**.

## Principios de diseño (no negociables)

- **Una señal es una regla, no una opinión.** El motor de decisión emite
  comprar/vigilar/mantener/reducir/vender a partir de condiciones escritas en
  `analysis/decision.py`, con sus umbrales visibles y sus tests. Se puede leer
  por qué dijo lo que dijo, discutirlo y cambiarlo. Lo que nunca hace es
  presentar una corazonada con aire de cálculo.
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
| **Hoy** | Pantalla de entrada. S&P 500, NASDAQ y grandes canadienses puntuadas, cruzadas con tu cartera y resueltas en una acción concreta —comprar, vigilar, mantener, reducir, vender— con precio de entrada, stop, objetivo y tamaño. Ver abajo. |
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
siempre — **qué observaciones futuras romperían esa lectura**. Es contexto para
entender la empresa, no la decisión: quien dice comprar o vender es el motor de
decisión de la vista **Hoy**, con sus reglas y sus niveles.

## La vista «Hoy»

La app abre en **Mejores ideas**: como mucho cinco empresas, cada una con su
puesto, por qué está ahí, a qué precio comprar, dónde vender y qué porcentaje de
cartera destinarle. Debajo, **lo que NO comprar ahora**.

**Por qué existe esta vista.** El motor de decisión llegaba a marcar ~100
empresas como «Comprar», y eso no es una recomendación: es un filtro. Un umbral
contesta *¿quién califica?*; una recomendación contesta *¿cuáles pocas?* Cien
opciones dejan el trabajo difícil —elegir— exactamente donde estaba.

La convicción que ordena la lista corta no es la puntuación a secas:

- **Cuánto supera el listón**, no si lo supera. Pasar de 0,36 y pasar de 1,20 son
  situaciones que un umbral binario aplasta.
- **Si los factores están de acuerdo.** Una empresa buena en valor, calidad y
  momentum a la vez es más sólida que otra con la misma nota media sostenida por
  un solo factor mientras otro se hunde — esa segunda es una apuesta a un factor
  disfrazada por el promedio.
- **Cuánto hay que arriesgar para participar.** A igualdad de todo, gana la del
  stop más ceñido: permite más posición con el mismo riesgo.
- **Máximo dos por sector.** Cinco tecnológicas no son cinco ideas, son una
  apuesta repartida en cinco tickets; se hunden juntas.

La lista corta **ordena y recorta, no relaja nada**: solo entran empresas que ya
pasaron todas las reglas del motor. Y las demás no desaparecen — siguen en «Todas
las que califican», porque esconder información no es simplificar.

Si un día no cumple ninguna, lo dice: *«Hoy no hay ninguna compra. No actuar
también es una decisión»*. Rellenar la lista con lo mejor de un día malo es
justo cómo una herramienta te empuja a operar cuando no toca.

**«Lo que NO comprar» tiene su propio texto**, no el de las ideas al revés. Decir
«destaca en valor» de algo que la app te dice que evites invita justo a lo
contrario; ahí manda lo que va en contra, y cuando una empresa está barata pero
en declive se nombra por lo que es: la trampa de valor clásica.

Las demás vistas siguen ahí: **Todas las que califican**, **Vigilar**, **Mi
cartera** y **Todas**. No hay que elegir universo ni configurar nada — se
filtra por sector o se busca por ticker, y cada fila se despliega para ver los
niveles concretos y de dónde sale la puntuación.

### Mercados

| Mercado | Empresas | Por qué así |
|---|---|---|
| **EE. UU. — S&P 500** | 502 | Los componentes del índice, por sector GICS. Todas reportan a la SEC, así que EDGAR cubre sus fundamentales gratis. |
| **NASDAQ — grandes cotizadas** | 310 | Las mayores del NASDAQ por bolsa y tamaño. **No se presenta como el índice Nasdaq-100**: no hay fuente pública de su composición que se pueda automatizar, y afirmar que lo es sería atribuirle una precisión que el dato no tiene. |
| **Canadá — cotizadas en EE. UU.** | 44 | Grandes canadienses con cotización en NYSE/NASDAQ. **Se usan sus tickers estadounidenses a propósito**: esas empresas presentan formulario 40-F ante la SEC, así que tienen los mismos datos que una estadounidense. Con los tickers de Toronto habría que bajar a yfinance, que el proyecto solo admite como respaldo. |

**Qué queda fuera, y por qué.** Los universos cubren empresas con cotización en
NYSE o NASDAQ. Una canadiense que solo cotice en Toronto — Aritzia (ATZ.TO), por
ejemplo — no aparece: sus fundamentales no están en EDGAR ni en el tier gratuito
de Finnhub, y la única fuente sería yfinance, que el proyecto admite como
respaldo pero no como fuente única de un mercado entero. La vista **Acciones**
sí analiza cualquier ticker que la fuente reconozca, esté o no en los universos.

**Nada queda inalcanzable.** Las vistas por acción son un filtro, no un recorte:
**Todas** lleva el universo entero —favorables, neutrales y a evitar— con
buscador por ticker o nombre. Casi la mitad del S&P 500 cae en la franja neutral,
y si no se pudiera consultar, buscar una empresa concreta y no encontrarla
parecería que el modelo no la cubre cuando en realidad la ha puntuado y ha salido
del montón.

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

### Precio y minigráfico gratis

Cada fila muestra el último cierre, la variación del día y un minigráfico del
último año; al desplegarla, el rango de 52 semanas y en qué percentil de ese
rango cotiza. **No cuesta ninguna llamada adicional**: la descarga masiva que
el momentum ya hacía por sector trae un año de cierres diarios y solo usaba dos
puntos. Pedir una cotización por empresa serían ~500 llamadas contra un tier de
60/min — inviable; derivarlas de lo ya descargado es gratis.

El precio hereda la frescura de esa descarga (caché de 6 h, fuente yfinance), y
la UI lo dice: la fila desplegada muestra fuente y antigüedad. Es un cierre
reciente, no una cotización en tiempo real, y la app no finge lo contrario.

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

## Motor de decisión: qué comprar, a qué precio y cuándo vender

La puntuación dice *cuál* mira primero. El motor de decisión
(`backend/app/analysis/decision.py`) dice **qué hacer con ella**: una acción
concreta, sus niveles y los disparadores que la cancelan. Es la diferencia
entre un ranking y una herramienta que se puede ejecutar.

### Las reglas, completas

Solo son ocho condiciones y están todas aquí. Si una es mala, se ve y se
cambia — no hay criterio discrecional escondido.

**Si no tienes la empresa:**

| Condición | Acción |
|---|---|
| Puntuación ≤ −0,35 | **Evitar** — queda por detrás de sus comparables de sector |
| Puntuación ≥ +0,35 **y** cotiza sobre su media de 200 sesiones | **Comprar** |
| Puntuación ≥ +0,35 pero por debajo de la media de 200 | **Vigilar** — buena empresa en tendencia bajista |
| Entre ambos umbrales | **Sin acción** |

El filtro de la media de 200 sesiones es el que evita el error caro de este
tipo de modelo: comprar algo *barato porque sigue cayendo*. Una empresa puede
puntuar excelente en valor precisamente porque el mercado la está descontando
por algo que los estados financieros aún no reflejan. La regla no la descarta,
la manda a **Vigilar** y espera a que el precio recupere la media.

«Sin acción» es un estado propio y no un sinónimo de «Vigilar»: casi la mitad
del S&P 500 cae en la franja neutral, y meterla en la lista de espera la
volvería inútil. Vigilar es para empresas buenas esperando que gire la
tendencia, no para el montón.

**Si ya la tienes** (el motor cruza la lista con tus posiciones abiertas del
Portafolio):

| Condición | Acción |
|---|---|
| Puntuación ≤ −0,35 | **Vender** — la razón por la que la compraste ya no se sostiene |
| Precio ≤ stop calculado sobre **tu precio de coste** | **Vender** |
| Cotiza bajo su media de 200 sesiones | **Reducir** |
| Resto | **Mantener**, con tu P&L sobre el precio de compra |

### Los niveles: stop, objetivo y tamaño

Toda propuesta de compra viene con su salida ya definida. Se calculan así:

- **Zona de entrada:** ±2 % sobre el último cierre. Perseguir un precio que ya
  se escapó cambia la relación riesgo/beneficio de la operación.
- **Stop:** 2 desviaciones mensuales (volatilidad diaria de 63 sesiones ×
  √21), acotado entre **8 % y 25 %**. Un stop fijo del 10 % para una utility y
  para una biotech no protege de nada: en una es imposible de tocar y en la
  otra salta con el ruido de un martes cualquiera.
- **Objetivo:** el doble del stop (ratio 1:2). Con esa relación no hace falta
  acertar más de la mitad de las veces para no perder dinero.
- **Peso sugerido:** el que hace que **saltar el stop cueste el 1 % de la
  cartera**. Stop lejano → posición pequeña. Así una idea equivocada cuesta lo
  mismo que cualquier otra, y el tamaño lo fija el riesgo en vez de la
  convicción. Es un **porcentaje de la cartera, no un número de acciones**: la
  app no sabe cuánto dinero tienes y no va a fingir que sí.

Cada fila desplegada muestra además **cuándo actuar**: la lista de
disparadores que ejecutan o cancelan la idea (comprar en este rango, salir
bajo este precio, tomar beneficios en este otro, revisar si pierde la media).

**Sobre una posición que ya tienes, los niveles cuelgan de tu coste, no del
precio de hoy.** El stop es un % bajo tu precio de compra —el que fijaste al
entrar, no uno recalculado cada día— y el objetivo se ancla igual; lo que se
muestra en pantalla es la distancia que queda **desde el precio actual**, que
puede ser positiva si el stop ya está perforado. No hay zona de compra ni peso
sugerido: no se propone entrar en algo que ya tienes, y menos si la acción es
vender.

### ¿Y funcionan? El backtest de reglas

Hay **dos backtests** en la app porque hay dos preguntas, y una puede salir
bien con la otra mal:

| Backtest | Pregunta | Endpoint |
|---|---|---|
| **Modelo** | ¿La puntuación ordena las empresas mejor que la mediana? | `POST /api/signals/backtest` |
| **Reglas** | ¿Comprar sobre la SMA200 con este stop y este objetivo gana dinero? | `POST /api/signals/rule-backtest` |

El segundo es el que valida lo que la app realmente ejecuta, y es una
**simulación por eventos**: en cada fecha se puntúa el universo con datos
point-in-time, se abre posición en las que cumplen las reglas, y cada operación
se sigue sesión a sesión hasta que salta el stop, toca el objetivo o vence el
año. Tres decisiones lo gobiernan:

- **Se entra al cierre siguiente a la señal.** Comprar al precio del día en que
  se conoce la señal es comprar con información que aún no tenías. Es el error
  que hace brillar a los backtests caseros.
- **Los costes van dentro.** Comisión, deslizamiento y —por defecto— la
  conversión CAD→USD, que en un bróker canadiense ronda el 1,5 % por lado. Un
  sistema con stops rota posiciones, así que el coste no es un detalle: son
  ~3,3 % por operación completa, y suele pesar más que la ventaja del modelo.
- **Ante la duda, el caso malo.** Con datos diarios no se sabe si dentro de una
  sesión se tocó antes el stop o el objetivo: se asume stop. Y la salida usa el
  cierre real, no el precio del stop, porque un hueco a la baja no te llena
  donde querías.

Siempre se compara contra **comprar el universo entero a ciegas** en las mismas
fechas. Un 55 % de aciertos no significa nada si no hacer nada daba más — y en
las pruebas hechas hasta ahora, a veces daba más. La app lo dice en esos
términos: *«las reglas ganan menos que no hacer nada; el trabajo extra no se
paga»*. También mide el **filtro de la media de 200 sesiones con y sin él**,
porque mantener una regla sin poder comprobar si aporta es un acto de fe.

**Sesgo de supervivencia: presente y declarado.** Los universos son los miembros
de HOY del índice; las que quebraron o fueron expulsadas no están. Cualquier
resultado está inflado en una cantidad que no se puede medir con fuentes
gratuitas, y la UI lo dice en cada ejecución en vez de esconderlo en la
metodología.

### La advertencia que no se quita

Cada decisión lleva un campo `confidence` con tres valores que importan:

| Valor | Qué significa |
|---|---|
| **calibrada** | El backtest de reglas tiene ≥ 30 operaciones, esperanza positiva y supera a comprar a ciegas. |
| **refutada** | Se probaron y **perdieron dinero**, o ganaron menos que no hacer nada. |
| **sin calibrar** | No se ha ejecutado el backtest, o no hay muestra suficiente. |

`refutada` es el estado que ninguna herramienta enseña y el único que de verdad
ahorra dinero, así que no va en gris: la fila desplegada lo pinta en rojo y dice
que la operación mostrada es lo que dictan las reglas, no una recomendación.
Pesa más que una probabilidad del modelo de factores, porque son cosas distintas
—el modelo puede ordenar bien y las reglas perder igualmente.

Las reglas son defendibles —dimensionar el stop por volatilidad, no comprar
contra la tendencia, arriesgar lo mismo en cada idea—, pero *razonable* y
*validado* no son lo mismo, y la app no usa una palabra por la otra. Que el
sistema diga «Comprar» significa que se cumplen unas condiciones escritas, no
que la empresa vaya a subir.

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

**Este módulo puntúa; no decide.** Sus etiquetas siguen siendo *muy favorable /
favorable / neutral / desfavorable / muy desfavorable*: describen cómo queda la
empresa frente a sus comparables, y nada más. Convertir eso en «comprar» o
«vender» es trabajo del [motor de decisión](#motor-de-decisión-qué-comprar-a-qué-precio-y-cuándo-vender),
que añade el filtro de tendencia, los niveles y el tamaño. La separación
importa: así se puede cambiar un umbral de decisión sin tocar el modelo de
factores, y saber cuál de los dos falló cuando algo sale mal.

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
