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
ataque y defensa del equipo (Dixon-Coles jerárquico)  →  goles esperados de cada equipo
       + ventaja de campo de esa liga                    →  distribución bivariante sobre
       + bajas conocidas (Premier)                          marcadores exactos
                                                        →  1X2, over/under, ambos marcan,
   (equipo sin ajuste → respaldo: brecha de Elo)            hándicaps, rejilla completa,
                                                            diferencia de goles
```

Que **todo** salga de la misma distribución no es solo elegante: hace **imposible** que las cifras se
contradigan. Si cotizaras el 1X2 desde una curva Elo y el over/under desde una media de goles
aparte, podrías acabar diciendo que un partido tiene 70% de victoria local y a la vez 60% de acabar
0-0. Aquí no puede pasar: cada número es una suma sobre la misma rejilla.

### El modelo: Dixon-Coles jerárquico

Cada equipo tiene **dos** números, no uno: cuánto marca y cuánto encaja.

```
λ_local     = exp( μ + ataque_local + defensa_visitante + γ )
λ_visitante = exp( μ + ataque_visitante + defensa_local )
```

`μ` es el nivel de goles de la liga, `γ` la ventaja de campo **de esa liga** (sale del ajuste, no de
una constante: va de ×1,13 a ×1,36 según la competición), y `ataque`/`defensa` son las desviaciones
de cada equipo respecto a la media. Están en escala logarítmica, así que 0 significa exactamente
«equipo medio de esta liga».

Un Elo resume la calidad en **un** número, y por eso no distingue al equipo que gana 3-2 del que
gana 1-0. Los mercados de goles —que son la mitad de la pantalla— dependen justo de esa diferencia.

**Decay temporal.** Cada partido pesa `exp(−ξ · días)` con ξ de **un año de semivida**: lo de hace
doce meses vale la mitad que lo de ayer. El valor no está puesto a mano, se eligió puntuando cuatro
opciones (sin decay, 2 años, 1 año, 6 meses) sobre las temporadas de **entrenamiento**, sin mirar la
validación.

**Priors jerárquicos.** Un equipo con cuatro partidos jugados y tres goleadas a favor no es el mejor
ataque de la liga: es un equipo del que no se sabe casi nada. Los parámetros llevan un prior normal
centrado en la media de la liga con σ = 0,3, así que un equipo con poca historia queda **encogido**
hacia el promedio y solo se separa cuando acumula partidos que lo justifiquen. Es lo que arregla al
recién llegado sin tener que tratarlo aparte.

**Identificabilidad.** Sumar una constante a todos los ataques y restarla de `μ` da exactamente las
mismas predicciones, así que el ajuste recentra ataque y defensa a media cero después de cada paso.
Sin eso los parámetros derivan sin límite y dejan de ser comparables entre equipos.

**Cómo se ajusta.** Máximo a posteriori por ascenso de gradiente (Adam) con gradientes analíticos —
400 iteraciones en frío, 60 partiendo del ajuste anterior. Las 14 ligas enteras tardan ~1 s, así que
se reajusta en `update-data:fb` y se guarda; predecir solo lee.

**Cuándo NO se usa.** Si el ajuste no conoce a alguno de los dos equipos, se cae al camino de Elo. Y
es deliberado: un equipo ausente tendría ataque 0 y defensa 0, o sea «exactamente la media de su
nueva liga», que para un recién ascendido es demasiado generoso. Ese caso lo resuelve mejor el Elo
trasladado con el salto de división medido (§6.5). En el backtest, el 90,1 % de los partidos los
resuelve el Dixon-Coles y el 9,9 % restante el respaldo.

### Elo → goles (el camino de respaldo)

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
positivo se hunden precisamente las casillas que ya escaseaban.

`rho` **también sale del ajuste, por liga**, en vez de ser el −0,10 constante de antes. Y el
resultado tiene interés: en varias ligas sale *positivo*, o sea que la corrección que hacía falta no
era la misma en todas partes. El camino de respaldo sigue usando −0,10.

---

## 2. La métrica correcta: RPS, no «accuracy»

El *acierto* es casi inútil en fútbol: un modelo que **nunca** prediga empate puede lucir un
porcentaje respetable siendo inservible para el resultado que ocurre el 26% de las veces.

El **Ranked Probability Score** respeta el orden local / empate / visitante, así que equivocarse por
un escalón (decir «local» y salir empate) penaliza menos que equivocarse por dos. Es la medida
estándar para pronósticos 1X2. Menor es mejor.

---

## 3. Resultados medidos

Backtest *walk-forward* (`npm run backtest:fb`) sobre **20.824 partidos reales** de 14 ligas. El
backtest **no reimplementa** las reglas: conduce el mismo `replayMatches` que usa la app, recibe de
él el propio λ, y reajusta el Dixon-Coles con el mismo `DcWalkForward` que el estudio — así que no
puede divergir por accidente de lo que corre en producción.

**Las temporadas del holdout final (2026+) no se puntúan.** Entraban en el total —3.399 partidos de
20.824— y ese total es el que cita la ficha de honestidad de la app. Un holdout que entra en el
número que publicas no es un holdout, así que ahora el script lo excluye y lo dice en su salida.
Siguen alimentando la reproducción de ratings, que va en orden cronológico y por tanto nunca deja
que un partido influya en otro anterior.

| Métrica | Dixon-Coles | Elo → λ (anterior) | Referencia |
|---|---|---|---|
| **RPS** | **0,2077** | 0,2089 | predecir siempre la media de la liga ≈ 0,2230 |
| **Log loss** | **1,0147** | 1,0183 | 1,0986 = decir siempre 1/3 |
| Acierto del resultado más probable | 49,5 % | 49,2 % | — |
| Over/under 2.5 acertado | **56,9 %** | 55,9 % | — |
| Error absoluto del total de goles | **1,28** | 1,30 | — |

Los mismos 20.824 partidos en las dos columnas, así que es una comparación pareada.

Por escalón: **primeras divisiones 0,2007** · **segundas 0,2177**. La diferencia es composición, no
regresión — las segundas son más difíciles. Por liga: Primeira 0,1911 · Eredivisie 0,1912 ·
Serie A 0,1959 · LaLiga 0,1982 · Premier 0,2041 · Bundesliga 0,2067 · Ligue 1 0,2094 ·
Championship 0,2224.

### Dónde gana el Dixon-Coles, y dónde no

Esto es lo importante y conviene no adornarlo. `npm run study:dc` lo mide sobre la temporada de
validación (4.479 partidos), con los hiperparámetros elegidos **solo** con temporadas de
entrenamiento:

| Salida | Elo → λ | Dixon-Coles | Diferencia | p |
|---|---|---|---|---|
| 1X2 | 1,01351 | 1,00925 | −0,00426 | 0,0540 |
| **Marcador exacto** | 2,88894 | **2,87171** | **−0,01722** | **0,0005** |
| Más de 2,5 goles | 0,68855 | **0,68241** | −0,00615 | 0,0195 |
| Ambos marcan | 0,69081 | 0,69014 | −0,00067 | 0,7288 |
| **Hándicap −1 local** | 0,48410 | **0,47505** | **−0,00906** | **0,0005** |

Con 16 comparaciones registradas sobre este mismo conjunto, el listón de Bonferroni está en
α = 0,0031. **Lo pasan el marcador exacto y el hándicap.** El 1X2 **no**: cambiar el modelo de
predicción entero NO ha mejorado de forma medible el número que más mira la gente. Y en «ambos
marcan» no cambia nada en absoluto.

La lectura honesta es que la mejora está **en la forma de la distribución de goles**, que es
exactamente donde debía estar: modelar ataque y defensa por separado sirve para los mercados que
dependen de cuántos goles hay, no para acertar quién gana. Los cinco resultados están en
`experiments/registry.jsonl` marcados como `shipped` —incluidos los dos que no convencen— porque
producción usa la misma rejilla para las cinco salidas y esconderlos bajaría el denominador de la
corrección por comparaciones múltiples.

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


### 6.2 El bug que borraba un resultado entero: los 0-0

El más caro de los encontrados en este proyecto, porque no perdía datos al azar —
perdía **un resultado concreto**.

openfootball escribe casi todos los partidos así:

```json
"score": { "ft": [4, 2], "ht": [1, 0] }
```

pero algunos así, sin documentarlo en ninguna parte:

```json
"score": [0, 0]
```

Leer `m.score?.ft` sobre un array da `undefined`, así que el partido se descartaba
como «no jugado». En los ficheros de 2025-26 eran **178 de 2.919 (6,1 %) y los 178
eran 0-0**. No una muestra: todos.

Lo que hacía en la base:

| año | proporción de 0-0 |
|---|---|
| 2024 | 6,57 % |
| 2025 | 3,06 % |
| **2026** | **0,07 %** — un partido de 1.438 |

Un modelo de goles construido sobre eso cree que el empate es más raro, el *over* más
seguro y el «ambos marcan» más probable de lo que son, **justo en las temporadas que
la app usa para predecir**. Y nada fallaba: los totales subían, que es lo que se
espera de una fuente nueva.

Arreglado (`readScore` acepta las dos formas): 21.591 → **21.769 partidos**, la
proporción de 0-0 vuelve a 5,56-7,13 % en las ocho temporadas, y el RPS del backtest
mejora de 0,2063 a **0,2059** sobre 17.227 partidos.

`npm run verify:data` comprueba ahora la proporción de 0-0 **por temporada**, no
sobre todo el archivo: la cifra global se quedaba dentro de cualquier banda razonable
mientras la temporada en curso estaba completamente rota.


### 6.3 Las dos mitades: medido y NO publicado

El marcador al descanso lleva guardado desde la ingesta de openfootball y no lo lee
nadie. Es la pieza que abriría «resultado al descanso», «gana alguna mitad» y HT/FT
— los mercados de los boletos reales. Se midió (`npm run study:ht`), se implementó y
se validó (`npm run study:ht-val`). **No se publica.**

Los hechos, sobre 20.336 partidos:

* El reparto de goles **no es mitad y mitad**: 0,4461 en la primera parte, 5,4 pp por
  debajo de lo ingenuo.
* Las dos mitades son **casi independientes**: correlación −0,064.
* La cuota es **estable**: 0,4374-0,4532 entre ligas, 0,4397-0,4547 entre temporadas.
  Una constante, no diez.

Con eso el modelo es defendible. Y aun así, sobre 4.238 partidos de 2025-26 que los
ratings nunca vieron:

| mercado | modelo | real | dif |
|---|---|---|---|
| descanso 1 | 35,62 % | 36,39 % | +0,77 pp ✓ |
| descanso X | 41,09 % | 36,90 % | **−4,19 pp** |
| descanso 2 | 23,28 % | 26,71 % | **+3,43 pp** |
| el visitante gana alguna mitad | 41,41 % | 49,76 % | **+8,35 pp** |
| descanso +0,5 goles | 71,38 % | 75,39 % | **+4,00 pp** |
| descanso +1,5 goles | 38,19 % | 36,81 % | −1,38 pp ✓ |

El modelo de partido completo está dentro de 1,5 pp en todo lo que publica. De cuatro
a ocho puntos es otra categoría, y «gana alguna mitad» —el motivo de construirlo— es
el peor de todos.

**Y el diagnóstico descarta el arreglo fácil.** Barrer el rho de Dixon-Coles mueve
todo en la dirección correcta pero nunca lo suficiente: en +0,05, que ya invierte el
sentido físico del parámetro, el visitante sigue 5,9 pp corto. El problema es la
FORMA de una media parte:

| goles en la 1ª parte | 0 | 1 | 2 o más |
|---|---|---|---|
| real | 24,09 % | 38,65 % | 37,26 % |
| Poisson (media 1,311) | 26,96 % | 35,34 % | 37,71 % |

El fútbol real tiene 2,9 pp **menos** primeras partes en blanco de las que permite una
Poisson con la media correcta, y rho empuja el 0-0 al lado contrario. La media está
bien por construcción; la familia de distribución está mal. Arreglarlo pide una
distribución de goles por mitad ajustada a esa forma 0/1/2+, no la del partido
completo reescalada.

Contribuye pero no basta: el estado del partido. Tras un descanso igualado hay 1,743
goles en la segunda parte; tras una ventaja de un gol, 1,539; de dos o más, 1,618.

`halfDistributions`, `winsEitherHalf` y `htFtMatrix` se quedan en `model.ts`,
exportadas y con sus números escritos al lado. **No las llama nada en la app.**


### 6.4 Cada club estaba partido en dos: los sufijos legales

Encontrado tirando del hilo de algo que parecía un fallo de interfaz: las seis
tarjetas de la pestaña decían **«fiabilidad baja ±15-18 pp»**. Un indicador que dice
lo mismo siempre no informa, así que fui a arreglarlo — y resultó que **el indicador
tenía razón**:

```
Arsenal FC vs Manchester City     banda ±15.2 pp · baja
   partidos en la base: 266 / 38
   last_date:      20260524 / 20200625
   "Manchester City no tiene partidos desde hace ~6 años"
