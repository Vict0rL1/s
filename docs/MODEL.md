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

Prob(gana J1) = expectedScore(R_eff_J1_ajustado, R_eff_J2_ajustado)
```

Al ser todo en puntos Elo, el desglose que muestra el dashboard (Elo general, Elo superficie,
efectivo, ajuste forma, ajuste H2H, rating ajustado, probabilidad) es completamente auditable.

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

### Resultado medido (ATP, 22.062 partidos out-of-sample, 2015–2026)

| Métrica | Valor | Referencia |
|---|---|---|
| **Accuracy** (acierta al favorito) | **64.8%** | Decir siempre "gana el mejor rankeado": 63.6% |
| **Brier score** | **0.2164** | 0 = perfecto · 0.25 = decir siempre 50/50 |
| **Log loss** | **0.6208** | 0.693 = decir siempre 50/50 |

### Calibración (lo más importante)

| Cuando el modelo dice… | …gana realmente | Error |
|---|---|---|
| 55.0% | 54.4% | −0.5 pp |
| 64.8% | 63.4% | −1.4 pp |
| 74.5% | 73.8% | −0.7 pp |
| 84.2% | 84.5% | +0.3 pp |
| 92.7% | 94.6% | +1.9 pp |

Es decir: **cuando dice 70%, ese lado gana ~70% de las veces**. Las probabilidades son
interpretables literalmente, dentro de ~1–2 puntos porcentuales.

### El factor de calibración

La curva Elo cruda es **sobre-confiada**: sin calibrar, los partidos anunciados al ~85% se ganaban
solo el ~77% (error de −7,6 pp). Por eso se aplica un factor de **0.75** a la diferencia de rating
antes de convertirla en probabilidad (*temperature scaling*; ver `CALIBRATION_SCALE` en
`server/src/model/elo.ts`). Comparación sobre los mismos 22.062 partidos:

| Factor | Brier | Log loss | Error en 80–90% |
|---|---|---|---|
| 1.00 (crudo) | 0.2189 | 0.6282 | −7.6 pp |
| **0.75 (elegido)** | **0.2164** | **0.6208** | **+0.3 pp** |
| 0.85 | 0.2170 | 0.6223 | −2.7 pp |

### Cuando el modelo discrepa del mercado

El modelo elige un ganador distinto al del ranking oficial en el **21,7%** de los partidos. En
esos casos el modelo acierta **52,7%** y el ranking **47,3%**: una ventaja real pero **muy
pequeña**, casi una moneda al aire.

Y una advertencia importante: **las casas de apuestas son más afiladas que el ranking**. Sus
cuotas incorporan información que este modelo no ve (lesiones, estado del día, noticias de
última hora, dinero de apostadores informados). No dispongo de odds históricas para medirlo, así
que **no puedo afirmar que el modelo supere al mercado — y lo más probable es que no lo haga**.

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
