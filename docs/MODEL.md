# Cómo funciona el modelo

El objetivo es un modelo **explicable**: cada señal se expresa en **puntos Elo**, así que
puedes rastrear de dónde sale cada probabilidad. Código: `server/src/model/`.

---

## 1. Rating Elo

Elo asigna a cada jugador un número. La diferencia entre dos ratings se traduce en una
probabilidad de victoria, y tras cada partido los ratings se ajustan hacia el resultado real.

**a) Probabilidad esperada** (`elo.ts → expectedScore`)

```
E_A = 1 / (1 + 10^((R_B − R_A) / 400))
```

Una diferencia de 0 → 50%. Cada +400 puntos ≈ 10× más probable ganar (≈91% contra un rival
400 puntos por debajo).

**b) Actualización tras el partido** (S = 1 para el ganador, 0 para el perdedor)

```
R_A' = R_A + K · (S_A − E_A)
```

Ganar cuando se esperaba (E_A alto) → ganancia pequeña. Ganar de sorpresa (E_A bajo) →
ganancia grande. El perdedor se mueve de forma simétrica.

**c) K-factor dinámico** (`elo.ts → kFactor`)

```
K(n) = 250 / (n + 5)^0.4        (n = partidos jugados)
```

Novatos (n pequeño) se mueven rápido para encontrar su nivel; veteranos (n grande) son
estables. Es el enfoque popularizado por FiveThirtyEight / Tennis Abstract para tenis.

**c-bis) Margen de victoria** (`elo.ts → movMultiplier`)

Un 6-0 6-0 y un 7-6 6-7 7-6 dicen cosas muy distintas sobre la diferencia entre dos jugadores, y
el Elo clásico los trata igual. Así que la K se escala por lo dominante que fue la victoria,
medida como la **cuota de games** que ganó el vencedor:

```
mult = 1 + 4 · (games_ganador / games_totales − 0.615)      acotado a [0.6, 1.5]
```

0.615 es la cuota media medida sobre 44.054 partidos ATP: centrar ahí (y no en 0.5) es lo que
mantiene los ratings en la misma escala en vez de inflar todas las K. Una victoria de margen
normal mueve el rating igual que antes; una paliza mueve más y un partido apretado menos.

Los **retiros y walkovers no cuentan**: el marcador refleja una lesión, no dominancia, así que
se usa `mult = 1` y el partido se trata como Elo normal.

| Peso | Accuracy | Brier | Log loss |
|---|---|---|---|
| 0 (desactivado) | 66.1% | 0.2110 | 0.6081 |
| 1 | 66.3% | 0.2104 | 0.6070 |
| **4 (elegido)** | **66.3%** | **0.2097** | **0.6054** |
| 6 | 66.4% | 0.2097 | 0.6055 |
| 8 | 66.5% | 0.2098 | 0.6056 |

(33.967 partidos ATP out-of-sample, 2010–2026. Mide cualquier peso con
`npm run backtest -- --mov <w>`.)

**d) Elo por superficie**

Arcilla, hierba y pista dura premian habilidades distintas. Además del Elo **general**,
mantenemos un Elo separado por superficie: un partido de arcilla solo actualiza el Elo de
arcilla (y el general), nunca el de hierba. Carpeta / desconocida solo afectan al general.

Todos los partidos se procesan en **orden cronológico** (`elo.ts → computeRatings`): un
rating solo refleja los partidos anteriores.

---

## 2. Forma reciente (`form.ts`)

Captura si el jugador está *caliente* ahora mismo. Se toman los últimos ~10 partidos, se
ponderan más los recientes (decaimiento exponencial) y la tasa de victorias ponderada se
convierte en un ajuste **acotado** (± 40 pts Elo). Es a propósito pequeño: la forma matiza,
no domina.

## 3. Head-to-head (`h2h.ts`)

Algunos jugadores incomodan a rivales concretos por estilo, algo que el rating general no
capta. Usamos el récord directo como un ajuste (± 35 pts), pero **encogido** hacia 0 cuando
hay pocos enfrentamientos (`n / (n + 4)`): 1-0 es casi ruido; 8-2 es señal real.

