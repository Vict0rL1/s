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
