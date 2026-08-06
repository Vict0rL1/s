# ⚾ Cómo funciona el modelo de béisbol

El cuarto deporte, y el que menos se parece a los otros tres. Dos hechos mandan
sobre todo lo demás:

1. **El lanzador abridor.** En ningún otro deporte un solo jugador que ni siquiera
   está en el campo la mayor parte del partido pesa tanto. Un buen equipo con su
   quinto abridor y un equipo mediocre con su as están prácticamente igualados. Y
   lo mejor: **se anuncia el día antes**, así que a diferencia de una alineación de
   fútbol es información que el modelo *puede tener*.

2. **El béisbol es el deporte más igualado.** El mejor equipo de la liga pierde
   unos 60 partidos al año. Eso significa que el margen de mejora sobre «elige al
   local» es de dos o tres puntos, y que el acierto es casi inútil como medida:
   lo que se puede juzgar es si la **probabilidad** está bien puesta.

Código: `server/src/baseball/`.

---

## 1. Una sola distribución, todos los mercados

```
Elo + ventaja de campo + duelo de abridores  →  carreras esperadas de cada equipo
                                             →  distribución binomial negativa
                                             →  ganador, total, línea de carreras,
                                                marcador exacto, diferencia
```

Igual que en fútbol, que **todo** salga de la misma rejilla hace imposible que las
cifras se contradigan entre sí.

### Las carreras NO siguen una Poisson

Los goles del fútbol se parecen bastante a una Poisson; las carreras no, y el
motivo es estructural: **una entrada no acaba por reloj, acaba con tres outs**, así
que un *rally* no tiene tope natural y las entradas grandes se agrupan.

Medido sobre los datos de este repositorio: media 4,47 carreras por equipo,
**varianza 9,49**. Una Poisson obliga a que varianza = media, así que subestima a
la vez las blanqueadas y las palizas — justo las dos colas donde vive el mercado
de totales. Una binomial negativa lo arregla con un parámetro, y el óptimo
empírico (`r = μ²/(σ²−μ) = 3,98`) coincide con el que elige el backtest.

**Lo que cuesta ignorarlo**, sobre los mismos 36.235 partidos:

| | Brier | over/under 8.5 | Brier de la línea |
|---|---|---|---|
| Binomial negativa (r = 4,5) | **0.24307** | **53.4%** | **0.22670** |
| Poisson | 0.24507 | 52.1% | 0.22828 |

### La diagonal no existe

Un marcador **final** de béisbol nunca queda empatado: de los 37.262 partidos de
la base, exactamente 3 lo están, y los tres se suspendieron. Pero tratar a los dos
equipos como independientes pone ~10% de la probabilidad en la diagonal.

Eso no es un resultado: es la probabilidad de irse a **entradas extra**, y las
entradas extra terminan con alguien una carrera por delante. Así que cada casilla
(k,k) se reparte entre (k+1,k) y (k,k+1) con la ventaja del local en extras (0,53).
Se hace en la propia distribución, no en la probabilidad de victoria, para que el
total, la línea y los márgenes lo hereden y no puedan discrepar.

Es el problema espejo del fútbol: allí el empate es un resultado y hay que
modelarlo; aquí es un estado intermedio y hay que resolverlo.

---

## 2. El abridor

Cada abridor lleva una **razón de supresión de carreras**: las carreras que su
equipo permitió en sus aperturas, dividido entre las que el modelo esperaba que
permitiera **con un abridor medio en ese mismo enfrentamiento**. Por debajo de 1 es
mejor que la media.

Medirlo como razón y no como tasa bruta lo deja **ajustado por rival gratis**: a un
lanzador que pasó abril contra los tres mejores ataques de la liga no se le
penaliza, porque el denominador ya sabía que eran buenos.

Tres decisiones que importan:

- **Se regresa fuerte** (15 aperturas para media confianza). Un lanzador con tres
  aperturas y una carrera permitida no es un as: es un lanzador medio que ha
  tenido un buen mes. El backtest es tajante — la mejora sigue creciendo hasta las
  25 aperturas.
