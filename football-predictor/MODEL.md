# Cómo funciona el modelo

Este documento explica el cálculo completo, con los números reales del sistema,
para que puedas auditar cada paso. **Lee también las [limitaciones](#limitaciones):
esto es una estimación estadística, no una certeza.**

## Vista general

Para cada partido se calculan **dos** estimaciones independientes de
(P victoria local, P empate, P victoria visitante) y se promedian:

```
historial de resultados ──► Modelo de Poisson ──► (P_L, P_E, P_V) + marcadores
        (SQLite)      └──► Rating Elo        ──► (P_L, P_E, P_V)

P_final = 0.5 · P_poisson + 0.5 · P_elo        (peso ajustable en config)
```

El marcador más probable y los goles esperados provienen solo del Poisson
(el Elo no modela goles).

## 0. Los datos y el decaimiento temporal

El modelo usa únicamente **resultados finales** (fecha, local, visitante, goles)
de las temporadas cargadas por `scripts/update_data.py`. Todos los promedios
están ponderados por recencia con vida media de **365 días** (configurable):

```
peso(partido) = 0.5 ^ (edad_en_días / 365)
```

| edad del partido | peso |
|---|---|
| hoy | 1.00 |
| 6 meses | 0.71 |
| 1 año | 0.50 |
| 2 años | 0.25 |
| 4 años | 0.06 |

Así el modelo refleja la forma *actual* de cada equipo sin descartar historia.

## 1. Modelo de Poisson (goles esperados)

La idea clásica (Maher, 1982): los goles de cada equipo en un partido se
comportan aproximadamente como una variable de Poisson cuya media depende del
ataque propio, la defensa rival y la ventaja de jugar en casa.

**Parámetros por liga** — promedios ponderados de gol:

- `μ_local`: goles promedio del equipo local (p. ej. Premier League: **1.56**)
- `μ_visita`: goles promedio del visitante (Premier: **1.31**)

Que `μ_local > μ_visita` en todas las ligas *es* la ventaja de local.

**Parámetros por equipo** — dos multiplicadores donde 1.0 = equipo promedio:

- `ataque(e)`: cuánto anota respecto al promedio (1.3 = 30% más goles)
- `defensa(e)`: cuánto concede respecto al promedio (0.8 = 20% menos)

**Goles esperados del cruce:**

```
λ_local  = μ_local  · ataque(local)  · defensa(visitante)
λ_visita = μ_visita · ataque(visitante) · defensa(local)
```

**Ajuste**: los multiplicadores se estiman con un esquema iterativo de punto
fijo — en cada pasada, el ataque de un equipo se multiplica por
(goles reales / goles que el modelo esperaba), ambos ponderados por recencia,
hasta converger (30 iteraciones). Para que los equipos con pocos datos no
salgan disparatados, se añaden `prior_matches = 6` "partidos ficticios" de
nivel exactamente promedio: un recién llegado empieza cerca de 1.0 y solo se
aleja cuando acumula evidencia (regularización por encogimiento).

**De λ a probabilidades**: asumiendo independencia entre los goles de ambos
(simplificación conocida del enfoque), cada marcador (i, j) tiene probabilidad
`Poisson(i; λ_local) · Poisson(j; λ_visita)`. Se evalúa la matriz de 0 a 10
goles y se suma:

- P(victoria local) = Σ de las celdas con i > j
- P(empate) = Σ de la diagonal
- P(victoria visitante) = Σ con i < j
- el marcador más probable = la celda de mayor probabilidad

*Ejemplo real (julio 2026):* Manchester City vs Everton → λ = 2.01 y 0.72
→ 67.7% / 20.0% / 12.3%, marcador más probable 2-0.

## 2. Rating Elo ajustado por margen de gol

Cada equipo tiene un rating (1500 = promedio de la liga al inicio del
historial). Tras cada partido, en orden cronológico:

```
Δ = K · M(margen) · (S − E)
rating(local) += Δ ;  rating(visitante) −= Δ
```

- `S`: resultado real (1 gana local, 0.5 empate, 0 pierde local)
- `E`: resultado esperado según la diferencia de ratings:
  `E = 1 / (1 + 10^(−(R_local + 65 − R_visita)/400))`
- `K = 20`: cuánto se mueve el rating por partido
- `M(margen)`: multiplicador de eloratings.net — ganar por goleada mueve más:

| diferencia de goles | 0–1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| M | 1.00 | 1.50 | 1.75 | 1.88 | 2.00 |

Además: entre temporadas cada rating regresa un 10% hacia 1500 (las plantillas
cambian en verano) y un equipo que aparece por primera vez (ascendido) arranca
en 1450, algo por debajo del promedio.

**De ratings a probabilidades — modelo de Davidson (1970)**, una extensión del
Elo que trata el empate explícitamente. Con `d = R_local + HA − R_visita`:

```
γ = 10^(d/400)
P_local = γ / (γ + 1 + ν·√γ)
P_empate = ν·√γ / (γ + 1 + ν·√γ)
P_visita = 1 / (γ + 1 + ν·√γ)
```

Los dos parámetros libres **no se inventan, se calibran con los datos de cada
liga** buscando por bisección los valores con los que la frecuencia media
predicha iguala a la observada (ponderada por recencia):

- `HA`: ventaja de local en puntos Elo (calibra la tasa de victorias locales)
- `ν`: propensión al empate de la liga (calibra la tasa de empates)

**Valores calibrados reales (julio 2026):**

| liga | μ_local | μ_visita | HA (elo) | ν | líder Elo |
|---|---|---|---|---|---|
| Premier League | 1.56 | 1.31 | 58 | 0.75 | Arsenal FC (1738) |
| La Liga | 1.52 | 1.13 | 102 | 0.75 | FC Barcelona (1773) |
| Serie A | 1.33 | 1.18 | 37 | 0.82 | Inter (1766) |
| Bundesliga | 1.75 | 1.45 | 52 | 0.74 | Bayern München (1824) |
| Ligue 1 | 1.56 | 1.29 | 64 | 0.68 | PSG (1749) |
| Liga MX | 1.56 | 1.19 | 93 | 0.74 | Toluca (1654) |

Se leen cosas conocidas del fútbol real: La Liga y la Liga MX tienen la mayor
ventaja de local; la Serie A es la liga más empatadora (ν más alto); la
Bundesliga es la más goleadora.

## 3. La mezcla

```
P_final(r) = w · P_poisson(r) + (1 − w) · P_elo(r),   w = 0.5
```

(y se renormaliza para que sume exactamente 100%). Son dos vistas
complementarias del mismo historial: el Poisson mira la estructura fina de
goles anotados/concedidos; el Elo mira la trayectoria de resultados contra la
calidad específica de cada rival. Promediar dos estimadores razonables y poco
correlacionados en sus errores tiende a mejorar la calibración — y el backtest
lo confirma (la mezcla tiene el mejor Brier global).

## 4. Backtest honesto (sin ver el futuro)

`scripts/backtest.py` recorre la última temporada completa de cada liga en
orden cronológico; para cada jornada reajusta el modelo **solo con partidos
anteriores a esa fecha** y compara la predicción con lo que pasó.

- **accuracy**: % de aciertos apostando al resultado más probable.
- **Brier**: error cuadrático de las probabilidades (0 = perfecto; 0.667 =
  decir siempre ⅓-⅓-⅓). Premia probabilidades bien calibradas, no la valentía.

Resultados (julio 2026, temporada 2025-26; Liga MX 2024-25):

| liga | n | mezcla acc / Brier | Poisson | Elo | frecuencias liga | uniforme |
|---|---|---|---|---|---|---|
| Premier League | 380 | 47.6% / 0.615 | 47.6% / 0.618 | 47.6% / 0.616 | 42.6% / 0.657 | 42.6% / 0.667 |
| La Liga | 380 | 52.9% / 0.581 | 53.2% / 0.583 | 52.9% / 0.584 | 48.9% / 0.633 | 48.9% / 0.667 |
| Serie A | 380 | 51.6% / 0.595 | 51.3% / 0.594 | 50.0% / 0.599 | 38.9% / 0.659 | 38.9% / 0.667 |
| Bundesliga | 306 | 54.2% / 0.577 | 54.9% / 0.579 | 54.9% / 0.578 | 43.8% / 0.648 | 43.8% / 0.667 |
| Ligue 1 | 305 | 52.1% / 0.596 | 51.8% / 0.598 | 51.8% / 0.595 | 46.2% / 0.644 | 46.2% / 0.667 |
| Liga MX | 340 | 53.8% / 0.583 | 52.9% / 0.586 | 54.1% / 0.583 | 48.8% / 0.633 | 48.8% / 0.667 |
| **promedio pond.** | 2091 | **51.9% / 0.592** | 51.8% / 0.594 | 51.7% / 0.593 | 44.8% / 0.646 | 44.8% / 0.667 |

**Cómo leerlo:** el modelo acierta ≈52% de los resultados 1X2 — claramente
mejor que el azar informado (~45%), y en línea con lo que logran los modelos
académicos que solo usan resultados (típicamente 50–55%). Ese es el techo
realista: el fútbol tiene mucha varianza (un solo gol decide) y los empates son
casi impredecibles. Nota la variación entre ligas y temporadas: la Premier
2025-26 fue especialmente caótica (47.6%).

## Limitaciones

1. **Solo resultados.** No ve lesiones, fichajes, sanciones, cansancio de
   copas, cambios de DT, clima ni alineaciones. Un experto humano (y el
   mercado de apuestas) sí.
2. **Las casas de apuestas son más precisas.** Sus cuotas incorporan toda la
   información pública + el dinero de miles de apostadores. Este modelo NO
   encuentra "value bets"; **no apuestes con esto.**
3. **La independencia de Poisson es una simplificación**: subestima levemente
   los empates cortos (0-0, 1-1). La mezcla con Davidson lo compensa en parte.
4. **Equipos recién ascendidos** casi no tienen datos: arrancan como "equipo
   promedio tirando a débil" y el modelo lo avisa en `notes`.
5. **Liga MX**: las fuentes abiertas publican 2025-26 con retraso; hasta que
   aparezca, el rating de esa liga no incluye los torneos más recientes.
   La estructura Apertura/Clausura + Liguilla también hace su historia
   menos "lineal" que la europea.
6. **~0.2% de partidos** del historial vienen sin marcador en la fuente
   (huecos del dataset); se ignoran al entrenar.

## Parámetros ajustables (config/leagues.json → "model")

| parámetro | default | efecto |
|---|---|---|
| `blend_weight_poisson` | 0.5 | peso del Poisson en la mezcla (1 = solo Poisson) |
| `decay_half_life_days` | 365 | vida media del peso temporal; menos = más reactivo a la forma reciente |
| `poisson.prior_matches` | 6 | encogimiento hacia el promedio para equipos con pocos datos |
| `poisson.max_goals` | 10 | tamaño de la matriz de marcadores |
| `elo.k` | 20 | sensibilidad del rating a cada resultado |
| `elo.new_team_rating` | 1450 | rating inicial de un equipo sin historial |
| `elo.season_regression` | 0.1 | regresión a la media entre temporadas |
