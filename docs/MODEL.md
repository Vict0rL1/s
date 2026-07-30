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
