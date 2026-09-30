# Auditoría para Release Candidate 1

Fecha: 2026-09-29 · Base: `e3265f5` · 826 tests en verde · 32 puntos en `TODO.md`

El criterio de esta auditoría no es «¿funciona?» sino **«¿falla de forma
segura?»**. Son preguntas distintas y la segunda es la que decide si un sistema
de inversión se puede usar. Un sistema que acierta el 60 % de las veces y falla
de forma segura el otro 40 % es utilizable. Uno que acierta el 70 % y el otro
30 % falla en silencio, no.

Por eso la clasificación de abajo no ordena por «cuánto código hay que tocar»
sino por **qué pasa cuando el dato no está**.

---

## El patrón que se repite: el dato ausente empuja siempre hacia comprar

Cinco de los seis P0 son el mismo error con distinta ropa:

> Falta un dato → se sustituye por un valor neutro → el valor neutro resulta
> ser el favorable → el sistema recomienda más exposición **por tener menos
> información**.

Esto es lo contrario de lo que debe pasar. La ignorancia tiene que **encoger**
la posición, no agrandarla. Cada P0 de abajo está verificado ejecutando el
código, no leyéndolo: la columna «comprobado» trae el número real.

---

## P0 — Crítico: producen una decisión incorrecta en silencio

### P0-1 · Un precio `NaN` produce una recomendación de COMPRAR

`analysis/decision.py` · `decide()`

La guarda es `if price is None or not price.get("last")`. `NaN` no es `None` y
es *truthy*, así que pasa entera. Después, todas las comparaciones con `NaN`
devuelven `False`, y el flujo cae en la rama favorable.

```
decide({"score": 0.5}, {"last": nan, "daily_vol_pct": 2.0, "above_sma200": True})
  → action: "comprar"
    levels: {"stop": nan, "objetivo": nan, "peso_bruto_pct": 5.5}
```

El `peso_bruto_pct: 5.5` **no es NaN**: es un número real, calculado solo desde
`stop_pct`, y viaja íntegro a `sizing.dimensionar()`. O sea que una cotización
corrupta produce una orden de compra dimensionada.

**Impacto**: máximo. Viola los principios 6, 7 y 11 a la vez.

### P0-2 · Un precio negativo o cero también

Mismo sitio. `last = -50.0` es *truthy* → `action: "comprar"`, `stop: -40.85`.
Ningún precio de mercado es negativo: si llega uno, el dato está corrupto y la
respuesta correcta es `sin_datos`, no una compra con stop negativo.

### P0-3 · Una volatilidad `NaN` desactiva el objetivo de volatilidad ENTERO

`analysis/sizing.py` · `volatilidad_cartera()` + `dimensionar()`

`total` se contamina con `NaN`; `math.sqrt(NaN)` es `NaN`; `if total > 0` es
`False` con `NaN`, así que la función devuelve `None`. En `dimensionar`,
`if vol_llena and ...` es `False` → **`escala = 1.0`, no se recorta nada**.

```
candidatas: A (vol 40 %), B (vol NaN)
  → escala_aplicada: 1.0      ← el límite NO se ejecutó
    vol_estimada_pct: None    ← la UI pinta «—»
    recortes: [solo los del tope por posición]
```

Lo peor es la combinación: la pantalla muestra «—» en la volatilidad estimada,
que se lee como «no hay dato», cuando lo que ha pasado es que **un límite de
riesgo no se ha ejecutado**. No hay ninguna diferencia visible entre «la
volatilidad está dentro del objetivo» y «el objetivo no se comprobó».

Es exactamente la familia del bug del límite por correlación de `e0067d7`.

### P0-4 · Una posición sin volatilidad reduce la volatilidad de la cartera

`analysis/sizing.py` · `volatilidad_cartera()`

`simbolos = [s for s in pesos if vol_anual.get(s)]` excluye en silencio lo que
no tiene volatilidad medida. El resultado es que **menos datos = menos riesgo
aparente = más compra autorizada**.

```
50/50 con ambas vols al 40 %       → 0,3464
50/50 y a B le falta la vol        → 0,2000   (−42 % de riesgo aparente)
```