```

Manchester City con 38 partidos y sin jugar desde 2020 es imposible. openfootball
escribe la temporada 2019-20 con nombres cortos («Manchester City») y todas las
posteriores con la forma legal («Manchester City FC»). Al convertir el nombre en id
sin normalizar, **cada club que jugó esa temporada quedó partido en dos**: la Premier
tenía 40 ids para ~29 clubes reales.

Lo que costaba, que no es cosmético:

| | antes | después |
|---|---|---|
| Equipos (todas las ligas) | 352 | **310** |
| Equipos en la Premier | 40 | **28** |
| Elo del Manchester City | 1556 (#9) | **1733 (#2)** |
| Banda de fiabilidad típica | ±15-18 pp · **baja** | **±3 pp · alta** |
| Partidos evaluables en el backtest | 17.227 | **17.735** |

El Elo del City salía del **único** año que le quedaba asignado —la temporada COVID—
así que la app lo tenía como noveno de la liga. Y las bandas eran anchas porque la
mitad de los equipos de cada tarjeta tenían 38 partidos de historia.

El RPS queda en 0,2061 frente a 0,2059, sobre **508 partidos más**: los que antes no
llegaban al mínimo de partidos previos, que son los inicios de temporada y los más
difíciles. Plano sobre una muestra mayor y más honesta.

Arreglado quitando los tokens de forma legal del slug (`fc`, `afc`, `cf`, `sc`, `ss`,
`vfl`…), no con una lista de alias por liga: la lista de sufijos es corta, cerrada y
la misma en toda Europa, mientras que diez alias por liga son diez oportunidades de
olvidar uno. **No** se quitan las palabras que distinguen clubes reales — «United»,
«City», «Real», «Sporting», «Athletic» se quedan.

Y el nombre que se guarda es el **más largo** de los dos, porque con last-write-wins
la misma tarjeta llegó a decir «Arsenal FC vs Manchester City».

`npm run verify:data` comprueba ahora que ningún club aparezca con dos ids. La
comprobación de round robin que ya existía **no podía** cazarlo: detecta dos equipos
activos *a la vez* que nunca se enfrentan, y aquí las dos mitades vivían en
temporadas disjuntas, así que nunca tuvieron ocasión de no enfrentarse.


### 6.5 Los recién ascendidos: de «sin modelo» a un Elo trasladado y medido

La tarjeta que lo pidió: **Atlético Madrid vs Málaga**, en LaLiga, sin desglose y con
la línea «Probabilidades implícitas del mercado, no del modelo». No era un fallo:
Málaga juega en Segunda, no aparece en la tabla de LaLiga que cubre este archivo, y un
partido cuyo equipo no resuelve no recibe predicción.

No es un caso raro. Son **tres clubes por liga cada agosto**, y durante los primeros
meses de temporada juegan cerca de una quinta parte de los partidos.

**Por qué no vale copiar el Elo de Segunda.** El juego de liga es de suma cero *dentro*
de una división y las dos divisiones no se cruzan, así que ambas tablas están centradas
en 1500 por construcción. Un equipo de 1650 en Segunda no es igual de fuerte que uno de
1650 en Primera. Copiar el número daría una predicción segura y equivocada, que es peor
que el hueco honesto.

**Así que se mide el salto**, por país, con los clubes que de verdad lo dieron: se toma
su Elo de Segunda al final de la temporada del ascenso y se busca el desplazamiento
constante que mejor explica sus resultados reales arriba la temporada siguiente.

| país | salto | desviación entre temporadas | incertidumbre | clubes |
|---|---|---|---|---|
| Inglaterra | −250 Elo | 77 | ±11,1 pp | 18 |
| España | −125 Elo | 38 | ±5,4 pp | 7 |
| Alemania | −185 Elo | 53 | ±7,6 pp | 9 |
| Italia | −200 Elo | 50 | ±7,2 pp | 8 |
| Francia | −165 Elo | 68 | ±9,8 pp | 7 |

Todos negativos, y el orden es el que diría cualquiera que siga el fútbol: la Premier
está más por encima de su segunda que LaLiga de la suya. **Cinco países independientes
coincidiendo en el signo** es lo que convierte esto en un efecto real y no en un ajuste
a 18 clubes ingleses.

**La muestra es pequeña y decirlo importa**: 7-9 clubes por país sobre 3-6 temporadas.
Por eso la dispersión entre temporadas no se promedia y se olvida, sino que se lleva a
la **banda de fiabilidad**: una tarjeta construida sobre un rating trasplantado dice que
está menos segura, y cuánto. El nivel se limita a «media» aunque la banda salga estrecha
— mejor que un hueco, nunca presentado como algo asentado.

Para que exista el dato se ingieren cuatro segundas divisiones más (es.2, de.2, it.2,
fr.2; en.2 ya estaba como Championship): **27.768 partidos en 14 ligas**. El RPS agregado
sube de 0,2059 a 0,2082 y eso es **composición, no regresión** — las segundas son más
difíciles de predecir. Por liga:

| | primeras divisiones | segundas |
|---|---|---|
| partidos | 14.474 | 7.393 |
| RPS | **0,2019** | 0,2206 |

Y las primeras quedan igual o mejor que antes de todo esto: LaLiga 0,1996 → 0,1994,
Bundesliga 0,2071 → 0,2065.

> Esas cifras son **del modelo de Elo y con el holdout dentro**, que es como se midió
> entonces. Las vigentes están en §3: con el Dixon-Coles y sin puntuar 2026+, 0,2007 en
> primeras y 0,2177 en segundas sobre 20.824 partidos. Se dejan porque son el registro de
> por qué se ingirieron las segundas divisiones, no una medida del modelo de hoy.

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
