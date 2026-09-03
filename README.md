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
- **Analizar y dimensionar son dos preguntas, y viven en módulos distintos.**
  `decision.py` mira UNA empresa: si la tesis se sostiene, dónde está el stop,
  qué la invalidaría. El tamaño no se puede contestar desde ahí — depende de qué
  más tienes, de cuánto se parecen tus posiciones y de la volatilidad del
  conjunto — así que lo decide `sizing.py` viendo la cartera entera.
- **El riesgo se suma, no se mira de una en una.** Cada idea se dimensiona
  para arriesgar un 1 %, pero ocho posiciones al 1 % son un 8 % en riesgo
  simultáneo — y si cinco son del mismo sector caen juntas, así que cuentan
  como una apuesta grande. El Portafolio suma el riesgo abierto total y por
  grupo correlacionado (cripto va en bloque), y avisa al pasar los topes.
- **Registro de aciertos.** Toda tesis y escenario se guarda con fecha y
  precio ancla; la vista de Tesis compara después cómo envejeció, con tasa de
  acierto y error mediano de estimación. Si el modelo falla seguido, se ve.
- **Un dato ausente se muestra como "—", nunca como cero.** Un filtro del
  screener nunca se aprueba por falta de datos; una posición sin precio no
  vale cero, queda fuera de los totales y la UI lo dice.

## Tema oscuro por inversión de paleta

La interfaz se escribió en claro (`bg-white`, escala `slate`). Pasarla a oscuro
tocando cada componente serían cientos de ediciones y otras tantas ocasiones de
dejarse una a medias — así se acaba con texto gris sobre gris. En vez de eso,
`src/index.css` **redefine la paleta**: `bg-white` deja de ser blanco y
`text-slate-900` deja de ser casi negro, y el árbol entero cambia a la vez.

La contrapartida hay que saberla: los nombres ya no describen el color.
`slate-50` es el fondo más **oscuro** y `slate-900` el texto más **claro**. Un
componente nuevo se escribe pensando en jerarquía —fondo, superficie, texto—, no
en claro/oscuro. Los acentos (verde, rojo, ámbar, azul) se conservan porque son
semánticos; solo se oscurecen sus tintes de fondo, que en claro eran pastel y
sobre oscuro serían manchas.

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
| **EDGAR primero** | Una descarga de `companyfacts` (gratis, caché 24 h) alimenta ratios, crecimiento, DCF, Altman Z y Piotroski F. **También la puntuación diaria**: los múltiplos salen del último ejercicio publicado más el precio que la descarga de momentum ya trajo, así que puntuar las 502 del índice cuesta **cero llamadas de Finnhub**. Antes iban ahí y su tier de 60/min se agotaba en los primeros 60 símbolos, dejando el resto sin puntuar y secando la cuota que necesitan noticias y calendario. |
| **TTL por tipo de dato** | Cotización 1 min · histórico 15 min · fundamentales/filings 24 h · calendario 12 h · **pares 7 días · composición de ETFs 7 días**. |
| **Carga perezosa en la UI** | La vista de ticker solo pide datos de la pestaña abierta; el resto no gasta nada hasta que la abres. |
| **LLM bajo demanda** | La interpretación de una noticia solo se genera con botón explícito, con `max_tokens` acotado, y se guarda con hash del prompt: repetirla no vuelve a llamar al API. |
| **Screener acotado** | Evalúa el universo que le das (máx. 25 tickers) con fundamentales cacheados, en vez de fingir un barrido de mercado imposible con tiers gratuitos. |
| **Rate limiter multiventana** | Modela límites simultáneos (Twelve Data: 8/min *y* 800/día) y salta un proveedor sin cuota antes de gastar la llamada. |
| **Bloqueo por resultados** | Una sola llamada al calendario, cacheada 12 h, cubre el mercado entero: aplicar el filtro a 500 empresas cuesta lo mismo que a una. Entrar dos días antes de una presentación convierte una apuesta de factores en cara o cruz, así que la compra se **aplaza**, no se descarta. |
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
| **Cripto — grandes por capitalización** | 20 | **Sin estados financieros no hay valor ni calidad: la puntuación es momentum y nada más.** La app lo avisa en pantalla antes de enseñar ninguna idea, y el motor de convicción penaliza sola una idea sostenida por un factor único. Lista curada por capitalización y liquidez — no viene de un índice publicado, a diferencia de los mercados de acciones. |
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

