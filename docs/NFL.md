# Fútbol americano (NFL) — cómo funciona el modelo

El quinto deporte de la app, y el que obligó al mayor cambio de método. Tres hechos
sobre la NFL mandan sobre todo lo demás.

---

## 1. El margen no es una curva suave

Un touchdown son 7 puntos y un field goal 3. El marcador solo se puede mover en esos
saltos, y el margen final hereda los grumos:

| Margen | Frecuencia | | Margen | Frecuencia |
|-------:|-----------:|-|-------:|-----------:|
| **3**  | **15.1 %** | | 9      | 1.6 % |
| **7**  | **9.0 %**  | | 12     | 1.7 % |
| 6      | 6.0 %      | | 15     | 1.5 % |
| **10** | 5.5 %      | | 11     | 2.4 % |
| **14** | 4.9 %      | | 5      | 3.6 % |

(7.276 partidos, 1999–2025.)

Una normal reparte casi la misma masa en 9 y en 10; la realidad pone **3,4 veces más**
en el 10. Y no son diferencias decorativas: el 3 y el 7 son los dos números alrededor
de los que se construye todo el mercado de hándicap, así que una curva suave se
equivoca justo donde le están preguntando.

**Los picos son absolutos, no relativos a la línea.** Medido por tramos del spread de
cierre, el ±3 es el margen más frecuente en *todos* ellos, incluso cuando el favorito
es el visitante por más de un touchdown. Los grumos pertenecen al marcador, no al
emparejamiento.

Así que la distribución de margen es **una normal multiplicada por una tabla de pesos
por margen**, medidos sobre los propios partidos y renormalizada. Los pesos salen de
dividir (partidos con ese margen) entre (los que esperaba una normal), sobre 2006–2025
y usando el margen esperado *del modelo*, no el del mercado:

```
 3 → 2.75×     el field goal, con diferencia el número más importante del deporte
 7 → 1.84×     el touchdown
14 → 1.44×     dos touchdowns
10 → 1.22×     touchdown + field goal
 9 → 0.36×     un margen que necesita una combinación rara
 0 → 0.10×     la prórroga resuelve casi todos los empates: 15 en 7.276 partidos
```

**Lo que vale, medido fuera de muestra** (ajustado ≤2017, probado 2018+):

| | Log-verosimilitud por partido |
|---|---:|
| Normal sola | −3.997 |
| Normal × números clave | **−3.875** |

**+0,123 nats, 1,13× más verosímil.** En el pipeline completo que corre la app la
mejora es de **+0,141 nats (1,15×)**. Se comprueba con `npm run backtest:naf -- --key-numbers 0`.

La misma idea aplicada al **total** rinde mucho menos (+0,020 nats) y la tabla no tiene
una estructura legible, que es la firma del ruido, así que esos pesos van encogidos un
75 % hacia 1 — nivel elegido también fuera de muestra (+0,024 frente a +0,020 sin
encoger).

---

## 2. La ventaja de campo se movió, así que se sigue en vez de fijarse

| Era | Margen medio del local |
|---|---:|
| 1999–2007 | +2.75 pts |
| 2008–2015 | +2.44 pts |
| 2016–2019 | +1.94 pts |
| 2020–2025 | +1.92 pts |

Y en 2020, con los estadios vacíos, **el modelo la vio caer sola a +0.30 puntos**.

Una constante ajustada sobre 27 temporadas no describe ninguna de ellas: el óptimo es
~50 puntos Elo para 2010–2019 y ~30 para 2020–2025. Así que aquí la ventaja de campo es
una cantidad que se rastrea, no un ajuste. Un EWMA con α = 1/512 (unas dos temporadas
de memoria) sobre la parte del resultado que los ratings **no** explican:

| Evaluado en 2020–2025 | Log loss |
|---|---:|
| Ventaja de campo fija | 0.6389 |
| Ventaja de campo rastreada | **0.6353** |

Los partidos en campo neutral (Londres, la Super Bowl) no reciben ninguna: no es una
decisión de modelado, es lo que significa «neutral», y nflverse los marca.

---

## 3. Se puede medir contra el mercado. Y no lo bate.

