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

Los porcentajes se muestran con un decimal, pero **precisión mostrada ≠ exactitud**. Para no
prometer nada sin evidencia, el proyecto incluye un backtest *walk-forward* (cada partido se
predice usando solo información anterior a él, y luego se actualizan los ratings):

```bash
npm run backtest                      # con calibración (lo que usa la app)
npm run backtest -- --calibration 1   # curva Elo cruda, para comparar
```

### Resultado medido (ATP, 6.022 partidos out-of-sample)

| Métrica | Elo crudo | **Calibrado (0.7)** |
|---|---|---|
| Accuracy (acierta al favorito) | 65.8% | **65.8%** |
| Brier score (menor = mejor; 0.25 = decir siempre 50/50) | 0.2177 | **0.2147** |
| Log loss (menor = mejor; 0.693 = 50/50) | 0.6300 | **0.6187** |
| Error de calibración en 70–80% | −5.9 pp | **−0.7 pp** |
| Error de calibración en 80–90% | −9.0 pp | **−0.3 pp** |

**El hallazgo:** la curva Elo cruda es **sobre-confiada**. Los partidos que anunciaba al ~85%
se ganaban solo el ~76% de las veces. Por eso el modelo aplica un **factor de calibración de
0.7** a la diferencia de rating antes de convertirla en probabilidad (equivale a *temperature
scaling* sobre el logit; ver `CALIBRATION_SCALE` en `server/src/model/elo.ts`). Tras calibrar,
lo predicho y lo observado coinciden dentro de ~1 punto porcentual entre el 50% y el 90%.

Interpretación honesta: cuando la app dice 70%, históricamente ese lado ganaba ~70% de las
veces — pero **acierta ~2 de cada 3 partidos**, así que se equivoca a menudo. El tramo
90–100% sigue algo sobre-confiado (−5.9 pp, con muestra pequeña): desconfía de los favoritos
extremos.

### Consistencia de las cifras

Las probabilidades se redondean una sola vez y la contraria se deriva por diferencia, así que
los dos lados **siempre suman exactamente 100.0%** y el texto del resumen usa la misma cifra
que el número grande — nunca verás 63.2% en un sitio y 63% en otro.

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
`npm run update-data` para cargar datos reales de Jeff Sackmann.

Detalles a tener en cuenta con el demo:

- **Escala de Elo comprimida.** Como el demo es un grupo cerrado de 12 jugadores que solo
  juegan entre sí, sus Elos se concentran (aprox. 1300–1750) en lugar de la escala real
  (~1500 promedio, 2000+ el top), donde compiten miles de jugadores. Lo que importa es el
  **orden relativo y la diferencia por superficie**, que sí son correctos. Con datos reales
  (`update-data`) la escala se ve como el Elo de tenis habitual.
- **Fechas y enfrentamientos ilustrativos.** Los próximos partidos del demo son ejemplos
  (etiquetados como "odds demo") con fechas puestas en el mes real de cada torneo; no son el
  calendario real. Los partidos futuros reales llegan de The Odds API.