**La app completa la cobertura sola**, encadenando hasta cuatro pasadas: tener
que pulsar «Seguir completando» tres o cuatro veces era trabajo manual para
llegar a algo que la app ya sabía que le faltaba. El tope existe porque cada
pasada gasta cuota de APIs gratuitas y agotarla en silencio dejaría el resto del
día sin datos; a partir de ahí el botón sigue estando.

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
  √21), acotado **según la clase de activo**: acciones 8-25 %, ETFs 6-20 %,
  cripto 15-60 %. Los topes no son un adorno: con el rango de las acciones
  aplicado a cripto, Bitcoin (27 %), Ethereum (37 %) y cualquier altcoin (60 %)
  se pegaban **todas** al tope de 25 % — el stop dejaba de dimensionarse por
  volatilidad y pasaba a ser una constante que el ruido normal perfora una y
  otra vez. Un stop que salta por ruido no protege, solo materializa pérdidas.
  La contrapartida se paga donde toca: con un stop del 60 %, arriesgar el mismo
  1 % obliga a una posición del 1,7 % de la cartera. Un stop fijo del 10 % para una utility y
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

Se ejecuta desde **Señales → Validar reglas** (hasta 15 tickers, el tope del
formulario) o, mejor, desde la línea de comandos sobre un universo amplio —
con 15 empresas salen pocas operaciones y el intervalo de confianza no concluye
nada:

```bash
cd backend
.venv/bin/python scripts/run_rule_backtest.py              # 40 empresas, 6 años
.venv/bin/python scripts/run_rule_backtest.py --n 60 --anos 8
.venv/bin/python scripts/run_rule_backtest.py --sin-divisa # si evitas el coste de cambio
```

Las 40 se toman **alternando sectores**, no las primeras alfabéticamente: un
backtest sobre 40 empresas del mismo sector mide ese sector, no las reglas. El
resultado se guarda igual que desde la interfaz, así que al terminar la vista
**Hoy** deja de decir «sin validar».

El segundo es el que valida lo que la app realmente ejecuta, y es una
**simulación por eventos**: en cada fecha se puntúa el universo con datos
point-in-time, se abre posición en las que cumplen las reglas, y cada operación
se sigue sesión a sesión hasta que salta el stop, toca el objetivo o vence el
año. Tres decisiones lo gobiernan:

- **Se entra al cierre siguiente a la señal.** Comprar al precio del día en que
  se conoce la señal es comprar con información que aún no tenías. Es el error
  que hace brillar a los backtests caseros.
- **Los costes van dentro, desagregados.** Comisión (0,10 %), media horquilla
  (0,03 %), deslizamiento (0,02 %) y —por defecto— conversión CAD→USD (1,50 %),
  todos **por lado**: una operación completa paga el doble, ~3,3 %. Van
  separados porque son mecanismos distintos y ajustarlos al bróker propio exige
  saber cuál toca. La horquilla es *media* porque se cruza una vez por lado, no
  entera.
- **Ante la duda, el caso malo.** Con datos diarios no se sabe si dentro de una
  sesión se tocó antes el stop o el objetivo: se asume stop. Y la salida usa el
  cierre real, no el precio del stop, porque un hueco a la baja no te llena
  donde querías.

**Ventanas rodantes.** El periodo se parte en cuatro y cada una se mide por
separado, porque una media agregada no puede contestar a la pregunta que
importa: *¿la ventaja es estable o sale entera de un tramo afortunado?* Un
sistema que gana en tres ventanas y pierde en una es otra cosa que uno que gana
en las cuatro — y el promedio los presenta idénticos.

**Distribución, no un número.** Se publican percentiles reales del histórico
simulado (p10 / mediana / p90, etiquetados bajista / base / alcista), no
supuestos. Dos sistemas con la misma media son cosas muy distintas si uno gana
poco casi siempre y el otro pierde nueve veces y acierta una enorme. La mediana
describe la operación corriente; el p10, lo que hay que poder aguantar.

**Calibración fuera de muestra.** `calibrate()` ajusta la tabla con TODAS las
observaciones y luego publica esas mismas tasas como si fueran predicciones —
es circular. `calibrate_walk_forward()` predice cada observación usando solo las
anteriores y comprueba después: reentrenamiento en cada paso. Ese número será
peor que el in-sample, y **si sale igual es señal de que algo no se está
midiendo bien**.

**Point-in-time de verdad, no solo por fecha de filing.** EDGAR devuelve las
cifras **reexpresadas**: puntuar 2021 con un dato corregido en 2023 es
look-ahead aunque se respete la fecha de publicación. Ahora se conserva el valor
tal como se reportó **la primera vez**, junto con la fecha real en que ese dato
concreto se publicó — más precisa que el retardo de 90 días que había que
suponer. La disponibilidad se degrada, nunca se adelanta.

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

## ETFs: otro activo, otros criterios

El modelo de factores de las acciones **no se reutiliza aquí**, y hacerlo sería
el error más fácil: un ETF no tiene P/E ni ROE propios, y los que se le calculan
son medias de sus posiciones — comparar el «P/E» de un ETF de tecnología con el
de uno de utilities mide en qué invierte cada uno, no cuál es mejor. Un z-score
de valor ahí produciría un ranking con aspecto riguroso y sin significado.