## 4. Combinación de señales (`predict.ts`)

Para cada jugador se construye un **rating efectivo** para *ese* partido:

```
1. Mezcla por superficie:  R_eff = 0.7 · Elo_superficie + 0.3 · Elo_general
2. + ajuste de forma        (acotado)
3. + ajuste head-to-head    (acotado + encogido; desde la perspectiva del jugador 1)
4. + penalización por inactividad  (≤ 0; ver abajo)

Prob(gana J1) = expectedScore(R_eff_J1_ajustado, R_eff_J2_ajustado)
```

### Inactividad (`elo.ts → layoffAdjustment`)

El Elo no tiene noción del tiempo: un rating logrado antes de seis meses de lesión se aplica como
si el jugador no hubiera parado nunca. Agrupando el residuo del modelo (real − predicho) según
cuánto descanso tuvo cada jugador **respecto a su rival**, sobre 33.967 partidos:

| Descanso vs rival | real − predicho |
|---|---|
| ≥ 60 días **más** | −4.3 pp |
| 14–60 días más | −3.5 pp |
| ±4 días (normal) | 0.0 pp |
| 14–60 días menos | +3.5 pp |
| ≥ 60 días **menos** | +4.2 pp |

Es decir, al contrario de lo que suele suponerse: **llegar más descansado que el rival hace rendir
peor**. La falta de ritmo de competición y la lesión (no observada) que normalmente causó el parón
apuntan en la misma dirección. Se modela como una penalización que satura:

```
penalización = −60 · min(1, (días_sin_jugar − 7) / 83)     0 si ≤ 7 días
```

Una semana entre torneos es lo normal y no penaliza; a partir de 90 días el castigo es máximo.
El efecto en agregado es pequeño (Brier 0.2097 → 0.2094) porque solo ~9% de los partidos tienen
diferencias grandes de descanso — pero son justo los partidos en los que el modelo se equivocaba
más, como un jugador que vuelve de lesión.

**Resolución de las fechas:** el histórico guarda la fecha de inicio del **torneo**, no del partido,
así que esto mide «tiempo desde el último evento». Por eso la ventana libre empieza en una semana y
no en un día.

### Carga de partidos: medida y descartada

La otra cara del descanso es la **carga**: partidos jugados en los últimos 14 días. En los residuos
también aparece señal (hasta ±2.5 pp), y en la **misma dirección** que el descanso — jugar más
recientemente hace rendir mejor. Eso ya es sospechoso: ambas cosas miden lo mismo (ritmo de
competición) desde lados opuestos.

Se probó como término aparte, encima de la penalización por inactividad:

| Bonus por carga | Accuracy | Brier | Log loss |
|---|---|---|---|
| **0 (desactivado)** | 66.3% | **0.2089** | **0.6031** |
| 10 pts | 66.4% | 0.2088 | 0.6030 |
| 20 pts | 66.4% | 0.2088 | 0.6029 |
| 40 pts | 66.5% | 0.2088 | 0.6029 |

La ganancia (0.0001 de Brier) está dentro del ruido: la inactividad ya captura la señal, y añadir la
carga sería contarla dos veces. **Así que no está activada.** La bandera
`npm run backtest -- --load <elo>` se mantiene para que la medición que justificó descartarla sea
reproducible.

Se muestra igualmente en el desglose («carga alta: N partidos en 30 días») como contexto para que lo
interpretes tú — pero no entra en la probabilidad.

Al ser todo en puntos Elo, el desglose que muestra el dashboard (Elo general, Elo superficie,
efectivo, ajuste forma, ajuste H2H, ajuste inactividad, rating ajustado, probabilidad) es
completamente auditable: las filas **suman exactamente** el rating ajustado.

## 5. Comparación con el mercado (`market.ts`)

Las casas cotizan en **cuotas decimales**. La probabilidad implícita ingenua es `1/cuota`,
pero los dos lados suman **más** de 100%: ese excedente es el margen de la casa (*vig* /
*overround*). Lo quitamos normalizando:

```
raw_i     = 1 / cuota_i
overround = raw_1 + raw_2           (p. ej. 1.05 → 5% de margen)
implícita = raw_i / overround       (sin vig, suma 1)
```

**Value** = `probabilidad_modelo − probabilidad_mercado`. Si la diferencia supera un umbral
(5 puntos porcentuales) se marca como posible *value*: el modelo cree que un lado es más
probable de lo que lo pricea el mercado.

## 6. Veredicto

Se nombra al jugador favorecido y un nivel de confianza derivado únicamente de qué tan lejos
está la probabilidad del 50%:

| Brecha respecto a 50% | Etiqueta |
|-----------------------|----------|
| < 5 pp | muy parejo |
| 5–12 pp | ligera ventaja |
| 12–25 pp | favorito claro |
| > 25 pp | favorito fuerte |

---

## 7. Información adicional por partido

Además de la probabilidad, cada predicción incluye datos derivados del historial:

### Probabilidad de cada marcador (`model/scoreline.ts`)

En vez de adivinar un marcador, se **deriva la distribución completa** desde la probabilidad del
partido. Se recupera la probabilidad de ganar *un set* (`p`) invirtiendo por bisección:

```
al mejor de 3:  P(partido) = p²(3 − 2p)
al mejor de 5:  P(partido) = p³(1 + 3(1−p) + 6(1−p)²)
```

y con esa `p` se expanden los marcadores:

```
mejor de 3:  2-0 = p²      2-1 = 2p²(1−p)
mejor de 5:  3-0 = p³      3-1 = 3p³(1−p)      3-2 = 6p³(1−p)²
```

De ahí salen también la probabilidad de **set decisivo** y de ganar **sin ceder sets**. Las
probabilidades suman exactamente la del partido, así que nunca contradicen el número principal.

**Supuesto declarado:** los sets se tratan como independientes y de igual probabilidad. El tenis
real tiene inercia y el orden de saque importa, así que son estimaciones bien fundadas, no
verdades exactas.

### Señales físicas (`repo.ts → getFitnessSignals`)

**No existe una fuente abierta y fiable de lesiones actuales**, así que no se inventa una. En su
lugar se muestran las huellas que las lesiones dejan en los resultados:

- **Retiros (RET)** y **walkovers (W/O)** en los últimos 20 partidos (solo cuentan contra quien no
  pudo continuar).
- **Días sin competir** — medidos contra el partido más reciente **del dataset**, no contra hoy,
  para no confundir la inactividad del jugador con el desfase de los datos.
- **Carga**: partidos en los 30 días previos a su último partido.

Es **evidencia, no un diagnóstico**: la app no sabe si alguien está lesionado hoy, y estas señales
**no** entran en el cálculo de la probabilidad — se muestran para que tú las interpretes.

### Fiabilidad de la predicción (`model/reliability.ts`)

Una probabilidad sola esconde **cuánta evidencia** tiene detrás. «62.4%» entre dos jugadores con 800
partidos cada uno y «62.4%» entre dos qualifiers con 8 partidos se leen idénticos, y no lo son. Es
probablemente la cosa más engañosa que puede hacer un predictor, así que cada probabilidad va
acompañada de su solidez.

Se calcula por propagación de error de primer orden:

```
σ_rating ≈ C / √(n + 1)              ruido del Elo, decrece con partidos jugados  (C = 250)
σ_stale   = min(años · 40, 120)      ruido extra si el jugador lleva tiempo sin jugar
σ_jugador = √(σ_rating² + σ_stale²)
σ_brecha  = √(σ_J1² + σ_J2²)
dP/dbrecha = 0.75 · ln10/400 · p(1−p)    pendiente de la curva Elo calibrada en p
margen     = σ_brecha · dP/dbrecha
```

`n` no es el total de partidos, sino el **efectivo**, ponderado igual que el rating del partido:
`0.7 · partidos_en_la_superficie + 0.3 · partidos_totales`. Un especialista en arcilla con 400
partidos en tierra está bien descrito en tierra y mal descrito en hierba, y esto lo refleja.

