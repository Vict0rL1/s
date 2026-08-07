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
       + bajas conocidas (Premier)   →  distribución de Poisson sobre marcadores exactos
                                     →  1X2, over/under, ambos marcan, rejilla completa
                                        de marcadores, diferencia de goles
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

Backtest *walk-forward* sobre **17.200 partidos reales** de Premier League, LaLiga, Bundesliga y
Championship (datos de footballcsv). El backtest **no reimplementa** las reglas: conduce el mismo
`replayMatches` que usa la app — y desde esta versión recibe de él el propio λ, en vez de volver a
calcularlo por su cuenta, así que no puede ni siquiera divergir por accidente.

| Métrica | Valor | Referencia |
|---|---|---|
| **RPS** | **0.2063** | predecir siempre la media de la liga ≈ 0.2230 |
| **Log loss** | **1.0075** | 1.0986 = decir siempre 1/3 |
| Acierto del resultado más probable | 49.9% | — |
| Over/under 2.5 acertado | 53.1% | — |
| Error absoluto del total de goles | 1.32 goles | — |

Por liga: LaLiga 0.1960 · Premier 0.1963 · Bundesliga 0.2090 · Championship 0.2173. La segunda
división inglesa es la más impredecible de las cuatro, lo cual es exactamente lo que dice su fama.

### Calibración del empate

Es donde más se nota el trabajo. Antes de ajustar, el modelo **subestimaba los empates entre 5 y 8
puntos porcentuales** en todas las bandas. Después:

| El modelo dice… | …empatan realmente | Error |
|---|---|---|
| 13.0% | 10.1% | −3.0 pp |
| 17.9% | 15.2% | −2.7 pp |
| 23.1% | 23.5% | +0.4 pp |
| 27.4% | 28.1% | **+0.7 pp** |

La banda 25–30% concentra el 71% de los partidos y está clavada. Las dos bandas bajas siguen
quedándose cortas, pero entre las dos son el 8% de los partidos.

### Qué aportó cada pieza

| Cambio | RPS |
|---|---|
| Punto de partida (sensibilidad 0.42, rho +0.08) | 0.2121 |
| rho con el signo correcto (−0.12) | 0.2114 |
| sensibilidad Elo→goles bajada a 0.30 | 0.2089 |
| ajuste conjunto de campo/cuota + rho | 0.2072 |
| **ancla de goles de la liga que se mueve con la liga (final)** | **0.2063** |

```bash
npm run backtest:fb                          # con los parámetros de la app
npm run backtest:fb -- --league epl          # una liga
npm run backtest:fb -- --rho 0               # Poisson puro, para ver qué aporta Dixon-Coles
npm run backtest:fb -- --home 0              # sin ventaja de campo
npm run backtest:fb -- --sensitivity 0.5     # otra conversión Elo→goles
npm run backtest:fb -- --attack 0.02         # enciende ataque/defensa por equipo
npm run backtest:fb -- --momentum 30         # enciende la racha
npm run backtest:fb -- --rest 30             # enciende la congestión de calendario
```

Con datos de football-data.co.uk (que traen cuotas 1X2), el backtest imprime además **modelo vs
mercado** en RPS sobre los mismos partidos.

---

### Tres cosas que se probaron y NO funcionaron

Están implementadas, medidas y **apagadas**, con su interruptor puesto para que
cualquiera pueda repetir la comprobación en vez de creerse este documento.

| Señal | Idea | Resultado | Cómo repetirlo |
|---|---|---|---|
| **Ataque / defensa por equipo** (`strength.ts`) | Dos equipos con el mismo Elo no marcan igual: uno gana 1-0 y otro 3-2. Multiplicadores aprendidos del residuo de goles. | Mejora el RPS 0.20630 → 0.20611 y el error de goles 1.324 → 1.316, pero **empeora la verosimilitud del marcador exacto** 2.9131 → 2.9145 y el over/under 53.1% → 52.8%. Los dos efectos son significativos y **apuntan en direcciones opuestas**: eso es ajustar ruido, no señal. Y lo que estropea es justo la rejilla de marcadores. | `--attack 0.02` |
| **Momento / racha** (`momentum.ts`) | Un equipo puede estar jugando por encima de su Elo. | Empeora de forma **monótona**: 0.20630 → 0.20640 (15 Elo) → 0.20659 (30) → 0.20752 (70). Sin pico, solo daño creciente. Es lo que se espera de una señal redundante: el Elo **es** una acumulación de sorpresas. | `--momentum 30` |
| **Congestión de calendario** (`momentum.ts`) | Tres partidos en siete días pasan factura. | Mueve el RPS menos de 0.0001 con cualquier peso. Y **no es por falta de datos**: en este corpus el 15,3% de los partidos se juega con tres días de descanso o menos, y el 26,5% con cuatro o menos. | `--rest 30` |