`POST /api/etfs/recomendar` (botón **Analizar y recomendar** en la vista ETFs)
usa lo que sí predice el resultado de un ETF:

1. **El coste, con peso doble.** Es el único factor con evidencia robusta y, a
   diferencia de la rentabilidad, es un dato conocido y garantizado: lo pagas
   gane o pierda el fondo. Se muestra en dinero —«75 € al año por cada
   10.000»— porque «0,75 %» no significa nada a simple vista.
2. **La tendencia.** El mismo filtro de la media de 200 sesiones.
3. **El tamaño.** Por debajo de 100 M$ hay riesgo real de liquidación, y si
   cierran el fondo te devuelven el dinero cuando a ellos les conviene.

Y avisa del error más caro al montar una cartera de ETFs: **dos fondos que se
solapan al 60 % no son dos ideas, son una repetida.** Se compran tres creyendo
que se diversifica y los tres llevan dentro las mismas diez empresas, así que la
cartera concentra justo lo que creía repartir.

Lo que **no** hace: predecir qué sector irá mejor. Elegir entre salud y energía
es una apuesta sectorial, y esa decisión es tuya.

## Tamaño de posición: `sizing.py`

Tenerlo dentro de `decide()` producía un error silencioso: cada idea devolvía
«peso sugerido 12,5 %» mirándose sola, así que aceptar ocho ideas daba el 100 %
de la cartera en ocho apuestas, varias del mismo sector, sin que nada lo
impidiera. **Cada número era correcto; el conjunto, insostenible.**

Ahora `decide()` devuelve `peso_bruto_pct` —lo que ese stop permite arriesgando
el 1 %— y el dimensionador aplica cuatro límites en cadena:

| Límite | Por qué |
|---|---|
| **10 % por posición** | Un stop ceñido puede justificar aritméticamente un 25 % en una empresa. El modelo puede estar equivocado sobre esa empresa, y entonces el tamaño no te salva el stop. |
| **25 % por sector** | Cinco tecnológicas no son cinco apuestas. |
| **25 % por clúster de correlación** | El sector es una aproximación. Dos empresas de sectores distintos con correlación 0,85 son una sola posición repartida. Se agrupa por enlace simple: basta un camino de correlación alta, porque exigir que *todas* las parejas lo estén partiría clusters reales y daría falsa diversificación. |
| **Volatility targeting al 12 %** | Se escala el libro entero. **Solo hacia abajo**: escalar hacia arriba es apalancarse, y esa decisión no la toma un algoritmo. |

Verificado de punta a punta: `12,5 % bruto → 10 % (tope) → 9,24 % (volatilidad)`,
con la cartera al 18,5 % invertido y volatilidad estimada clavada en el objetivo.

La volatilidad de cartera es √(wᵀΣw), no la suma ponderada: sumar volatilidades
ignora que las posiciones no se mueven a la vez y siempre exagera. Cuando una
correlación no se puede medir **se asume 0,5** — ni independencia (que
subestimaría) ni movimiento idéntico — y eso se declara como el supuesto que es.

### Los cuatro límites cuentan lo que YA tienes

Un tope que solo mira las ideas nuevas no es un tope. Con un 20 % en tecnología
ya en el libro, el dimensionador seguía autorizando otro 25 % del mismo sector:
45 % en una sola apuesta con el límite marcando verde. Ahora las posiciones
abiertas **ocupan presupuesto** en los cuatro límites:

- El tope por posición cuenta lo que ya tienes de ese símbolo.
- Sector y clúster reparten su 25 % entre lo que tienes y lo que añades.
- Los clústeres se calculan sobre candidatas **y** posiciones abiertas: una idea
  nueva correlacionada con algo que ya llevas es la que más falta hace detectar,
  y mirando solo las candidatas entre sí era invisible.
- El objetivo de volatilidad se mide sobre la cartera combinada. Si la que ya
  tienes se pasa sola, las ideas nuevas salen al 0 % y se dice por qué: no es
  que sean malas, es que no cabe más riesgo.

Las posiciones abiertas **no se redimensionan** aquí — qué hacer con lo que ya
tienes es mantener o soltar, y eso lo decide `decide()` mirando la tesis. Los
pesos que salen del dimensionador son **lo que se añade**, no el peso final.

Dos supuestos que van escritos en la respuesta y en pantalla: el peso de lo que
tienes se mide sobre el valor de tus posiciones abiertas —la app no registra tu
efectivo—, así que si guardas liquidez fuera tu concentración real es menor y
los topes aprietan antes de lo debido; y las posiciones que un barrido no cubre
(otro mercado, sin precio) quedan fuera de los topes, lo cual se avisa en vez de
dejar que un tope calculado sobre media cartera pase por completo.

### Correlaciones: gruesas, pero existentes