El filtro `vol_anual.get(s)` además descarta una volatilidad legítima de `0.0`.

### P0-5 · Sin series de retornos, el tope por correlación no se ejecuta y no se dice

`analysis/sizing.py` · `dimensionar(retornos=None)`

```
5 candidatas al 9 %, sin retornos
  → clusters: []
    ¿algún aviso de que la correlación no se pudo medir?: False
```

El bug de `e0067d7` se arregló **en el sitio que llama** (`routers/signals.py`
alimenta los retornos desde el spark), pero la función sigue fallando abierta
para cualquier otro camino: si `_retornos_desde_spark` devuelve `{}` —porque los
historiales tienen longitudes dispares, o porque hay menos de dos símbolos con
spark suficiente— el tope desaparece sin dejar rastro.

Un límite que puede no ejecutarse **tiene que decir que no se ejecutó**. Esa es
la lección del bug original y no está aprendida del todo.

### P0-6 · Deuda desconocida se convierte en deuda cero e infla la valoración un 95 %

`routers/valuation.py:119` y `routers/deep_dive.py:203`

```python
"net_debt": (deuda - (ultimo.get("cash") or 0.0)) if deuda is not None else 0.0
```

Y en `analysis/valuation.py`: `equity_value = enterprise_value - net_debt`.

```
FCF 1.000 M, g 5 %, r 10 %, 100 M de acciones
  con 8.000 M de deuda neta conocida : 83,95 $/acción
  si la deuda NO se conoce  (→ 0)    : 163,95 $/acción   (+95 %)
```

Una empresa sobre la que no sabemos la deuda se valora **como si no tuviera
ninguna**, que es el supuesto más optimista posible. `routers/stocks.py:252`
hace lo correcto en la misma situación (`else None`): la inconsistencia entre
dos sitios que calculan lo mismo es en sí misma un hallazgo.

### P0-7 · Crecimiento ausente se sustituye por un 3 % inventado, en silencio

`routers/valuation.py:136` · `routers/deep_dive.py:200`

```python
historico = crecimiento.get("fcf_cagr") or crecimiento.get("revenue_cagr") or 0.03
```

Dos fallos en una línea. El `or` encadenado convierte un crecimiento ausente en
un supuesto del 3 % que nunca se declara como supuesto; **y** convierte un
crecimiento real de `0.0` en ese mismo 3 %, porque `0.0` es *falsy*. Una empresa
que no crece se valora como si creciera al 3 %.

---

## P1 — Necesario antes del RC1

| # | Punto | Por qué |
|---|---|---|
| P1-1 | **No existe una frontera de validación de datos** | `providers/base.py` documenta la forma del payload pero nada la comprueba. `router.fetch()` devuelve lo que sea que traiga el proveedor —`None`, `NaN`, `0`, negativos— y la caché lo persiste. Es la causa raíz de P0-1 a P0-4. |
| P1-2 | **No existe el estado UNKNOWN** | Hoy `None` significa a la vez «no existe», «no se pudo consultar», «caducado» y «error». Sin distinguirlos no se puede cumplir el principio 7. |
| P1-3 | **Alembic no existe** | `init_db()` hace `create_all()`. Añadir una columna a un modelo no toca una base ya creada: el esquema y el código divergen en silencio. |
| P1-4 | **`api_cache` no se limpia nunca** | Las filas caducadas se ignoran al leer pero no se borran. Crecimiento sin techo. |
| P1-5 | **Un payload corrupto se cachea y se sirve durante todo el TTL** | No hay validación antes de `cache.set()`. |
| P1-6 | **Sin caída a caché vieja marcada como STALE** | Si todas las fuentes fallan, `AllProvidersFailedError`. Hay un dato de hace 10 minutos en la caché que sería perfectamente utilizable **si se marcara como viejo**. Hoy se prefiere el apagón. |
| P1-7 | **`Position` no guarda la divisa** | La divisa se lee del quote en vivo. Si el quote falla, la posición pierde su moneda; si el proveedor cambia de opinión, el histórico se recalcula con otra. |
| P1-8 | **Las conversiones FX no dejan traza individual** | `convertir()` devuelve un `float` pelado. `convertir_cartera` guarda `tipos_usados` a nivel de cartera, no por conversión. |
| P1-9 | **Sin test end-to-end del ciclo completo** | Hay tests por módulo y por endpoint, ninguno que recorra ticker → decisión → sizing → cartera → riesgo. |
| P1-10 | **Sin cooldown de alertas** | Resuelto a medias: una alerta salta una vez y no repite. Pero no hay reevaluación ni rearme, así que el caso «sigue cumpliéndose 3 h después» no existe. Falta registrar última evaluación, último resultado y último error por alerta. |
| P1-11 | **`DataNotFoundError` corta la cadena de fallback** | `router.fetch` la propaga sin probar el resto. El propio `TODO.md` reconoce que yfinance no distingue «no existe» de «red caída». |
| P1-12 | **Sin `decision_snapshot` automático** | `Decision.contexto` existe pero lo rellena el usuario al anotar a mano. No hay congelación automática de lo que el motor vio. |