El nivel resulta de tres cortes: **baja** si algún jugador tiene <10 partidos efectivos, el margen
llega a ±8 pp o alguien lleva ≥1 año sin competir; **alta** si ambos superan 60 partidos efectivos,
el margen es ≤±3.5 pp y nadie lleva más de 6 meses parado; **media** en el resto.

**Qué es y qué no es:** es propagación de error con una escala de ruido puesta a mano (`C`), **no** un
posterior bayesiano — los Elo no se siguen con varianza, así que no hay una σ exacta que leer. Lo que
sí está **medido** es el *orden* de las bandas: `npm run backtest` agrupa los partidos por nivel de
fiabilidad e imprime el Brier de cada uno, así que la afirmación «fiabilidad baja acierta menos» se
comprueba en vez de suponerse.

Ejemplo real (datos ATP hasta 2026): Sinner–Alcaraz sale **alta, ±3.4 pp**; un partido que incluya a
Federer sale **baja** con el aviso de que lleva ~5 años sin jugar. Sin esto, la app daría un 60.6%
sobre un jugador retirado con la misma seguridad que sobre el número 1 actual.

### Historial en el torneo (`repo.ts → getTournamentHistory`)

Récord, títulos, finales y mejor ronda de cada jugador en ese evento concreto. Es contexto
informativo; tampoco alimenta la probabilidad.

---

## Precisión: calibración y exactitud medida

Los porcentajes se muestran con un decimal, pero **precisión mostrada ≠ exactitud**. El proyecto
incluye un backtest *walk-forward* (cada partido se predice usando solo información anterior a
él, y luego se actualizan los ratings, así que no hay fuga de información del futuro):

```bash
npm run backtest                      # con calibración (lo que usa la app)
npm run backtest -- --calibration 1   # curva Elo cruda, para comparar
```

### Resultado medido (ATP, 46.166 partidos out-of-sample, 2005–2026)

| Métrica | Valor | Referencia |
|---|---|---|
| **Accuracy** (acierta al favorito) | **67.0 %** | Decir siempre «gana el mejor clasificado»: 64.8 % |
| **Brier score** | **0.2072** | 0 = perfecto · 0.25 = decir siempre 50/50 |
| **Log loss** | **0.5994** | 0.693 = decir siempre 50/50 |

Lo interesante no es el 67 %, es **dónde** se separa del ranking. En los 9.234 partidos
(20 % del total) en los que el modelo **no** coincide con el ranking oficial, acierta
**55,4 %** frente al 44,6 % del ranking. Ahí es donde el Elo por superficie, la forma y
el descanso aportan algo que la clasificación no contiene.

Y la calibración sostiene el semáforo de fiabilidad que muestra la app, que hasta ahora
era una afirmación sin medir:

| Fiabilidad declarada | n | Accuracy | Brier | Banda media |
|---|---|---|---|---|
| alta | 20.619 | 69,1 % | 0,1982 | ±2,3 pp |
| media | 23.773 | 65,5 % | 0,2137 | ±4,6 pp |
| baja | 1.774 | 61,6 % | 0,2252 | ±8,5 pp |

Monótona en las tres columnas: cuando la app dice que se fía menos, acierta menos y su
banda es más ancha. El semáforo mide algo real.

Qué aportaron el margen de victoria, la inactividad y la calibración por formato, sobre esos
mismos 22.062 partidos:

| Modelo | Accuracy | Brier | Log loss | Peor sesgo |
|---|---|---|---|---|
| Solo Elo + forma + H2H, calibración única | 64.8% | 0.2164 | 0.6208 | +1.9 pp |
| **+ margen, inactividad y calibración por formato** | **65.2%** | **0.2140** | **0.6151** | **+1.3 pp** |

Ganancia modesta y honesta: **+0.4 pp de accuracy**. Lo que más mejora no es acertar más, sino que
las probabilidades sean más creíbles (Brier y log loss bajan, y el sesgo de calibración se estrecha).