El límite por correlación estaba escrito, probado y documentado, y **no se
ejecutaba ni una vez**: `dimensionar()` aceptaba `retornos` y el router la
llamaba sin ellos, así que la matriz salía vacía y `clusters` salía siempre `[]`.
Una función correcta a la que nunca se le pasan los datos es una función que no
existe.

Ahora las series salen de la miniatura de precio que ya viaja en cada señal, a
coste cero en llamadas. La contrapartida se dice: son 32 puntos muestreados
sobre el año, o sea retornos de ~11 sesiones y 31 observaciones — una estimación
**gruesa**, buena para detectar «esto se mueve claramente junto» y no para dar un
número fino. Solo se cruzan símbolos con historiales de longitud parecida: 32
puntos sobre 250 sesiones y 32 sobre 100 cubren periodos distintos, y
correlacionarlos daría un número con la misma pinta que uno bueno.

### Ningún retorno se enseña sin su caída al lado

«+12 % anual» y «+12 % anual con un −45 % por el camino» son propuestas
distintas, y quien solo ve la primera abandona en el peor momento — con lo cual
nunca cobra ese +12 %. `con_caida_esperada()` empareja las dos por construcción.

La caída no sale de un supuesto: se aplica **la cartera actual** a todo el
histórico disponible y se reporta la peor racha real, con sus fechas. Y con la
advertencia que más se olvida:

> ATENCIÓN: el histórico solo cubre 2,2 años, desde 2021. Esta cartera NO ha
> vivido la crisis financiera de 2008, ni el desplome de marzo de 2020. Su peor
> caída histórica es el peor de los escenarios que dio tiempo a ocurrir, que no
> es lo mismo que el peor escenario posible.

Se simula con **mezcla constante**, rebalanceando a los pesos que tienes en cada
paso. Comprar y no tocar contesta a otra pregunta: los pesos derivan solos hacia
lo que más subió, y una cartera declarada 50/50 acaba simulada como 92/8. El
sesgo no tiene signo fijo —lo que se desploma al final llega sobreponderado y
exagera la caída; lo que baja despacio se diluye y la tapa— así que no se
corrige leyendo el número con cuidado. En un caso construido a propósito la
diferencia era **−29 % contra −4 %** sobre la misma cartera.

Y si el histórico común no llega a la ventana pedida, la peor ventana sale
**vacía** en vez de recortarse al periodo disponible: antes un −29 % de diez
semanas viajaba rotulado como «peor 12 meses», y un número mal rotulado es peor
que ninguno porque se compara con otros que sí significan lo que dicen.

Nada de esto se calculaba en la aplicación hasta ahora: `peor_ventana()` y
`con_caida_esperada()` existían en el repositorio, con sus tests, y **no las
llamaba ningún endpoint**. Hoy `/api/portfolio` las sirve y el portafolio las
enseña — la caída va pegada a la rentabilidad en la misma tarjeta, no en otra
pantalla.

## Módulo de valoración: rangos, no precios objetivo

Cuatro piezas que contestan preguntas distintas, y ninguna basta sola.

### La regla, y cómo se impone

**No existe en el código ningún campo que contenga un precio objetivo.** No es
una convención de presentación: los escenarios devuelven `bajo/centro/alto`, los
comparables un intervalo de predicción y el DCF inverso una curva. Hay un test
que recorre la respuesta entera comprobando que no aparece ninguno — una regla
que solo vive en el docstring dura hasta el siguiente que añada un campo con
buena intención.

El módulo anterior decía en su docstring que «nunca devuelve el precio objetivo,
devuelve un valor por escenario». Eso era hacer trampa con las palabras: **tres
escenarios con un valor puntual cada uno son tres precios objetivo.** Ahora cada
escenario produce un rango, perturbando sus propios supuestos dentro de una banda
declarada.

Y los números se redondean a **tres cifras significativas**. Un DCF que imprime
«147,32 $» finge una precisión de céntimos sobre un método donde mover el WACC un
cuarto de punto cambia el resultado en varios euros.

### DCF inverso: la pieza más útil

Un DCF normal pregunta «¿cuánto vale?» y la respuesta depende de supuestos que
nadie sabe. El inverso le da la vuelta: toma el precio como dado —el precio sí se
conoce— y despeja **qué tendría que pasar para que ese precio fuera correcto**.
La pregunta pasa de «¿cuánto vale?» a «¿me creo esto?», que sí se puede contestar
mirando el negocio.

**El crecimiento implícito no es una propiedad de la empresa: es función del WACC
que elijas.** Sobre la misma empresa y el mismo precio, el modelo descuenta un
−0,45 % anual con un WACC del 7 % y un 18 % con uno del 12 %. Publicar «el mercado
descuenta un 14 %» como si fuera un hecho medido sería exactamente la falsa
precisión que esta app existe para evitar, así que lo que se devuelve es la curva
entera.