## P2 — Mantenimiento

- `liquidez_pct` usa `max(0, ...)`, que **esconde** el apalancamiento en vez de avisarlo.
- `agrupar_por_correlacion` usa `abs(c)`: una correlación de −0,85 agrupa dos
  posiciones que en realidad se cubren. Es conservador (falla hacia el lado
  seguro), así que no es P0, pero está sin documentar.
- `RateLimiter.usage()` puede devolver `None` si `windows` viniera vacío.
- `analysis/etf.py:17` — `h.get("weight") or 0.0`: un peso ausente infravalora
  el solapamiento (falla abierto, pero el propio README ya advierte que el
  solapamiento es una cota inferior).
- Duplicación: `matriz_correlacion` existe en `sizing.py` y en `portfolio_risk.py`.

## P3 — Nice-to-have (no se tocan)

Intradía, 13F, segmentos, beta contra otro benchmark, cobertura de EDGAR fuera
de EE. UU. Ninguno bloquea el RC1 y todos están ya en `TODO.md`.

---

## Controles de riesgo: dónde se define, dónde se ejecuta, dónde se prueba

Trazado uno a uno, que es lo que pedía la Fase 2. «Camino de evasión» es la
columna que importa: si existe, el control es decorativo.

| Control | Se define | Se ejecuta | Camino de evasión |
|---|---|---|---|
| Riesgo por operación (1 %) | `decision.RIESGO_POR_OPERACION` | `_niveles()` | precio `NaN`/negativo (**P0-1, P0-2**) |
| Tope por posición (10 %) | `sizing.MAX_POR_POSICION_PCT` | `dimensionar()` paso 1 | ninguno ✅ |
| Tope por sector (25 %) | `sizing.MAX_POR_SECTOR_PCT` | `dimensionar()` paso 2 | sector `None` → todo cae en «Sin sector», que es un grupo real y se limita ✅ |
| Tope por correlación (25 %) | `sizing.MAX_POR_CLUSTER_PCT` | `dimensionar()` paso 3 | **sin retornos no se ejecuta y no avisa (P0-5)** |
| Objetivo de volatilidad (12 %) | `sizing.OBJETIVO_VOL_ANUAL_PCT` | `dimensionar()` paso 4 | **una vol `NaN` lo anula (P0-3); una vol ausente lo relaja (P0-4)** |
| Riesgo abierto total (6 %) | `risk_budget.HEAT_MAXIMO_PCT` | `presupuesto_de_riesgo()` | ninguno ✅ — cuenta `sin_calcular` y avisa |
| Riesgo por grupo (3 %) | `risk_budget.HEAT_GRUPO_MAXIMO_PCT` | `presupuesto_de_riesgo()` | ninguno ✅ |
| Stop perforado | `risk_budget.riesgo_de_posicion()` | idem | ninguno ✅ — `stop >= precio` se trata como posición entera en riesgo |
| Filtros del screener | `screener.evaluate_filters()` | idem | ninguno ✅ — `actual is None → passed False` |
| Dirección del tipo de cambio | `fx.SERIES[...]["por_usd"]` | `a_por_usd()` | ninguno ✅ — `comprobar_banda()` detecta la inversión |
| Posición no convertible | `fx.convertir_cartera()` | idem | ninguno ✅ — queda fuera del total y se nombra |
| Alerta no evaluable | `alertas.evaluar()` | idem | ninguno ✅ — cuatro estados desde `e3265f5` |