- **Solo el 55% llega al marcador.** Un abridor moderno lanza unas 5⅓ de nueve
  entradas, así que aunque no permita nada solo controla ~60% de lo que encaja su
  equipo; el resto es del bullpen, que este modelo no valora por separado. Que el
  peso ajustado caiga cerca de 0,55 —casi exactamente la cuota de entradas que
  lanza un abridor— es buena señal de que mide lo que dice medir.
- **Su historial sobrevive al invierno** (0,85, más que el 0,7 de los equipos). Un
  lanzador *es* un brazo; una plantilla renueva un cuarto de sí misma.

### Un error que costó 2,25 carreras por partido

La primera versión calculaba «carreras por 9 entradas» suponiendo una carga
nominal de 5⅓ entradas por apertura. Pero al abridor se le cargan las carreras de
**todo el partido**, así que dividir eso entre 5⅓ entradas hacía que *todos* los
lanzadores parecieran desastres de 7,4 RA9, con el factor pegado a su tope
superior, y el total de carreras predicho salía **2,25 carreras por partido por
encima** de la realidad.

No lo habría detectado ninguna medida de acierto: el ganador apenas se movía. Lo
delató el **sesgo del total**, que por eso lo imprime el backtest.

### Lo que aporta, medido

| | Brier | acierto | error del total | sesgo | over/under |
|---|---|---|---|---|---|
| **Con abridor** | **0.24307** | **56.8%** | **3.499** | −0.045 | **53.4%** |
| Sin abridor | 0.24340 | 56.5% | 3.518 | +0.045 | 52.2% |

Modesto en el ganador y claro en las carreras — que es exactamente lo que cabe
esperar de un dato bueno medido con un instrumento ruidoso (las carreras del
bullpen están dentro y no hay forma de separarlas con esta fuente).

En la aplicación el abridor es además **editable**: si sabes quién lanza, o si lo
han cambiado, lo eliges y se recalcula la distribución entera.

---

## 3. El estadio

Coors Field y Petco Park no son el mismo deporte. Durante mucho tiempo esta era
la mayor omisión declarada del modelo — y el dato **ya estaba descargado**: la
columna `site` de `bsb_games` nombra el estadio de los 37.262 partidos del archivo
y nadie la leía. La misma forma que el hallazgo del quarterback en la NFL.

### Cómo se mide

Un factor de estadio **no es** «carreras que se anotan aquí»: eso mezcla el parque
con los equipos que juegan en él. Es carreras anotadas aquí **divididas por las que
el modelo esperaba** en esos mismos partidos, y luego relativas a un parque medio.

El resultado recupera por sí solo la jerarquía que cualquier aficionado conoce, lo
cual es la mejor señal de que mide el estadio y no ruido:

| Estadio | Factor | |
|---|---|---|
| Coors Field (Denver, 1.580 m) | **×1.220** | +22 % |
| Globe Life Field | ×1.115 | |
| Fenway Park | ×1.094 | |
| … | | |
| Oracle Park | ×0.923 | |
| Petco Park | ×0.919 | |
| T-Mobile Park | **×0.917** | −8 % |

**2,89 carreras entre los extremos**, sobre un total de ~8,9 — y la línea de
over/under se mueve de media en media carrera.

Cada factor se **encoge hacia 1 según los partidos** que tenga (`n / (n + 300)`),
así que un parque con tres series raras no llega al modelo diciendo +40 %. Y se lee
del calendario, no de una configuración: un club que cambia de estadio se sigue
solo.

### Que transfiera es otra pregunta

Los parques cambian (Coros puso un humidor en 2002, Arlington un techo en 2020), así
que grande *dentro* de la muestra no basta. Ajustado con las temporadas anteriores a
un corte y puntuado en las siguientes, **seis cortes de 2014 a 2024, los seis
mejoran**:

| Corte | Entreno | Test | MAE total base | con parque | Δlog-lik/partido |
|---|---|---|---|---|---|
| 2014 | 9.720 | 27.542 | 3.5240 | 3.5033 | +0.00831 |
| 2016 | 14.579 | 22.683 | 3.5601 | 3.5399 | +0.00800 |
| 2018 | 19.437 | 17.825 | 3.5698 | 3.5495 | +0.00756 |
| 2020 | 24.297 | 12.965 | 3.5415 | 3.5196 | +0.00680 |
| 2022 | 27.624 | 9.638 | 3.5370 | 3.5195 | +0.00619 |
| 2024 | 32.484 | 4.778 | 3.5192 | 3.5089 | +0.00465 |

En el backtest completo, sobre los 36.235 partidos: **el over/under acertado pasa
de 53,4 % a 54,9 %** y el MAE del total de 3,50 a 3,47. El Brier del ganador **no se
mueve** (0.2431), que es exactamente lo que debe pasar: el parque escala los dos
lados por igual, así que cambia el total y no quién gana.

### Dónde vive la mejora

No está repartida, y decirlo así es más honesto que un promedio:

| Tramo | n | Δlog-lik/partido |
|---|---|---|
| Parques extremos altos (>1.06) | 1.950 | **+0.05228** |
| Algo altos (1.02–1.06) | 3.505 | −0.00309 |
| Neutros (0.98–1.02) | 4.793 | +0.00019 |
| Algo bajos (0.94–0.98) | 4.681 | +0.00168 |
| Extremos bajos (<0.94) | 2.896 | +0.01205 |

Siete veces la media en los parques extremos y **nada** en los neutros. El modelo no
se volvió más listo en general: **dejó de equivocarse en Denver**. Un factor de
estadio correcto tiene que parecerse justo a esto.

Reproducible: `npm run backtest:bsb` lo incluye, `npm run backtest:bsb -- --park
false` lo apaga.

---

## 4. Resultados medidos

Backtest *walk-forward* sobre **36.235 partidos reales de MLB** (2010–2025). El
backtest conduce el mismo `replayGames` que usa la app y **lee de él la λ** en vez
de recalcularla, así que no puede divergir del modelo ni por accidente.

| Métrica | Valor | Referencia |
|---|---|---|
| **Brier** | **0.2431** | 0.25 = tirar una moneda |
| **Log loss** | **0.6791** | 0.6931 = decir siempre 50% |
| Acierto | 56.8% | elegir siempre al local ≈ 54% |
| Error absoluto del total | 3.50 carreras | — |
| Sesgo del total | −0.05 carreras | 0 = ni alto ni bajo |
| Over/under 8.5 | 53.4% | — |

### Calibración

Es donde se ve que el modelo está bien puesto. Cada banda, con miles de partidos:

| El modelo dice… | …gana el local | Error |
|---|---|---|
| 42.9% | 42.9% | +0.1 pp |
| 47.7% | 48.1% | +0.4 pp |
| 52.5% | 52.4% | −0.2 pp |
| 57.3% | 57.4% | +0.0 pp |
| 62.2% | 62.1% | −0.1 pp |
| 67.0% | 67.1% | +0.1 pp |

### Ablaciones

```bash
npm run backtest:bsb                      # con los parámetros de la app
npm run backtest:bsb -- --pitcher 0       # sin abridor
npm run backtest:bsb -- --dispersion 1e9  # Poisson pura
npm run backtest:bsb -- --home 0          # sin ventaja de campo
npm run backtest:bsb -- --k 9             # otro K
```

| Quitando… | Brier | acierto |
|---|---|---|
| nada (modelo completo) | **0.24307** | 56.8% |
| el abridor | 0.24340 | 56.5% |
| la ventaja de campo | 0.24361 | 56.3% |
| la binomial negativa (Poisson) | 0.24507 | 56.7% |

La ventaja de campo del béisbol es **la más pequeña del deporte de equipo**: 24
puntos de Elo, contra los 65 del fútbol y los 100 del baloncesto. Un modelo que
copiara la constante del baloncesto se equivocaría por un factor de cuatro.