La causa común es la misma: el Elo ya lleva peso por diferencia de goles, así que
la parte de «calidad» de cada una de estas señales ya está contada una vez. Lo
único que sí aportó fue mover el **ancla de goles de la liga** en vez de
congelarla — la Premier ganó ~0,3 goles por partido entre 2007 y 2021 — y eso
mejoró todo a la vez: over/under 52,5% → 53,1%, error de goles 1,328 → 1,324,
marcador exacto 2,9158 → 2,9131.

**La conclusión útil** es que ninguna señal *de equipo* podía resolver esto,
porque a todas les falta el mismo dato: quién juega. Eso es la sección 4.

---

## 4. Los jugadores: la única señal que el Elo no contenía

Código: `server/src/football/players.ts`.

Tres temporadas de alineaciones reales de la Premier League (1.663 partidos-equipo
tras los filtros), todo **dejando fuera la jornada que se predice** para que la
valoración de un jugador nunca contenga el partido que sirve para juzgarla, y todo
corregido por **rival y campo** — sin esa corrección, «once de gala» quiere decir
en realidad «los partidos en los que el entrenador puso el once de gala».

| Falta este % del ataque del once habitual | Goles marcados vs esperados |
|---|---|
| 0–5% (n=113) | **+24,9%** |
| 5–15% (n=260) | +1,1% |
| 15–25% (n=413) | +2,1% |
| 25–40% (n=513) | −4,4% |
| >40% (n=364) | −5,6% |

| Falta este % de los minutos del once habitual | Goles encajados vs esperados |
|---|---|
| 0–5% (n=28) | **−31,9%** |
| 5–15% (n=355) | −4,5% |
| 15–25% (n=531) | −2,4% |
| 25–40% (n=548) | +5,8% |
| >40% (n=201) | +0,4% |

Monótono en ambos sentidos y significativo en ambos: la razón de verosimilitud
contra «la alineación no dice nada» da **χ² = 6,1** para los goles marcados y
**χ² = 6,2** para los encajados (3,84 es p<0,05).

### El detalle que evita contar dos veces

Por defecto **no marcar a nadie no cambia nada**, y eso no es pereza.

El rating de un equipo está construido con partidos que ya llevaban su rotación
habitual: de media falta el **28% del ataque** del once titular. Así que la
predicción base ya supone un equipo algo rotado. Saber que un jugador que vale el
25% del ataque está lesionado **no** significa que falte el 25% en vez del 28%
habitual: significa que falta ese 25% **y además** el resto del plantel sigue
rotando como siempre. El exceso sobre la base es `s · (1 − 0,28)`, no `s`.

Aplicar el peso a `s` directamente exagera cada baja un tercio — que es justo la
dirección en la que un modelo así se engaña a sí mismo, porque reaccionar
aparatosamente a las noticias parece perspicaz.

Y dar un **bonus** cuando no has marcado a nadie sería tratar «no sé la
alineación» como «están todos sanos», que es exactamente al revés: no saberlo es
el estado normal, y el modelo ya está calibrado para eso.

### De dónde salen los datos, y hasta dónde llegan