En los otros cuatro deportes «¿es el modelo mejor que el precio?» es una pregunta que
ningún dato disponible puede responder, y sus documentos lo dicen en vez de disimularlo.
La NFL es la excepción: nflverse publica el **spread y el total de cierre en el 100 %**
de los partidos desde 1999 y los moneyline desde 2006.

`npm run backtest:naf`, temporadas 2010+ (4.362 partidos con moneyline):

| | Modelo | Mercado |
|---|---:|---:|
| Error del margen (sd) | 13.40 | **13.04** |
| Error del total (sd) | 13.56 | **13.23** |
| Log loss del ganador | 0.6306 | **0.6101** |
| Brier del ganador | 0.2196 | **0.2106** |

| Apostando el lado que prefiere el modelo, a la línea de cierre | |
|---|---:|
| Contra el hándicap | 50.7 % |
| Over / under | 50.3 % |
| **Umbral para no perder dinero con comisión −110** | **52.4 %** |

**El modelo no bate a la línea, y ese es el resultado correcto.** La línea de cierre de
la NFL es el precio más afinado del deporte; un modelo que dijera batirla sobre 20 años
de datos estaría anunciando un bug, no una ventaja. Lo que sí hace es quedarse a 0,34
puntos de ella, y «cerca de la línea de cierre» es un listón exigente y comprobable.

Por eso la app **no vende sus etiquetas de «posible value» como dinero seguro**, y por
eso este número está en el panel de aciertos y no en la letra pequeña.

Esa misma comparación permite algo que ningún otro deporte de la app puede hacer:
**calibrar la banda de incertidumbre contra algo externo**. El modelo se separa de la
línea de cierre 7,3 pp de media (mediana 6,0, percentil 90 14,8), así que la tarjeta
dice ±7,3 pp. Antes heredaba una constante del béisbol y decía ±18,5 pp en todos los
partidos, que es a la vez falso y la señal de que no estaba midiendo nada.

---

## El resto de las piezas, todas medidas

| Parámetro | Valor | Cómo se eligió |
|---|---:|---|
| K | 18 | Barrido: 14 → 0.6339, 18 → **0.6330**, 25 → 0.6348 |
| Carryover entre temporadas | 0.60 | 0.6 → **0.6312**, 0.8 → 0.6344, 1.0 → 0.6464. El más bajo de los cinco deportes: el draft, la agencia libre y el tope salarial existen justamente para que los equipos no sigan igual |
| Multiplicador de margen | activado | Con → **0.6306** y sd 13.40; sin → 0.6464 y sd 13.65. La mayor ganancia individual del modelo |
| Elo por punto de margen | 20 | 22 gana por 0.02 de sd del margen; 20 gana en log loss (0.6306 vs 0.6313) y arregla una infraconfianza visible en la calibración |
| σ del margen | 13.5 | Residuo medido sobre 2006+ (el del mercado es 13.20) |
| σ del total | 13.6 | Ídem (el del mercado es 13.23) |
| Ritmo de anotación (EWMA) | α = 0.10 | sd del error del total 13.55 frente a 13.90 con una constante de liga |

### Lo que se midió y **no** vale nada

Tres afirmaciones repetidísimas en la NFL. Ninguna aparece en el cuarto decimal sobre
más de 4.000 partidos, y las tres se quedan en el código apagadas con su bandera, para
que la medición sea reproducible:

| | Efecto en log loss |
|---|---|
| Días de descanso | 0 → 0.6312 · 4 → 0.6308 · 12 → 0.6323 |
| La semana de bye | 0 → 0.6312 · 15 → 0.6310 · 30 → 0.6312 |
| «Los partidos de división son más cerrados» | 0 → 0.6312 · −20 % → 0.6312 · −40 % → 0.6314 |

```bash
npm run backtest:naf -- --key-numbers 0     # sin números clave
npm run backtest:naf -- --home 55           # ventaja de campo fija
npm run backtest:naf -- --mov 0             # sin multiplicador de margen
npm run backtest:naf -- --carry 0.8         # otro carryover
npm run backtest:naf -- --from 2020         # solo la era moderna
```

---

## De una distribución salen todos los mercados

Igual que en los otros cuatro deportes, **todo se lee de la misma distribución**, y la
auditoría (`npm run audit`) lo comprueba con 12 propiedades por partido:

- ganador, empate y derrota suman 1 (y el empate, 0,2 %, no se esconde);
- el hándicap cumple cubre + nulo + falla = 1 **por los dos lados**, y los dos lados son
  espejo exacto uno del otro;
- **el hándicap de 0 es exactamente la probabilidad de ganar** — la comprobación que ata
  los dos mercados y que habría cazado el error de signo que tuvo la línea;
- el hándicap es monótono en la línea: dar más puntos nunca puede reducir la
  probabilidad de cubrirlos;
- las bandas de margen suman 1 y la del 0 vale exactamente P(empate);
- los puntos esperados reproducen el margen y el total;
- **los factores del «por qué» suman el margen del titular** — una comprobación añadida
  después de encontrar un panel que listaba 7,3 puntos de razones bajo un pronóstico de
  5,2, porque usaba los Elo sin regresar y metía entre ellos el ataque y la defensa, que
  mueven el total y no el margen.

### Los marcadores probables, y su límite

Un marcador queda fijado por su margen y su total juntos, con la restricción de paridad
`local = (total + margen) / 2`. Enumerar los pares válidos y renormalizar es lo que
mantiene ese panel coherente con los dos de arriba.

**A cambio, no sabe que 22 puntos es un marcador raro y 24 uno corriente.** Los puntos de
un equipo tienen sus propios números clave (20 en el 7,2 % de los partidos, 24 en el
6,6 %, 27 en el 6,1 %) y esta construcción no los captura. Ponderarlos rompería la
coherencia con el margen y el total, que es la propiedad que la app defiende en los cinco
deportes; se prefiere un panel coherente y un límite escrito a un panel más bonito que
contradiga al de al lado.

---

## Una trampa del calendario: la pretemporada

La NFL juega 18 semanas y para siete meses. Eso rompe dos cosas que en los otros
deportes funcionan solas:

1. **Los Elo llegan sin regresar.** El replay regresa los ratings al cruzar una temporada,
   pero eso ocurre al encontrar el primer partido de la nueva — y en septiembre todavía no
   hay ninguno en el archivo. El pronóstico de la semana 1 se hacía con los ratings de
   febrero a plena potencia: daba a Seattle por 7,3 puntos contra una línea de 3,5, y esa
   discrepancia era error del modelo, no ventaja. Ahora la ruta de predicción aplica el
   mismo 0,6 por cada pretemporada cruzada, y el pronóstico baja a 5,2.

2. **«El historial termina hace 5 meses» no significa nada en julio.** Los otros deportes
   miden lo rancio en meses; aquí eso disparaba «fiabilidad baja ±59,5 pp» sobre un
   archivo de 27 temporadas impecable. Lo que cuesta precisión son las **temporadas que
   faltan**, y eso es lo que se cuenta.

---

## Fuente de datos

**[nflverse/nfldata](https://github.com/nflverse/nfldata)** — `data/games.csv`, un fichero
de 2 MB con una fila por partido desde 1999. Es la única fuente gratuita que trae juntos
el resultado, las líneas de cierre y **el calendario de la temporada que viene antes de
jugarse**. Eso último es lo que hace que esta pestaña funcione con partidos reales
**sin ninguna API key**; las cuotas sí necesitan `ODDS_API_KEY`.

El parser lee las columnas **por nombre** y falla en voz alta nombrando las que no
encuentra. nflverse añade columnas con frecuencia (`ftn`, `pff` y `away_qb_id` aparecieron
después de escribir esto); leerlas por posición habría convertido cada una de esas altas
en una corrupción silenciosa.

Las franquicias que se mudaron se pliegan en un solo equipo (OAK→LV, SD→LAC, STL→LA). Sin
eso la liga tendría 39 equipos, varios con media historia cada uno.

---

## Lo que el modelo NO sabe

- **Quién juega de quarterback.** Es el equivalente al lanzador abridor del béisbol y
  probablemente la mayor omisión del modelo: un cambio de titular mueve una línea de la
  NFL más que casi cualquier otra cosa. El dato está en el fichero (`home_qb_name`), así
  que es la siguiente pieza natural.
- Las bajas de la semana, que se publican en el parte oficial de los miércoles.
- El viento y el frío, que hunden los totales en campos abiertos en diciembre.
- Si el partido importa: un equipo ya clasificado en la semana 18 no juega igual.