Verificado además en una ventana distinta de la usada para elegir los parámetros (2020–2026,
10.728 partidos): accuracy 64.1% → 64.6%, Brier 0.2188 → 0.2166. La mejora no es un artefacto de
haber ajustado y medido en los mismos datos.

### Calibración (lo más importante)

| Cuando el modelo dice… | …gana realmente | Error |
|---|---|---|
| 54.9% | 54.1% | −0.9 pp |
| 64.8% | 63.7% | −1.1 pp |
| 74.5% | 73.9% | −0.6 pp |
| 84.3% | 83.8% | −0.5 pp |
| 93.2% | 94.5% | +1.3 pp |

Es decir: **cuando dice 70%, ese lado gana ~70% de las veces**. Las probabilidades son
interpretables literalmente, dentro de ~1–2 puntos porcentuales.

### El factor de calibración (uno por formato)

La curva Elo cruda es **sobre-confiada**: sin calibrar, los partidos anunciados al ~85% se ganaban
solo el ~77% (error de −7,6 pp). Por eso se aplica un factor a la diferencia de rating antes de
convertirla en probabilidad (*temperature scaling*; ver `elo.ts`).

Pero el factor **no puede ser el mismo para los dos formatos**. Al mejor de 5 hay menos varianza, así
que el mejor jugador convierte su ventaja más a menudo. Medido sobre los mismos partidos con un solo
factor de 0.75, el favorito ganaba **2.1 pp menos** de lo anunciado al mejor de 3 y **3.1 pp más** al
mejor de 5: un único número tenía que estar mal en ambos casos. De ahí dos factores:

```
al mejor de 3 → 0.68        al mejor de 5 → 0.86        formato desconocido → 0.75
```

| Configuración | Brier | Log loss | Peor sesgo de calibración |
|---|---|---|---|
| 1.00 (crudo) | 0.2189 | 0.6282 | −7.6 pp |
| 0.75 único | 0.2095 | 0.6048 | −1.3 pp |
| 0.70 / 0.90 | 0.2090 | 0.6032 | −1.3 pp |
| **0.68 / 0.86 (elegido)** | **0.2089** | **0.6031** | **−1.0 pp** |
| 0.63 / 0.80 | 0.2090 | 0.6034 | +2.2 pp |

(33.967 partidos, 2010–2026, con margen de victoria e inactividad activos. Mídelo con
`npm run backtest -- --bo3 <s> --bo5 <s>`.) Se descartó 0.68/1.00 —marginalmente mejor en Brier—
porque 1.00 significa no calibrar nada, ajustado sobre solo 6.853 partidos al mejor de 5.

### ¿Sirve el semáforo de fiabilidad?

Sí, y está medido out-of-sample sobre los mismos 22.062 partidos. Las bandas salen en el orden
correcto, que es exactamente lo que la etiqueta promete:

| Fiabilidad declarada | n | Accuracy | Brier | Banda media |
|---|---|---|---|---|
| alta | 7.444 | 68.7% | 0.2012 | ±2.6 pp |
| media | 13.551 | 63.6% | 0.2199 | ±4.7 pp |
| baja | 1.067 | 59.5% | 0.2293 | ±8.7 pp |

Un partido etiquetado «baja» acierta ~9 puntos menos que uno «alta». La etiqueta no es decorativa:
es información sobre cuánto fiarte de la cifra que tiene al lado.

### Cuando el modelo discrepa del mercado

El modelo elige un ganador distinto al del ranking oficial en el **20,9%** de los partidos. En
esos casos el modelo acierta **53,6%** y el ranking **46,4%**: una ventaja real pero **pequeña**,
lejos de una certeza.

### Contra el mercado real: ahora sí se puede medir

Antes esto era la limitación más honesta del proyecto: *«no dispongo de odds históricas, así que no
puedo afirmar que el modelo supere al mercado»*. Con datos de tennis-data.co.uk (que trae las cuotas
de cierre de cada partido) ya es medible:

```bash
npm run backtest -- --tour wta --market
```