[vaastav/Fantasy-Premier-League](https://github.com/vaastav/Fantasy-Premier-League)
(GitHub, dominio público, sin API key): minutos, titularidades, goles y
asistencias esperados por 90 minutos, y el **parte de lesionados y sancionados
del día**. Se refresca solo con `npm run update-squads:fb`, que no toca ni los
resultados ni el Elo — la lista de lesionados cambia a diario y el histórico no.

**Solo la Premier League.** No existe un equivalente abierto para LaLiga o la
Bundesliga, así que en el resto de ligas el panel no aparece en vez de aparecer
vacío: «no hay datos de plantilla» y «no hay bajas» son cosas distintas y la app
no las confunde.

### Y lo que la app no puede saber sola

La alineación se publica una hora antes del partido. El modelo no la ve; **tú
sí**. Por eso el panel «Quién juega» es un campo de entrada, no un informe:
marcas quién no juega y se recalcula la distribución entera — el 1X2, los goles y
la rejilla de marcadores, todo a la vez, porque todo sale del mismo sitio.

Las predicciones que tú has ajustado **no entran en el track record**: puntuar al
modelo por una alineación que le diste tú no mediría al modelo.

---

## 5. La rejilla de marcadores

Todo lo anterior desemboca en un objeto: `grid[goles_local][goles_visitante]`,
7×7, que suma 1 junto con su cola. El 1X2 es la suma de tres bloques de esa
rejilla; el over/under es una suma de diagonales; «ambos marcan» es el
sub-cuadrante que excluye la fila 0 y la columna 0; la **diferencia de goles** son
las diagonales.

Que la interfaz reciba la rejilla entera —y no cifras recalculadas en el
navegador— es lo que garantiza que la matriz de la pantalla **no pueda
contradecir** los porcentajes impresos encima de ella.

---

## 6. Fuentes de datos

| Para qué | Fuente | Notas |
|---|---|---|
| Resultados actuales + **cuotas 1X2 históricas** | [football-data.co.uk](https://www.football-data.co.uk) | Fuente principal. Un CSV por temporada y división para las ligas europeas; un CSV por país para MLS, Liga MX, Brasileirão y Argentina. |
| **Resultados hasta la temporada actual** | [openfootball/football.json](https://github.com/openfootball/football.json) (GitHub) | La fuente principal de *resultados*. Solo GitHub, sin key, y llega a **2026-05-24**. Trae también el marcador al descanso. |
| Histórico para ajustar | [footballcsv](https://github.com/footballcsv) (GitHub) | ~20 temporadas de Inglaterra, España y Alemania, dominio público. Es con lo que se **ajustó y validó** el modelo. **Ya solo es el último recurso: se quedó en 2020-21.** |
| Partidos próximos + cuotas | [The Odds API](https://the-odds-api.com) | La misma key que tenis y baloncesto. |
| **Plantillas y lesionados** (solo Premier) | [vaastav/Fantasy-Premier-League](https://github.com/vaastav/Fantasy-Premier-League) (GitHub) | Minutos, titularidades, goles y asistencias esperados por 90, y el parte de bajas del día. Dominio público, sin key. Se refresca aparte con `npm run update-squads:fb`. |


### 6.1 Por qué openfootball, y qué cambió

`footballcsv` está muerto a efectos prácticos: su último partido es del **2020-07-26**.
El modelo estaba ajustado sobre él, así que los Elo describían el fútbol de hace seis
años. Buscando por qué, resultó que footballcsv se genera a partir de un proyecto que
**sí** sigue vivo, `openfootball/football.json`, en el mismo GitHub.

Lo que cambió al pasarse:

| | antes | después |
|---|---|---|
| Último partido | 2020-07-26 | **2026-05-24** |
| Ligas con Elo | 4 | **10** |
| Partidos | 19.483 | **21.591** |

Serie A, Ligue 1, Eredivisie, Primeira, Liga MX y Argentina **no tenían modelo** y
ahora lo tienen.

Las dos fuentes son **complementarias, no alternativas**: openfootball trae los
resultados y llega a la temporada actual, pero no trae cuotas; football-data.co.uk trae
las **cuotas de cierre 1X2** de las que depende la comparación con el mercado. La
ingesta corre las dos y, al insertar, openfootball no toca las columnas de cuotas.

Y lo que hay que destacar: al reajustar sobre 10 ligas, **el RPS se quedó en 0,2063**
sobre 17.049 partidos, cinco de esas ligas nunca vistas durante el ajuste. Que el
número no se mueva al meterle competiciones nuevas es la mejor señal de que el modelo
generaliza y no estaba sobreajustado a las cuatro originales.

**Los marcadores al descanso se guardan pero todavía NO se modelan.** openfootball los
trae (`ht_home_goals` / `ht_away_goals`, entre ~2.000 y ~3.600 por liga) y están en la
tabla. Es lo que haría posible un mercado tipo «gana cualquier mitad» de verdad, medido,
en vez de inventado — pero mientras no esté medido, no se ofrece.

**Ligas sin fuente de resultados** (Champions League): sus equipos vienen de ligas distintas y su Elo
vive en cada tabla doméstica, así que un rating compartido necesitaría una calibración entre ligas
que esta app no hace. Se muestran los partidos y las probabilidades **del mercado**, dicho
claramente, en vez de inventar una predicción.

**Aviso de verificación:** el entorno donde se desarrolló esto no alcanza football-data.co.uk (solo
GitHub), así que esa ingesta está probada contra ficheros en su formato real y lee las columnas
**por nombre de cabecera**: si algo no cuadra, falla listando las cabeceras encontradas en vez de
ingerir datos incorrectos. El modelo sí está ajustado y medido sobre partidos reales descargados.

---

## 7. Limitaciones

- **Fuera de la Premier League no conoce las alineaciones**, y sigue siendo la mayor de todas: un
  once rotado antes de un partido europeo cambia el pronóstico y el modelo no lo ve. En la Premier
  sí ve las lesiones y sanciones publicadas, y acepta que le digas el resto (sección 4).
- Ni siquiera en la Premier adivina la alineación: hasta que se publica, supone la habitual.
- El peso de las bajas está ajustado **solo sobre datos ingleses**. Que se parezca en otras ligas es
  razonable, pero no está medido, y por eso el panel no aparece donde no hay datos.
- No sabe si un partido no vale nada (jornada final con todo decidido).
- El Elo de una liga **no es comparable** con el de otra: cada tabla está calibrada sobre sí misma.
- Los equipos **recién ascendidos** empiezan con pocos partidos en su nueva liga, y la app lo marca
  como fiabilidad baja en vez de fingir que sabe.