**Los tres módulos que ya fallan cerrados —`risk_budget`, `screener`, `fx`—
tienen algo en común**: devuelven `None` ante la ausencia y **cuentan** lo que no
pudieron evaluar. Los que fallan abiertos sustituyen la ausencia por un número.
Ese es el patrón a propagar, y es la forma de la solución de la Fase 3.

---

## Plan de ejecución

1. **Frontera de validación** (`app/datos/`): un tipo `Dato` con estado
   `VALID | UNKNOWN | STALE | ERROR` y saneadores en la entrada de proveedor.
   Resuelve P1-1, P1-2 y la raíz de P0-1..P0-4.
2. **P0-1, P0-2** — `decide()` rechaza precios no finitos, negativos o cero.
3. **P0-3, P0-4, P0-5** — `sizing` deja de fallar abierto: lo que no se puede
   medir se dice, y un límite que no se pudo comprobar se declara.
4. **P0-6, P0-7** — la valoración no inventa deuda ni crecimiento.
5. Alembic, limpieza de caché, traza FX, snapshot de decisión.
6. Test end-to-end con los siete escenarios de la Fase 4.
7. `docs/RC1_CHECKLIST.md`.

---

## Estado final (tras el trabajo de RC1)

Los siete P0 de la auditoría inicial están corregidos, cada uno con su test
que fallaba antes del arreglo. Pero el trabajo encontró **dieciséis fallos más
de la misma familia** que la auditoría inicial no vio — cuatro solo al escribir
el test de extremo a extremo, y dos solo al abrir la app en el navegador con las
fuentes caídas de verdad. Esa es la lección principal: leer el
código encontró siete; hacerlo funcionar de punta a punta encontró el resto.

### P0 de la auditoría inicial

| # | Fallo | Estado | Commit |
|---|---|---|---|
| P0-1 | Precio NaN → «comprar» con peso real | Corregido | `53f6c2a` |
| P0-2 | Precio negativo o cero aceptado | Corregido | `53f6c2a` |
| P0-3 | Volatilidad NaN anula el objetivo de volatilidad | Corregido | `903f026` |
| P0-4 | Volatilidad ausente abarata el riesgo | Corregido | `903f026` |
| P0-5 | Sin retornos, el tope por correlación no corre ni avisa | Corregido | `903f026` |
| P0-6 | Deuda desconocida = deuda cero (+95 % de valoración) | Corregido **en dos intentos**: el primero no llegaba al endpoint | `07b5e1a`, `9033df0` |
| P0-7 | Crecimiento ausente = 3 % no declarado; 0,0 real = 3 % | Corregido | `07b5e1a` |

### P0 encontrados después

| # | Fallo | Cómo apareció | Commit |
|---|---|---|---|
| P0-8 | Capex desconocido = 0 → FCF = flujo operativo entero | Buscando por qué P0-6 no llegaba | `9033df0` |
| P0-9 | Sin acciones, el «rango» por acción se rellenaba con el equity total | Idem | `9033df0` |
| P0-10 | Finnhub nunca trae la moneda y se suponía dólar: la conversión FX no se ejecutaba | Auditoría de divisas | `77b3e9d` |
| P0-11 | `/riesgo` pesaba sumando monedas sin convertir | Idem | `77b3e9d` |
| P0-12 | P&L realizado sumado en la moneda de cada posición | Idem | `77b3e9d` |
| P0-13 | Coste convertido al tipo de hoy: el efecto divisa desaparecía del P&L | Idem | `77b3e9d` |
| P0-14 | Solapamiento de ETFs desconocido = 0 % → sin aviso de concentración | Auditoría de proveedores | `87ea405` |
| P0-15 | **El stop se recalculaba con la volatilidad de la propia caída y se alejaba solo** | Test de extremo a extremo | `f124d24` |
| P0-16 | `response_model` filtraba el estado del dato: el dato viejo llegaba sin marca | Test de extremo a extremo | `e3e223e` |
| P0-17 | El botón de backtest de la interfaz miraba el holdout, sin registrarlo | Auditoría de validación | `ca51076` |
| P0-18 | El corte del holdout se movía con la ventana pedida | Idem | `ca51076` |
| P0-19 | Una cotización rescatada de caché salía rotulada «en vivo» en la interfaz | Revisión de la interfaz | `79493ba` |
| P0-20 | La lista diaria decidía sobre precios rescatados sin saberlo, y podía recomendar comprar | Idem | `79493ba` |
| P0-21 | Capex con signo cambiado: `cfo − (−capex)` inflaba el FCF | Validación de EDGAR | `ddd3b6e` |
| P0-22 | Una alerta evaluada con precio viejo decía «no salta» | Abriendo la app en el navegador | `f338493` |
| P0-23 | La cartera valoraba con precios viejos sin marcarlo | Idem | `f338493` |