El margen implícito, en cambio, tiene **solución cerrada**: el valor de empresa es
proporcional al margen de FCF, así que despejarlo es una división, no una
búsqueda numérica. Separa las dos palancas — un precio se justifica creciendo
mucho con el margen de hoy, o creciendo poco y expandiendo el margen.

Verificación que sostiene todo lo demás: si el precio *es* el valor que da un DCF
al 8 %, el inverso devuelve 8,000000 %.

### Comparables ajustados: por qué el intervalo es ancho

Comparar el P/E con la mediana del sector no es un hallazgo, es no haber mirado:
una empresa que crece al 15 % con un ROE del 30 % debe cotizar más cara que una
que crece al 3 % con un ROE del 8 %. Aquí el múltiplo se explica con una regresión
sobre crecimiento y calidad, **excluyendo al objetivo del ajuste** para que su
múltiplo predicho sea una predicción fuera de muestra.

Con seis pares y dos regresores quedan **tres grados de libertad**, así que
cualquier predicción puntual sería una ficción estadística. Se devuelve el
intervalo de predicción, que es lo matemáticamente correcto y además ancho, que
es lo honesto. Tres guardianes lo protegen:

- **Muy pocos pares** (< 5) → no se regresa, se cae a los cuartiles crudos y se
  declara que NO están ajustados.
- **R² bajo** (< 0,30) → el ajuste no sostiene una conclusión y se dice.
- **Colinealidad** → el que más falta hacía. En un sector real las empresas buenas
  suelen crecer, así que crecimiento y calidad van de la mano; `inv()` no falla en
  ese caso, **devuelve basura**. Se comprueba el índice de condición de Belsley
  sobre las columnas escaladas, y por encima de 30 se rehúsa a ajustar.

La t crítica va tabulada en vez de traer scipy: con tres grados de libertad usar
1,96 estrecharía el intervalo casi a la mitad — justo el error que el módulo
existe para no cometer.

### Sensibilidad: qué supuesto decide

La matriz clásica cruza WACC × crecimiento y deja fuera al resto, entre ellos el
crecimiento a perpetuidad, que en muchas empresas es el que más manda porque el
valor terminal se lleva tres cuartas partes del total. Aquí se perturban los
cuatro de uno en uno, **con magnitudes comparables entre sí** (un punto de WACC
contra un punto de crecimiento), y se ordenan. Perturbar cada uno un 10 % de su
valor daría un orden distinto y engañoso: un 10 % de un WACC del 9 % es 0,9 pp y
un 10 % de un terminal del 2,5 % es 0,25 pp.

También se reporta la **asimetría**: si bajar el crecimiento un punto quita 30 $ y
subirlo solo añade 18 $, el riesgo no es simétrico y el escenario central está más
cerca del techo que del suelo.

### Dos bugs que salieron al mirar la pantalla

**El precio implícito se contradecía con el múltiplo.** En el mismo panel, el P/E
salía FUERA del intervalo y el precio implícito, DENTRO. Los P/E de los pares
vienen del proveedor de fundamentales (TTM, ajustado) y el BPA venía de EDGAR
(anual, GAAP): cada número era correcto y juntos no querían decir nada, porque
vivían en espacios de múltiplos distintos. Ahora el BPA se despeja del propio
múltiplo del objetivo y las dos lecturas coinciden por construcción.

**El veredicto del DCF inverso resumía el centro de un rango de dieciocho
puntos.** Con una curva de −0,5 % a 18 % —que es lo normal— concluía «descuenta
más o menos lo que la empresa ya hace, ni exige un cambio»: tranquilizador y sin
sentido. Ahora razona sobre el rango entero, y cuando el histórico cae dentro dice
lo único informativo que hay que decir — que no decide la empresa, decide tu tasa
de descuento, y dónde está la frontera.

## Reportes trimestrales: extracción con el API de Claude

### Lo que NO se puede analizar, dicho primero

**Las transcripciones de earnings calls no están disponibles.** El endpoint de
transcripciones de Finnhub es de pago y la SEC no las publica, porque la llamada
es un acto voluntario de la empresa y no un documento registrado. No se analizan
y la app lo dice en pantalla, en vez de sustituirlas en silencio por otra cosa y
dejar que el rótulo sugiera algo que no ha pasado.

Lo que sí llega, gratis y completo, desde EDGAR:

- **10-Q y 10-K** — el MD&A es donde la dirección explica el trimestre con sus
  propias palabras, y los factores de riesgo son la lista que sus abogados
  consideran material. Es el mismo lenguaje de la dirección que se compara entre
  trimestres.
- **8-K** — el comunicado de resultados viaja como anexo y suele traer el
  guidance con cifras, que en el 10-Q solo aparece en prosa.

### Se extraen hechos. La garantía es el esquema, no el prompt