El backtest imprime, sobre los mismos partidos, accuracy / Brier / log loss del **modelo** y del
**mercado**, cuántas veces discrepan y quién acierta en esos casos. Y lo más útil para quien mira las
señales de *«posible value»*: si el lado señalado ganó **más** de lo que el mercado le daba.

Interpretación de lo que salga:

- Si el mercado tiene mejor Brier, el modelo **no** aporta precio: úsalo para entender el partido, no
  para buscarle la vuelta a la casa.
- Si en los partidos donde discrepan el modelo acierta **menos del 50%**, las discrepancias son ruido,
  no señal.
- Si el lado señalado como *value* gana aproximadamente lo que el mercado le daba, esas señales no
  tienen ventaja — es el resultado que hay que esperar por defecto.

**Aviso de verificación:** la ingesta de esa fuente está probada contra ficheros de prueba escritos en
su formato real (columnas, fechas como número de serie de Excel, marcador set a set, cuotas), pero el
entorno donde se desarrolló **no tiene acceso al dominio**, así que no se ha ejecutado contra los
ficheros oficiales. El mapeo de columnas es **por nombre de cabecera**: si algo no cuadra, falla con un
error que lista las cabeceras que encontró, en vez de ingerir datos incorrectos en silencio.

Y la advertencia de siempre: **las casas de apuestas son más afiladas que el ranking**. Sus
cuotas incorporan información que este modelo no ve (lesiones, estado del día, noticias de
última hora, dinero de apostadores informados). Lo más probable sigue siendo que el modelo **no**
supere al mercado; ahora al menos puedes comprobarlo en vez de suponerlo.

Interpreta las discrepancias como *"aquí hay algo que el modelo ve distinto"*, no como *"el
mercado se equivoca"*. Si la diferencia es grande, la explicación más habitual es que el mercado
sabe algo que los datos históricos no contienen.

## Track record en vivo: la app se mide a sí misma (`trackRecord.ts`)

El backtest de arriba mide el modelo sobre el historial. Es la forma correcta de ajustarlo, pero
responde a una pregunta distinta de la del usuario: *¿ha acertado los partidos que yo vi?*

Por eso cada predicción de un partido próximo **real** se escribe en `prediction_log` en el momento
de mostrarse, y se puntúa cuando el resultado llega al historial. Tres propiedades la hacen honesta:

- **Se escribe antes** del partido: no hay retrospectiva posible.
- **Gana el primer valor** (`ON CONFLICT DO NOTHING`): la predicción no puede «mejorarse» a posteriori
  a medida que se mueven las cuotas.
- **Sobrevive a la reingesta** (`resetData()` no la toca), así que el registro se acumula.

Los partidos de demostración se excluyen a propósito: son fixtures sintéticos que nunca se jugarán, y
puntuar contra resultados inventados haría el número inútil.

Emparejar predicción y resultado no es un `JOIN` por fecha exacta: `commence_time` es el inicio del
**partido** y `matches.tourney_date` el del **torneo**, que en un Grand Slam se separan hasta dos
semanas. Se busca en una ventana asimétrica (−10 / +30 días) y gana la fecha más cercana.

Lo valioso es que da la comparación que el backtest **no puede** hacer: modelo contra **mercado** en
partidos idénticos, con las cuotas guardadas en el instante de predecir. Restringido a los partidos
que tenían cuotas, así que ningún lado juega con un conjunto más fácil.

## Limitaciones (sé honesto)

Este modelo **NO** debe usarse para apostar con confianza ciega. Es una **estimación
estadística**, no una certeza. En particular **no** considera:

- Lesiones o molestias físicas de último momento.
- Condiciones climáticas o de pista del día.
- Motivación / contexto (partidos de exhibición, retiros tácticos, fatiga por viajes).
- Cambios de entrenador, estado mental, o cualquier información no reflejada en resultados.

El Elo tarda en reaccionar a cambios bruscos de nivel (una lesión superada, un salto de un
joven) porque promedia el historial. Úsalo como una señal más, no como la única.


## De dónde salen los datos de tenis (y por qué el ATP no llega a hoy)

Esto cambió por completo durante el proyecto y conviene dejarlo escrito, porque no es
un problema de código ni de red:

* **`JeffSackmann/tennis_atp` y `tennis_wta` ya no existen.** Eran el dataset estándar
  del tenis y aquello sobre lo que se diseñó esta app. Hoy devuelven **404**, y no es un
  bloqueo de red: otro repo de la misma cuenta (`tennis_MatchChartingProject`) responde
  con 200 desde el mismo sitio.
* El ATP se pasó a **`Tennismylife/TML-Database`**: mismo formato de columnas, un CSV
  por temporada, con el ranking oficial de cada jugador en cada partido. Pero **el repo
  de GitHub se congeló en enero de 2026** — su propio README dice que la base viva se
  movió a `stats.tennismylife.org`, que no es GitHub. Así que llega a **2026-01-17**.
* **TML nunca cubrió WTA.** No queda ninguna fuente de WTA en GitHub.

Lo que sí llega a la temporada en curso es **tennis-data.co.uk**: un `.xlsx` por
temporada, ATP **y** WTA, y además con las cuotas de cierre. `npm run update-data` ya lo
intenta como reserva automáticamente. No es alcanzable desde el sandbox donde se
desarrolló esto, pero sí desde una red normal.

### 12 partidos con estadísticas imposibles

Al ingerir TML de verdad por primera vez, la verificación encontró **12 partidos de
61.682 (0,02 %)** cuyas estadísticas de saque no pueden existir:

* la final de Lyon 2019 registra **51 primeros saques dentro de 47 puntos al saque**;
* la final de Montecarlo 2023, un jugador que **salva 13 puntos de break habiendo
  afrontado 1**;
* y un grupo de la semana de Copa Davis de septiembre de 2025, que parece un scrapeo
  malo.

La ingesta ahora **descarta el bloque de saque de ese lado** y conserva el partido:
ganador, marcador, rankings y superficie no están afectados, y son lo que alimenta el
Elo. Se descarta el lado **entero**, no solo el campo que falla, porque con `svpt=47` y
`1stIn=51` no hay forma de saber cuál de los dos números es el corrupto — quedarse con
el que «parece razonable» sería adivinar disfrazado de dato. Y se pone a **NULL**, no a
cero: el modelo ya trata un dato ausente como desconocido (no existen antes de ~1991),
mientras que un cero se leería como «no metió ningún ace, no puso ningún primer saque».

`npm run verify:data` comprueba ahora las seis desigualdades que ninguna estadística de
saque puede violar, en los dos lados, y **exige cero**. Junto con ellas comprueba lo que
sí puede caer sin que nada más lo note: que el **marcador concuerde con quién figura
como ganador** (99,93 % de acuerdo en 59.423 partidos completos; el resto son erratas
sueltas del archivo, no un cambio sistemático) y que el mejor clasificado gane más veces
que el peor (65,8 %) — por debajo del 50 % significaría que `winner_rank` y `loser_rank`
están al revés, y eso es invisible para todo lo demás.

## Nota sobre los datos de demostración

`npm run seed` genera datos **sintéticos**: los nombres son reales, pero los partidos están
**simulados** a partir de una habilidad latente por superficie usando la misma fórmula Elo del
modelo. Sirven para probar la app end-to-end sin conexión; **no** son historial real. Usa
`npm run update-data` para cargar el historial real (TML-Database).

Detalles a tener en cuenta con el demo:

- **Escala de Elo comprimida.** Como el demo es un grupo cerrado de 12 jugadores que solo
  juegan entre sí, sus Elos se concentran (aprox. 1300–1750) en lugar de la escala real
  (~1500 promedio, 2000+ el top), donde compiten miles de jugadores. Lo que importa es el
  **orden relativo y la diferencia por superficie**, que sí son correctos. Con datos reales
  (`update-data`) la escala se ve como el Elo de tenis habitual.
- **Fechas y enfrentamientos ilustrativos.** Los próximos partidos del demo son ejemplos
  (etiquetados como "odds demo") con fechas puestas en el mes real de cada torneo; no son el
  calendario real. Los partidos futuros reales llegan de The Odds API.