### P1

| # | Punto | Estado |
|---|---|---|
| P1-1 | Frontera de validación | Hecho (`f2ff481`) |
| P1-2 | Estado UNKNOWN | Hecho: `app/datos.py`; `estado` en cada respuesta del servicio de datos |
| P1-3 | Alembic | Hecho (`50675ff`), 0001–0006 |
| P1-4 | Limpieza de caché | Hecho (`f2ff481`) |
| P1-5 | Payload corrupto cacheado | Hecho (`f2ff481`) |
| P1-6 | Caída a caché vieja marcada | Hecho (`f2ff481`, `e3e223e`) |
| P1-7 | Divisa de la posición | Hecho: se guarda en el instrumento (`77b3e9d`) |
| P1-8 | Traza por conversión | Hecho (`77b3e9d`) |
| P1-9 | Test de extremo a extremo | Hecho (`e3e223e`) |
| P1-10 | Registro por alerta, reintentos, aviso de errores | Hecho (`5888372`) |
| P1-11 | `DataNotFoundError` cortaba el fallback | Hecho (`77b3e9d`) |
| P1-12 | `decision_snapshot` | Hecho (`173dfd2`) |
| — | La suite de tests escribía en la base real | Hecho (`f2ff481`) |
| — | `Infinity` aceptado en importes; su 422 salía como 500 | Hecho (`50675ff`) |
| — | Doble clic creaba posiciones duplicadas | Hecho (`50675ff`) |
| — | Una alerta rota tumbaba la pasada del cron | Hecho (`5888372`) |
| — | Fechas de posiciones sin zona horaria | Hecho (`6eab884`) |

### Lo que sigue abierto (riesgo residual)

- **Nada se ha ejecutado contra las APIs reales** desde este entorno. La
  frontera de validación hace que un payload mal formado se rechace en vez de
  usarse, pero un campo mal MAPEADO con un valor plausible (una deuda leída de
  la etiqueta XBRL equivocada) la atraviesa. Ver `RC1_CHECKLIST.md`.
- **Nadie sabe si la estrategia bate a no hacer nada.** El backtest con datos
  reales no se ha podido correr aquí.
- **Sesgo de supervivencia** en los universos: son empresas que existen hoy. El
  índice externo como baseline lo acota, no lo elimina.
- **Posiciones abiertas antes del RC1** no tienen stop fijado hasta que se
  pulse «Fijar stop» (`a719b3a`); mientras tanto se recalcula, avisando.
- *(Cerrado en `a719b3a`)* Los backtests guardados antes del RC1 ya no validan
  decisiones: hasta que se ejecute uno nuevo, las reglas figuran como no
  validadas.
- **La app no registra efectivo, dividendos, depósitos ni retiradas.** Los
  pesos se miden sobre lo invertido; los topes aprietan antes de lo debido si
  guardas liquidez fuera (error en dirección prudente, pero error).
- Las dos limpiezas (caché y registro de llamadas) cargan en memoria las filas
  que van a borrar en vez de borrar con una sola sentencia; con uso personal no
  importa, con otro volumen sí (P2).