El esquema de salida **no tiene ningún campo donde quepa una recomendación**. No
hay `accion`, ni `valoracion`, ni `precio_objetivo`. Un modelo no puede
recomendar comprar en un JSON que no tiene sitio para decirlo, y eso es más
fuerte que pedirlo por favor en el system prompt (que también se pide, y hay un
test que comprueba las dos cosas).

Los campos son fijos —`resumen`, `guidance`, `riesgos`, `temas`— y se validan
contra un esquema Pydantic con `messages.parse()`, así que la restricción se
aplica **en la generación**: no hay JSON mal formado que parchear ni campos que
aparezcan un trimestre y falten al siguiente. Para un análisis que existe para
compararse consigo mismo en el tiempo, esa garantía es el requisito.

### Cada dato lleva su cita, y la cita se verifica

Es la defensa concreta contra la alucinación. Si el modelo dice que la empresa
elevó su previsión de ingresos, tiene que copiar la frase donde lo dice, y esa
frase **se busca en el texto que se le mandó**.

Lo que no aparece **se marca, no se borra**: que el modelo se inventara una cita
es información sobre la fiabilidad de ese análisis, y borrarla dejaría un
resultado más limpio y menos veraz. En pantalla sale en rojo, con el aviso de
que el dato que sostiene no está respaldado.

La comparación normaliza comillas curvas, espacios duros y guiones tipográficos
antes de buscar: cambian según la herramienta que generó el filing, y si eso
marcara como inventadas citas correctas, nadie se creería los avisos y el
verificador entero sobraría.

### Dos llamadas, y la aritmética en Python

La primera lee el documento. La segunda —la comparación— recibe **los dos JSON,
no los dos documentos**: cuesta una fracción y, sobre todo, es auditable, porque
sus entradas están guardadas y se pueden volver a leer.

Al modelo se le pide lo que sabe hacer: alinear lenguaje, para que «presiones en
la cadena de suministro» y «restricciones de suministro» cuenten como el mismo
tema en vez de como uno que desaparece y otro que aparece. **La resta la hace
Python**, sobre los puntos medios de los rangos, y solo cuando los dos trimestres
dan cifras. Sin números no hay variación que calcular, y estimarla sería inventar
la parte más citable del análisis.

### El LLM no se llama solo, y el coste se ve antes

`GET /api/earnings/{symbol}/coste` cuenta los tokens con `count_tokens` y da el
coste estimado **sin llamar al modelo**. Un 10-Q largo cuesta bastante más que
uno corto, y eso hay que saberlo antes, no en la factura.

Un documento que no cabe en el presupuesto **se declara y no se recorta**: un
análisis sobre media sección parece completo, no lo es, y no lo dice en ninguna
parte. La app propone el 8-K del mismo trimestre, que es mucho más corto.

### Localizar las secciones: tres intentos hasta dar con la señal buena

Un 10-Q son entre 300 KB y 1 MB de HTML y solo unas páginas se leen. Las
secciones se localizan por su rótulo oficial de la SEC, pero distinguir el
encabezado de verdad de la fila del índice costó tres intentos:

1. **Por el largo de la sección.** Falló en silencio y caro: la fila del índice
   de «Item 2» tenía por detrás toda la sección de riesgos antes del marcador de
   cierre, superaba el mínimo, y el MD&A salía con los factores de riesgo pegados
   dentro sin que nada lo dijera.
2. **Por si hay otro «Item» justo detrás.** Falló al revés: los MD&A reales
   empiezan citando «see Item 1A. Risk Factors» en el primer párrafo, y eso
   descartaba el encabezado bueno.
3. **Por la maquetación**, que es lo que de verdad los distingue: el encabezado
   ocupa su propia línea y no arrastra número de página; la fila del índice sí lo
   arrastra; la referencia cruzada va a mitad de frase.

Una sección que no se encuentra **se declara ausente**. Devolver «lo que había
alrededor de donde debería estar» sería inventar la estructura del documento.

### Todo enlaza a su fuente

Cada análisis se guarda por el **número de acceso** de la SEC —el identificador
que no se reutiliza jamás— y lleva la URL del documento. Un análisis de
resultados sin su documento es una opinión anónima sobre una empresa; con él,
cualquiera puede ir a comprobarlo. Un filing se analiza una vez: la SEC no
reescribe documentos, publica enmiendas con su propio número.

## Screener multifactor: `multifactor.py`

Seis exposiciones estándar, normalizadas dentro de cada sector, con los pesos en
manos de quien mira. Es una herramienta distinta del compuesto de la lista
diaria: aquella tiene cuatro familias con pesos fijos y está backtesteada; esta
tiene seis y sirve para explorar.