---

## 5. De dónde salen los datos

| Para qué | Fuente | Notas |
|---|---|---|
| Histórico partido a partido **con abridores** | [Retrosheet](https://www.retrosheet.org) vía [chadwickbureau/retrosheet](https://github.com/chadwickbureau/retrosheet) (GitHub) | Un fichero por equipo y temporada con sus partidos **como local**, así que 30 ficheros cubren una temporada exactamente una vez. Es con lo que se **ajustó y validó** el modelo: 37.262 partidos de 2010 a 2025. |
| Temporada **en curso** | [MLB Stats API](https://statsapi.mlb.com) | Retrosheet publica *después* de que acabe la temporada, así que por sí solo dejaría los Elo permanentemente un año atrasados. Gratis y sin clave. |
| Abridores anunciados | MLB Stats API (`hydrate=probablePitcher`) | Lo que hace que una predicción del mismo día valga algo. |
| Partidos próximos + cuotas | [The Odds API](https://the-odds-api.com) | La misma clave que los otros tres deportes. |

### El contador de carreras, y por qué se verifica

Los ficheros de eventos de Retrosheet traen **todas las jugadas** pero **no el
marcador final**: hay que contarlo. Un contador que acierte el 99% no sirve — un
error sistemático de una carrera en el 1% de los partidos desplaza todos los
totales del modelo.

Así que se comprueba en vez de suponerse. Retrosheet publica además *game logs*
con los marcadores oficiales; comparar las dos cosas partido a partido da:

```
$ npm run verify:bsb

  partidos comparados:  2426
  marcador exacto:      2426  (100.00%)
  abridores correctos:  2426  (100.00%)
```

Llegar ahí necesitó dos reglas fáciles de pasar por alto, que cuestan **exactamente
una carrera** cada vez:

- **`SBH`** — robo de home. La carrera es implícita: no hay notación de avance que
  leer, así que un parser que solo mire los avances la pierde en silencio.
- **`nXH(...E...)`** — un corredor marcado como **eliminado** en home que en
  realidad **anotó**, porque la secuencia entre paréntesis contiene un error.
  `3XH(842)` es un out limpio; `3XH(3E2)` es carrera.

Antes de esas dos, el parser acertaba el **99,05%** — que en un resumen parece
perfecto y estaba mal en 26 partidos.

Es un comando y no una frase en un documento a propósito: una afirmación que no se
puede volver a ejecutar no es evidencia, y el día que cambie el formato de origen
esto es lo que avisará.

**Aviso de verificación:** el entorno donde se desarrolló esto solo alcanza GitHub,
así que MLB Stats API (temporada en curso y abridores anunciados) está escrito a
la defensiva —falla diciendo qué campo faltaba, nunca ingiere ceros— pero no se ha
podido probar contra el servidor real. Retrosheet, que es donde se apoya todo lo
demás, sí es real y está validado partido a partido.

---

## 6. Ligas

Solo la **MLB** tiene un archivo abierto partido a partido, y menos aún uno que
incluya el abridor de cada encuentro. NPB, KBO y el universitario aparecen con sus
partidos y las probabilidades **del mercado**, dicho claramente en la interfaz, en
vez de inventar una predicción. «No hay datos» y «no hay ventaja» no son lo mismo.

---

## 7. Limitaciones

- **No conoce el bullpen.** Es la mayor. Un abridor controla ~60% de las carreras
  que encaja su equipo; el otro 40% lo deciden relevistas que este modelo no
  valora por separado, y esa es la principal razón de que el peso del abridor sea
  0,55 y no 1.
- **No conoce la alineación**, ni si el mejor bateador descansa hoy.
- No conoce el clima, que en béisbol mueve los totales de verdad.
- **Retrosheet va una temporada por detrás**, así que sin la MLB Stats API los Elo
  describen el año pasado. La app avisa en la cabecera cuando eso pasa.
- Los Elo de una liga **no son comparables** con los de otra.
