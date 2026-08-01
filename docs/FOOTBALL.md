# ⚽ Cómo funciona el modelo de fútbol

Mismo principio explicable que los otros dos deportes, pero el fútbol rompe el patrón en algo que lo
cambia todo: **el empate**. Alrededor de **1 de cada 4 partidos** termina en tablas, así que una
predicción es una distribución de tres vías, y un modelo que solo diga «probabilidad de que gane el
local» no tiene nada que decir sobre el resultado más frecuente del deporte.

Código: `server/src/football/`.

---

## 1. Una sola distribución, todos los mercados

La cadena es:

```
brecha de Elo + ventaja de campo  →  goles esperados de cada equipo
                                  →  distribución de Poisson sobre marcadores exactos
                                  →  1X2, over/under, ambos marcan, marcador probable
```

Que **todo** salga de la misma distribución no es solo elegante: hace **imposible** que las cifras se
contradigan. Si cotizaras el 1X2 desde una curva Elo y el over/under desde una media de goles
aparte, podrías acabar diciendo que un partido tiene 70% de victoria local y a la vez 60% de acabar
0-0. Aquí no puede pasar: cada número es una suma sobre la misma rejilla.

### Elo → goles

```
tilt   = 10^(brecha · 0.32 / 400)
λ_local     = media_de_goles_de_la_liga · 0.52 · tilt
λ_visitante = media_de_goles_de_la_liga · 0.48 / tilt
```

El ancla es la **media de goles de esa liga**, así que una división que promedia 2.4 goles no se ve
forzada a los 3.1 de la Bundesliga. La brecha de Elo inclina esa base de forma multiplicativa: el
mejor equipo marca más *y* encaja menos, que es lo que ocurre de verdad.

> **Nota de ajuste:** la ventaja de campo y la cuota de goles del local codifican **lo mismo**, así
> que son sustitutos — subir una pide bajar la otra. El óptimo es una cresta plana; se eligió
> 65 Elo + 0.52 entre pares que puntuaban igual porque mantiene la ventaja de campo como una
> cantidad Elo explícita que el desglose puede mostrar.

### Dixon-Coles

Poisson puro trata los goles de los dos equipos como independientes, y falla justo en los marcadores
bajos: 0-0, 1-0, 0-1 y 1-1 ocurren **más** de lo que predice la independencia (un partido cerrado
frena a los dos a la vez). Dixon & Coles (1997) corrigen exactamente esas cuatro casillas con un
parámetro, `rho`.

**El signo importa y es fácil equivocarse:** el rho que *sube* los 0-0 y 1-1 es **negativo**. Con rho
positivo se hunden precisamente las casillas que ya escaseaban. Aquí `rho = −0.10`.

---

## 2. La métrica correcta: RPS, no «accuracy»

El *acierto* es casi inútil en fútbol: un modelo que **nunca** prediga empate puede lucir un
porcentaje respetable siendo inservible para el resultado que ocurre el 26% de las veces.

El **Ranked Probability Score** respeta el orden local / empate / visitante, así que equivocarse por
un escalón (decir «local» y salir empate) penaliza menos que equivocarse por dos. Es la medida
estándar para pronósticos 1X2. Menor es mejor.

---

## 3. Resultados medidos

Backtest *walk-forward* sobre **24.332 partidos reales** de Premier League, LaLiga, Bundesliga y
Championship (2000–2020, datos de footballcsv). El backtest **no reimplementa** las reglas: conduce
el mismo `replayMatches` que usa la app, así que los números describen el modelo que se sirve.

| Métrica | Valor | Referencia |
|---|---|---|
| **RPS** | **0.2072** | predecir siempre la media de la liga ≈ 0.2230 |
| **Log loss** | **1.0104** | 1.0986 = decir siempre 1/3 |
| Acierto del resultado más probable | 49.8% | — |
| Over/under 2.5 acertado | 52.9% | — |
| Error absoluto del total de goles | 1.32 goles | — |

Por liga: LaLiga 0.1960 · Premier 0.1972 · Bundesliga 0.2083 · Championship 0.2174. La segunda
división inglesa es la más impredecible de las cuatro, lo cual es exactamente lo que dice su fama.

### Calibración del empate

Es donde más se nota el trabajo. Antes de ajustar, el modelo **subestimaba los empates entre 5 y 8
puntos porcentuales** en todas las bandas. Después:

| El modelo dice… | …empatan realmente | Error |
|---|---|---|
| 13.0% | 11.1% | −1.9 pp |
| 17.9% | 15.5% | −2.5 pp |
| 23.1% | 24.0% | +0.9 pp |
| 27.7% | 27.7% | **+0.1 pp** |

La banda 25–30% concentra el 73% de los partidos y está clavada.

### Qué aportó cada pieza

| Cambio | RPS |
|---|---|
| Punto de partida (sensibilidad 0.42, rho +0.08) | 0.2121 |
| rho con el signo correcto (−0.12) | 0.2114 |
| sensibilidad Elo→goles bajada a 0.30 | 0.2089 |
| **ajuste conjunto de campo/cuota + rho (final)** | **0.2072** |

```bash
npm run backtest:fb                          # con los parámetros de la app
npm run backtest:fb -- --league epl          # una liga
npm run backtest:fb -- --rho 0               # Poisson puro, para ver qué aporta Dixon-Coles
npm run backtest:fb -- --home 0              # sin ventaja de campo
npm run backtest:fb -- --sensitivity 0.5     # otra conversión Elo→goles
```

Con datos de football-data.co.uk (que traen cuotas 1X2), el backtest imprime además **modelo vs
mercado** en RPS sobre los mismos partidos.

---

## 4. Fuentes de datos

| Para qué | Fuente | Notas |
|---|---|---|
| Resultados actuales + **cuotas 1X2 históricas** | [football-data.co.uk](https://www.football-data.co.uk) | Fuente principal. Un CSV por temporada y división para las ligas europeas; un CSV por país para MLS, Liga MX, Brasileirão y Argentina. |
| Histórico para ajustar | [footballcsv](https://github.com/footballcsv) (GitHub) | ~20 temporadas de Inglaterra, España y Alemania, dominio público. Es con lo que se **ajustó y validó** el modelo. Sin cuotas, y va varias temporadas por detrás. |
| Partidos próximos + cuotas | [The Odds API](https://the-odds-api.com) | La misma key que tenis y baloncesto. |

**Ligas sin fuente de resultados** (Champions League): sus equipos vienen de ligas distintas y su Elo
vive en cada tabla doméstica, así que un rating compartido necesitaría una calibración entre ligas
que esta app no hace. Se muestran los partidos y las probabilidades **del mercado**, dicho
claramente, en vez de inventar una predicción.

**Aviso de verificación:** el entorno donde se desarrolló esto no alcanza football-data.co.uk (solo
GitHub), así que esa ingesta está probada contra ficheros en su formato real y lee las columnas
**por nombre de cabecera**: si algo no cuadra, falla listando las cabeceras encontradas en vez de
ingerir datos incorrectos. El modelo sí está ajustado y medido sobre partidos reales descargados.

---

## 5. Limitaciones

- **No conoce las alineaciones.** Es la mayor de todas: un once rotado antes de un partido europeo
  cambia el pronóstico y el modelo no lo ve.
- No conoce lesiones, sanciones ni traspasos de última hora.
- No sabe si un partido no vale nada (jornada final con todo decidido).
- El Elo de una liga **no es comparable** con el de otra: cada tabla está calibrada sobre sí misma.
- Los equipos **recién ascendidos** empiezan con pocos partidos en su nueva liga, y la app lo marca
  como fiabilidad baja en vez de fingir que sabe.