| Familia | Se construye con | Evidencia |
|---|---|---|
| **value** | E/P, B/P, FCF yield | Sólida y muy replicada. Se paga con rachas malas largas |
| **quality** | ROE, ROIC, margen operativo, cobertura de intereses, apalancamiento invertido | Sólida, la más estable |
| **momentum** | 12-1 (saltándose el último mes) | Sólida. Se desploma en los giros de mercado |
| **growth** | CAGR de ingresos, EPS y FCF | **Débil como factor de retorno.** Pagar por crecimiento pasado tiende a restar; lo que funciona en la literatura es rentabilidad + inversión, no ventas pasadas |
| **low volatility** | Volatilidad anualizada, invertida | Real pero discutida: buena parte se explica por calidad, y aquí se solapa con el dimensionador |
| **size** | −log(capitalización) | **La más erosionada.** En un universo de grandes cotizadas «pequeña» significa 30.000 millones: no es el factor académico |

Cada advertencia de la tabla va escrita **debajo de su control deslizante**, no
enterrada en la documentación. Seis controles idénticos sugieren seis factores
igual de sólidos, y no lo son.

**Y no son seis apuestas independientes.** Value y growth tiran en direcciones
opuestas casi por definición; quality y low-vol suelen cargar sobre los mismos
nombres. El resultado incluye la correlación entre las familias **medida en ese
universo concreto**, no copiada de un paper: subir los seis pesos al máximo no
diversifica, concentra en lo que tengan en común.

**Normalización sectorial, y se nota.** Un P/E de 9 es caro en banca y barato en
software. Un corte absoluto llenaría la lista de bancos y utilities en cualquier
mercado y cualquier año; un test lo fija comprobando que ningún sector se lleva
el podio entero. Los sectores con menos de 5 empresas en el universo no se
puntúan y se dice cuáles: puntuar contra dos comparables es ruido con formato de
número.

**Coste: cero llamadas adicionales.** Momentum, precio y volatilidad salen de la
descarga masiva por sector; los fundamentales, de EDGAR, que es gratis. Un
screener de seis factores sobre 500 empresas suele ser imposible con tiers
gratuitos — aquí sale gratis porque reaprovecha lo que ya está cacheado.

### El percentil histórico: lo que el corte transversal no puede ver

La parte que casi ningún screener enseña, y la que cambia lecturas.

Un z-score dice quién va mejor **ahora mismo**: una empresa con ROE del 18 %
puntúa bien contra su sector. Lo que no dice es que ese mismo negocio venía del
30 % y lleva tres años cayendo. El z-score la sigue premiando mientras se
deteriora, porque compara hacia los lados y no hacia atrás. Y al revés: un margen
en su máximo de diez años puntúa como excelencia cuando puede ser un pico del
ciclo a punto de revertir.

Por eso cada empresa del ranking trae sus métricas situadas **frente a sus
propios ejercicios**: valor de hoy, mediana, rango y percentil, calculados desde
los estados que la empresa presentó a la SEC. Sale gratis, porque esos estados ya
están descargados para puntuar los factores.

Dos detalles que evitan leerlo al revés:

- **El valor actual no entra en la serie contra la que se compara.** Compararse
  consigo mismo arrastra el percentil hacia el centro.
- **Cada métrica lleva su orientación.** Estar en el percentil 90 de deuda es la
  peor lectura posible, no la mejor, y `percentil_favorable` es lo único que se
  puede colorear sin equivocarse.

### Un bug que este trabajo destapó en el motor de la lista diaria

Al construir el screener, la familia `growth` salía en −0,66 para todas las
empresas de una prueba en la que **todas tenían exactamente el mismo
crecimiento**. Debía salir 0,00.

`zscores()` protegía el caso «sin dispersión» con `std == 0`, que es una
comparación exacta para una condición aproximada. Con cuarenta valores idénticos,
la suma en coma flotante deja una media que difiere del valor en 7e-17: la
desviación sale de 7e-17 —distinta de cero— y la división convierte ruido de
redondeo puro en un z-score de **−0,99**. Un factor que no distinguía a nadie
movía el compuesto casi una desviación entera, y el número tenía exactamente la
misma pinta que uno informativo.

El test que existía usaba `5.0`, cuya suma en coma flotante es exacta, así que
pasaba por casualidad. La comparación ahora es relativa a la escala del dato, y
la función vive en `factors.py` — o sea que **el fallo estaba también en la lista
diaria**, no solo en el screener nuevo.

## Contra los baselines: ¿bate esto a lo simple?

La pregunta que ordena todo lo demás, y la única cuya respuesta puede hacer que
el resto sobre. Un sistema puede tener esperanza positiva y aun así ser peor que
comprar el índice y no mirarlo — y entonces puntuar, filtrar y rebalancear no
solo no aporta: cuesta comisiones y atención.

`analysis/baselines.py` compara la estrategia con tres alternativas tontas:

1. **Comprar el universo y no tocarlo.**
2. **Equiponderada con rebalanceo periódico** (paga la rotación).
3. **Momentum de 12 meses**, top N rebalanceado.

**Un solo motor, cuatro selectores.** Las cuatro carteras se simulan con el
mismo código y solo difieren en una función: *dado este mes, ¿qué tengo?*
Comparar implementaciones distintas es como se cuelan las ventajas ficticias —
una paga costes y otra no, una mira un dato que la otra no tiene. Aquí eso es
imposible por construcción.

**Curvas de capital, no listas de operaciones.** Volatilidad, Sharpe y drawdown
son propiedades de una serie de patrimonio; una media de trades sueltos no puede
producirlas. Y sin ellas, «esperanza +4 %» no dice si el camino fue soportable:
un +4 % con un −60 % por medio no se aguanta.

**Bootstrap por bloques de 6 meses.** Los retornos están autocorrelados y
agrupan la volatilidad; remuestrear meses sueltos rompe esa estructura y da
intervalos demasiado estrechos — declararía «significativo» lo que no lo es. Se
remuestrean **pares** (no cada serie por su lado) porque las dos carteras viven
el mismo mercado.

### El veredicto no suaviza

Está escrito para poder decir que no, y dice tres cosas distintas:

- **«NO SUPERA AL BASELINE»**, con los puntos de diferencia a favor de no hacer
  nada, cuando un baseline rinde más.
- **«Trátalo como un empate»** si gana por menos de 1 punto anual: ese margen se
  lo come cualquier diferencia de comisiones o de fechas.
- **«No se distingue del azar»** si gana pero ningún intervalo deja el cero
  fuera.

Y mira el **Sharpe**, no solo el retorno: si la estrategia rinde más con peor
Sharpe, lo dice — el retorno extra viene de asumir más volatilidad, y esa
palanca se consigue sin modelo, comprando el baseline con margen.

## Registro de experimentos: ¿cuántas veces has mirado?

Si pruebas cuarenta variantes y te quedas con la mejor, esa mejor tiene buen
Sharpe **por construcción**: con cuarenta intentos sobre ruido puro alguno sale
bien. El número que publicas no mide la estrategia, mide cuántas veces miraste —
y nadie lleva la cuenta, porque las variantes descartadas se olvidan enseguida.

`analysis/experiments.py` + tabla `experiments`. Cuatro piezas, y ninguna sirve
sin las otras tres.

**1· El registro.** Cada ejecución guarda hipótesis, parámetros, periodo,
universo y resultado. Se escribe **siempre, salga bien o mal**: registrar solo
los aciertos es justo lo que rompe el descuento, porque el recuento sale corto y
todo parece mejor de lo que es.

```bash
.venv/bin/python scripts/run_rule_backtest.py --hipotesis "El filtro de tendencia aporta"
```

**2· Sharpe deflactado** (Bailey y López de Prado, 2014). Descuenta el Sharpe
que cabría esperar del mejor de N intentos aunque ninguno tuviera ventaja, y
devuelve la probabilidad de que el verdadero sea positivo. En la verificación:

| Pruebas registradas | Umbral por haber mirado | DSR | Veredicto |
|---|---|---|---|
| 1 | +0,0000 | 0,976 | HALLAZGO |
| 10 | +0,3030 | 0,723 | NO llega a hallazgo |

**El mismo resultado** deja de ser un hallazgo por haber mirado diez veces. Y el
DSR solo es tan honesto como el recuento: las variantes que pruebes sin registrar
lo inflan, y la salida lo dice cada vez.

**3· Corrección por comparaciones múltiples.** Bonferroni y Benjamini-Hochberg
sobre los tres baselines, porque responden a preguntas distintas: Bonferroni
controla la probabilidad de *un solo* falso positivo (muy estricto), BH controla
la *proporción* de falsos entre los declarados — lo adecuado cuando buscas
candidatos que luego vas a verificar por separado.

**4· Holdout bloqueado.** El último 30 % del periodo queda reservado y ningún
experimento lo toca; el corte es **cronológico**, porque partir al azar dejaría
un holdout que comparte régimen de mercado con el desarrollo y no sería
información nueva.

No se puede impedir por código que alguien mire —siempre se puede editar el
código—, pero sí que mire **sin dejar huella**. Abrirlo exige una frase exacta
(no un booleano: un `True` se teclea sin pensar), y la apertura queda registrada
para siempre:

```
$ ... --abrir-holdout "si"
El holdout está reservado y no se toca durante el desarrollo. Para abrirlo hay
que pasar exactamente: "SI, QUEMAR EL HOLDOUT".

$ ... --abrir-holdout "SI, QUEMAR EL HOLDOUT"
Primera apertura: este resultado sí es fuera de muestra. A partir de ahora el
holdout está quemado.

$ ... --abrir-holdout "SI, QUEMAR EL HOLDOUT"   # segunda vez
El holdout ya se abrió 1 vez. Este resultado NO es fuera de muestra: ya has
ajustado mirándolo, aunque haya sido sin querer. Trátalo como desarrollo.
```

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
