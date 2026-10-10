# Arquitectura y diseño

Cómo está montada la app (dos procesos, dos ficheros de base, siete deportes en pestañas) y las decisiones de pantalla que se tomaron por un motivo. El árbol de abajo se genera del repo real con `node scripts/estructura.mjs`.

## Estructura del proyecto

```
config/        tours.json + tournaments.json + basketball.json + football.json
data/          SQLite + datos crudos + dataset seed
docs/          MODEL.md (tenis) · BASKETBALL.md · FOOTBALL.md · BASEBALL.md · NFL.md
server/
  src/            tenis: ingesta, modelo Elo, API
  src/basketball/ baloncesto: ingesta, modelo, backtest, track record propios
  src/football/   fútbol: ingesta, modelo Poisson, backtest con RPS, track record
  src/nfl/        fútbol americano: ingesta nflverse, números clave, backtest vs mercado
web/
  src/components/            tenis
  src/components/basketball/ baloncesto
  src/components/football/   fútbol (con sub-pestañas por liga)
  src/components/nfl/        fútbol americano
```

Los siete deportes están separados a propósito en todas las capas —tablas, modelo, endpoints y
pestaña— porque discrepan justo en los campos que un modelo necesita: el tenis tiene superficie y no
tiene campo propio; el baloncesto tiene cancha y margen de puntos; el fútbol tiene **empate** y
mercados de goles; el béisbol tiene **abridor**; y el fútbol americano tiene un margen que se
amontona en el 3 y el 7 en vez de seguir una curva. El razonamiento está en [docs/BASKETBALL.md](docs/BASKETBALL.md) y
[docs/FOOTBALL.md](docs/FOOTBALL.md).

## Cómo funciona el modelo

Fútbol: **[docs/FOOTBALL.md](docs/FOOTBALL.md)** · Béisbol: **[docs/BASEBALL.md](docs/BASEBALL.md)** · Fútbol americano: **[docs/NFL.md](docs/NFL.md)** · Baloncesto: **[docs/BASKETBALL.md](docs/BASKETBALL.md)** ·
Tenis: **[docs/MODEL.md](docs/MODEL.md)** para la explicación completa del cálculo del Elo, cómo
se combinan las señales y las limitaciones. La lógica también está comentada en el código
(`server/src/model/`).

## Diseño

Los cinco deportes comparten un solo lenguaje visual (`web/src/lib/theme.ts` y
`web/src/components/ui/`), con una regla que importa: **los colores de datos son compartidos y están
validados; la identidad de cada deporte es solo cromo** (la línea bajo la pestaña activa).

Antes cada deporte había inventado su paleta, y la del fútbol estaba medida-mente rota: el azul del
visitante y el gris del empate quedaban a ΔE 11.6 en visión normal, por debajo del suelo de 15 — las
dos barras que más falta hace distinguir eran difíciles de distinguir incluso con visión de color
completa. La paleta actual (azul local · turquesa empate · naranja visitante) pasa **todos** los
pares en la superficie oscura de la app: separación CVD ΔE 9.4, visión normal 20.9, contraste ≥3:1.
Local es azul y visitante naranja en los cinco deportes, así que el color significa lo mismo al
cambiar de pestaña.

Sobre esa base hay otras tres reglas, todas dirigidas a que la app se lea como una herramienta y no
como un tablero de colores:

**Un número nunca se pinta con el color de una serie.** Las cifras van en tinta; un punto de 6 px
delante de la etiqueta dice de quién son. La tarjeta llegaba a tener el nombre del equipo en azul
saturado, el 47.7 % en azul saturado y el segmento de la barra en azul saturado: tres marcas
repitiendo un dato que la barra ya deja obvio, y un porcentaje más difícil de leer que en blanco. El
color marca **quién**; la tinta dice **qué**.

**Una sola caja y un solo radio.** La tarjeta era una caja con borde, brillo interior y sombra, que
contenía paneles que eran cajas, que contenían casillas que eran cajas — tres rectángulos anidados
alrededor de unas cifras que una línea fina y algo de espacio agrupan igual de bien. Ahora la
tarjeta es la única caja rellena: dentro, las secciones se separan con filetes y aire.

**Gris de verdad, no gris azulado.** El texto usaba `slate` de Tailwind, que tiene tinte azul: sobre
un fondo azul-negro y con una serie azul, eso metía un tercer azul débil compitiendo con los dos que
sí significan algo. La rampa de texto es neutra y el paso de las etiquetas (`#7b828d`) está subido
para llegar a 4.7:1 sobre la tarjeta, por encima del mínimo AA para texto pequeño; antes estaba en
3.4:1 y no lo cumplía.

Las cinco pestañas comparten además un único tratamiento para las sub-pestañas (liga, circuito,
torneo): había cuatro distintos, incluida una fila de subrayados justo debajo de la fila de
subrayados de la app. Cada una lleva la bandera de su país, que los ficheros de configuración ya
tenían.

**Los escudos de equipo son la excepción a la paleta, y solo esa.** Cada equipo aparece con un disco
en sus colores oficiales y su monograma: azul marino y verde para Seattle, granate y oro para los
Cardinals, rojo para el Liverpool. Es el único sitio donde entra el color de un club — las barras,
la rejilla y las bandas siguen con la paleta compartida, así que **el azul sigue siendo el local en
los cinco deportes** juegue de lo que juegue cada equipo. Sin esa regla, un Seahawks–Chiefs tendría
cuatro colores saturados peleándose con los dos que llevan el pronóstico.

Los colores salen de [`jimniels/teamcolors`](https://github.com/jimniels/teamcolors) y solo se usan
las ligas que se pudieron comprobar: NFL 32/32, MLB 32/32, NBA 28/45 (los 17 que faltan son
franquicias desaparecidas en los años 40) y Premier League 20/20. **Lo que no se sabe se pinta en
gris**, no en un color inventado: suponer que el Real Madrid es morado sería inventar información, y
eso no se hace en ninguna otra parte de la app. Cuando la base de datos tiene un escudo real —el
baloncesto los descarga— se superpone al disco, y si la imagen falla desaparece sola en vez de dejar
el icono de imagen rota.

## La navegación y la cabecera

**Los deportes están a la izquierda** desde 1024 px, en un rail de 15 rem, y arriba por debajo de esa
anchura. Es la mejor forma para seis elementos en pantalla ancha: las etiquetas se leen enteras en vez
de pelearse por una tira horizontal, y todo el ancho de la página queda para el contenido. En un móvil
de 390 px un rail se comería un tercio de la pantalla, así que ahí vuelve a ser una fila.

Es **una sola lista en dos orientaciones**, no dos listas (`SportNav`): los mismos siete deportes, el
mismo orden, el mismo color de acento marcando el activo, la misma semántica `role="tab"`. Dos copias
se desincronizarían la primera vez que se añada un deporte.

Un efecto secundario que salió gratis: el offset `--header-h` que usan las cabeceras de día pegajosas
está **medido**, no fijado. Por encima de 1024 px la barra de arriba es `display: none`, así que su
altura medida es 0 — y 0 es exactamente el offset correcto ahí, porque ya no hay nada encima del
contenido. Un valor fijo habría dejado un hueco del tamaño de una cabecera que no está en pantalla.

### La cabecera, plegada

Cada pestaña abría con un muro de texto antes de una sola predicción: un párrafo explicando el
modelo, una línea de origen de datos, otra de cuotas, un aviso de datos viejos de dos frases y el
panel de aciertos. Todo cierto, todo leído una vez, y todo entre el lector y aquello para lo que
abrió la app. En un portátil era casi la primera pantalla entera.

Ahora se pliega —y arranca plegada— dejando arriba **los controles y los datos**:

```
[↻ Actualizar]  37.262 partidos · 32 equipos  [⚠️ datos de sept 2025]        Detalles ▼
```

**El aviso sobrevive al plegado a propósito.** El párrafo largo de datos viejos es la única parte de
ese bloque que cambia lo que hay que *hacer*: dice que esos números describen a los equipos de la
temporada pasada. Esconderlo en silencio dejaría la app engañando sin decirlo, que es justo el fallo
que ese aviso existe para evitar. Así que el párrafo se pliega y una versión de cuatro palabras no.
Nada importante desaparece; solo deja de ser un párrafo.

La elección de abierto/cerrado se recuerda, y se recuerda **una vez para todos los deportes**: es una
preferencia sobre cuánto adorno quieres, no un hecho sobre el béisbol.

---

## El ancho de la página

La app usaba `max-w-3xl` — **768 px** —, que en un portátil es menos de la mitad de la ventana: se
veía como una captura de móvil pegada en el centro del navegador. 768 px es la medida correcta para
una **columna de texto**; es la medida equivocada para una página cuyo contenido son tarjetas,
rejillas de marcadores y tablas de clasificación.

Ahora son **1280 px**, y —esto es lo importante— **las tarjetas van a dos columnas** desde esa
anchura. Ensanchar sin más habría sido peor que el bug: una tarjeta de 1280 px pone el «23,7 %» y el
«76,3 %» en extremos opuestos del monitor con un palmo de nada en medio. El espacio extra tiene que
comprar una segunda columna, no una más larga.

| Ventana | Navegación | Contenido | |
|---|---|---|---|
| 1920 px | rail izquierdo | 1280 px | dos columnas de tarjetas |
| 1280 px | rail izquierdo | 1040 px | dos columnas |
| 1023 px | fila arriba | 1023 px | una columna |
| 768 px | fila arriba | 768 px | una columna |
| 390 px | fila arriba | 390 px | una columna |

Verificado en las cinco, pestaña por pestaña: **cero desbordamiento horizontal**. El paso a rejilla trajo un bug propio
que hubo que arreglar —una pista de CSS grid es `minmax(auto, 1fr)` por defecto, y ese `auto`
significa «al menos lo más ancho que no pueda encogerse», así que una sola etiqueta con
`whitespace-nowrap` dentro de una tarjeta empujaba la pista fuera de la pantalla: 5 px de scroll
horizontal en un móvil de 390 px.

---

## Repaso visual: cuatro cosas que estorbaban

Medido en el navegador antes y después, no a ojo.

### El muro ámbar encima de cada deporte

El aviso del panel de sugerencias es de lo más valioso de la app —dice contra qué se ha
medido el modelo, con cuántos partidos y qué **no** demuestra— y estaba en un solo párrafo
de hasta doce líneas, en ámbar, antes de cualquier dato. En fútbol ocupaba media pantalla.
El resultado práctico de un muro de texto es que se salta entero: el formato conseguía lo
contrario de lo que pretendía.

No se ha recortado ni una palabra. La **primera frase** queda a la vista, porque lleva el
veredicto («este modelo NO le gana a la línea de cierre»), y el resto se despliega con *Ver
contra qué se ha medido*. Comprobado en los cinco deportes: fútbol recupera 1.513
caracteres al abrirlo, la NFL 520.

El corte busca la primera frase **completa** —punto seguido de espacio y mayúscula— y no un
número de caracteres: partir por la mitad produce un resumen que miente por omisión, y
además dejaría cortadas cifras como `0.2115`.

### Una diferencia de cero, pintada de rojo

La tabla de sugerencias de la NFL enseñaba filas con **`-0.0 pp` en rojo**. El modelo y el
precio coincidían hasta la décima, que es justo lo contrario de lo que el color grita. Por
debajo de media décima, ahora es `0,0 pp` en tinta neutra.

### La comparación modelo/mercado había que leerla

Dos barras apiladas idénticas: para saber si el modelo se aparta del mercado había que leer
«72,7 %» arriba, «75,8 %» abajo y restar. El dato que la tarjeta existe para dar —¿discrepan?—
era el único que no se veía.

Ahora el corte del mercado se dibuja **sobre** la barra del modelo, así que **la distancia
es la discrepancia**, con la cifra al lado («mercado, a 3.1 pp»). Cuando coinciden, lo dice.

### 700 píxeles de selector antes del primer partido

En un teléfono de 390 px, las 17 ligas del fútbol con `flex-wrap` producían **nueve filas
de pastillas**: más de una pantalla entera de selector antes de llegar a un partido. El
selector era el contenido.

| | antes | después |
| --- | --- | --- |
| alto del selector en móvil | ~700 px | **37 px** |
| en escritorio | 74 px | 74 px (sin cambios) |

Una sola fila que se desliza en horizontal por debajo de `sm`, y el `flex-wrap` de siempre
a partir de ahí, donde caben en dos filas y verlas todas de golpe sí ayuda a elegir.

### Y los nueve motivos de cada tarjeta

El modelo produce hasta nueve motivos por partido y se pintaban todos iguales, uno detrás
de otro. Con dos tarjetas por fila son dieciocho líneas de prosa a la misma altura, y
encontrar la que mueve la predicción cuesta leerlas todas. El generador **ya los devuelve
ordenados por importancia** y esa información se tiraba al pintarlos idénticos.

Ahora se ven los cuatro primeros y el resto se despliega con el número al lado («Ver 4
motivos más»). Cuatro y no tres: las tres primeras son casi siempre Elo, historial y forma
—el esqueleto de cualquier predicción— y la cuarta es la primera que distingue *este*
partido de otro.

## La clasificación por Elo salía plegada, y nadie la encontraba

Estaba montada al final de cada pestaña, detrás de un título gris que era un botón, y con
`defaultOpen = false`. El comentario del componente decía «plegada donde va al final de una
página larga; **abierta cuando es lo que el usuario vino a ver**» — y la segunda mitad no
se cableó nunca: ninguna de las cinco pestañas pasaba `defaultOpen`, así que estaba siempre
cerrada, debajo de ocho tarjetas de partido.

Una función que hay que descubrir no está entregada. Ahora **se abre sola**, y si la
cierras se queda cerrada: la elección se guarda en `localStorage` con una clave por
pestaña, porque cerrar la de la NFL no tiene por qué cerrar la del tenis.

## La clasificación por Elo, en las cinco pestañas

Cada deporte tiene su tabla de Elo, y las cinco usan el mismo componente
(`web/src/components/EloRanking.tsx`) en vez de cinco copias que se van separando solas.

### Tres cosas que hacen que sirva para analizar

* **La probabilidad.** Un `1650` no se puede interpretar, y la escala cambia por liga.
  La columna **«vs. medio»** dice la probabilidad de ganarle a un rival con el Elo
  mediano de esa lista — que es exactamente lo mismo que el Elo, porque el rating existe
  para producir ese número: `P = 1/(1 + 10^(−Δ/400))`. Los cinco deportes usan el mismo
  divisor 400, así que una conversión sirve para todos.
* **La barra.** El orden se ve en cualquier lista ordenada; los **huecos** no. Dos
  equipos separados por 200 puntos y dieciocho apretados en 40 es una liga distinta de
  una repartida por igual, y las dos producen la misma lista de nombres. La barra se
  ancla al rango de la lista, no a un cero absoluto: desde cero, un 1500 y un 1900 se
  ven casi iguales.
* **La fiabilidad.** Un Elo sobre 4 partidos y otro sobre 400 se imprimen igual. El de
  pocos se marca con `◦n`. Se marca, **no se oculta**: una fila que desaparece sin
  explicación es peor que una con una advertencia.

Y una línea arriba que resume la forma de la competición: *«el primero le ganaría al
último el 87 % de las veces»*. Cerca del 50 % es igualdad; por encima del 90 %, un
abismo.

### Tenis: la tabla que puede comparar a alguien consigo mismo

Es la única con **cuatro Elo por fila** — general, dura, tierra y hierba — así que el
selector de superficie **reordena de verdad**, no añade una columna. Ahí es donde se
contesta *«¿en cuál es mejor?»*.

La columna **«Mejor sup.»** compara al jugador *consigo mismo*: cuánto sube su Elo en su
mejor superficie respecto de su propio general. Un `+150` es un especialista claro; un
`+10`, alguien igual de bueno en todas.

### El retirado que salía cuarto del mundo

Un Elo se queda **congelado en el último partido**. Sin filtro, la lista de la ATP salía
así:

```
4. Roger Federer   2091   último partido: junio de 2021
8. Rafael Nadal    2020   último partido: noviembre de 2024
```

Los dos números son correctos y la lista es inútil: preguntada *«¿quién es mejor
ahora?»*, contesta con dos retirados. No es un dato erróneo — responde a otra pregunta,
*«quién llegó más alto»* — y mezclar las dos sin decirlo es cómo alguien acaba analizando
una superficie con un jugador que no la pisa desde hace cuatro años.

Así que por defecto se piden los **activos** (algún partido en dos años, 205 de 500 en
este archivo) y la lista histórica se puede pedir a propósito, con el botón «Histórico».
Un jugador **sin fecha conocida no se descarta**: «no lo sé» no es «hace mucho».

### Un defecto de los datos que solo se puede decir

`player_rankings` guarda el último snapshot **de cada jugador**, no el ranking completo
de un día. Esas fechas abarcan **4.031 días** en este archivo, así que la columna
«Oficial» mezcla el ranking de agosto de uno con el de enero de otro — y salen **tres
jugadores con «#5»**, que se lee como un fallo de la app.

Marcarlo fila a fila no sirve: comparando con la fecha más nueva, el **100 %** de las
filas sale «desfasada», y una marca que aparece en todas partes no informa de nada. Lo
que sí informa es el rango, así que la tabla advierte una vez que la columna no es una
foto de un día y cada celda lleva su fecha en el tooltip.

Arreglarlo de verdad es traer el ranking completo de una fecha **en la ingesta**, no
cambiar la consulta. Eso está dicho en el código y aquí, no disimulado.

---

## Fechas y horarios

Los partidos van **agrupados por día**, no en una lista corrida. Cada grupo lleva una cabecera que se
queda pegada arriba mientras lo recorres (`Hoy`, `Mañana`, `Ayer`, y para el resto la fecha larga —
`Domingo, 13 de septiembre`— sin el año cuando es el año en curso), con el número de partidos de ese
día al lado. Encima hay una fila de fichas, una por día con partidos, más `Todos`: pulsar una filtra
a ese día, volver a pulsarla quita el filtro. Con 24 partidos de NFL repartidos en ocho días, eso es
la diferencia entre buscar y mirar.

En cada tarjeta ya no aparece la fecha completa repetida: basta **la hora** (`20:20`) y a cuánto está
(`en 36 días`, `en 11 h`), porque el día ya lo dice la cabecera del grupo.

Los días se cortan **en tu zona horaria**, no en UTC. Agrupar en UTC habría mandado los partidos de
noche al día siguiente: un partido a las 22:00 en Madrid es 20:00 UTC el mismo día, pero uno a las
01:30 es 23:30 UTC del día anterior, y habría aparecido bajo la cabecera equivocada.

### El fallo de la hora de la NFL

El calendario de la NFL publica el saque inicial como fecha y hora locales del este de Estados
Unidos. Convertirlo estaba escrito como ``new Date(`${día}T${hora}:00-05:00`)`` — que es hora
**estándar** del este, y la temporada de la NFL va de septiembre a febrero, así que casi todo el
arranque cae en horario de **verano** (-04:00). **Todos los partidos desde la jornada 1 hasta
noviembre se guardaban una hora tarde**: la tarjeta decía que un jueves por la noche empezaba a las
21:20 cuando empieza a las 20:20.

Un desplazamiento fijo está mal para cualquier ciudad con cambio de hora, y el signo del error se
invierte dos veces al año. `server/src/timezone.ts` lo resuelve consultando el desplazamiento **de esa
fecha concreta** en la base de datos de zonas horarias de la propia plataforma (`Intl`, sin
dependencias), en dos pasadas: el desplazamiento depende del instante y el instante depende del
desplazamiento, así que se estima con la lectura ingenua y se vuelve a comprobar en el instante
corregido. Verificado en cuatro fechas, incluido el domingo del cambio de hora.

### Los partidos de hoy duran todo el día, y traen su resultado

Antes un partido desaparecía **6 horas después de empezar**, así que uno de las 11:00 ya no estaba a
las 17:00 — justo la tarde en la que querías ver cómo acabó. Lo que uno entiende por «los partidos de
hoy» es el **día del calendario**, no una ventana rodante.

El corte es ahora **el más antiguo de dos límites**, así que conserva lo que cualquiera de los dos
conservaría:

- **las 00:00 de hoy, en hora local** — todo lo de hoy aguanta hasta medianoche y desaparece ahí;
- **hace 6 horas** — para que un partido que empezó a las 23:30 siga ahí a la 01:00 mientras se
  juega, en vez de cortarse a medianoche en mitad del partido.

| Son las… | Corte | Un partido de hoy a las 11:00 |
|---|---|---|
| 15:00 | hoy 00:00 | **sigue** |
| 23:00 | hoy 00:00 | **sigue** |
| mañana 01:00 | ayer 19:00 | ya no |
| mañana 09:00 | mañana 00:00 | ya no |

Y en cuanto acaba, **la tarjeta muestra el resultado**: el marcador final arriba, en grande, con
«✓ el modelo acertó» o «✕ el modelo falló». Tres estados, y confundir dos cualesquiera sería mentir:

- **terminado con marcador** → se muestra, y si el modelo lo clavó;
- **empezado y sin marcador** → «En juego, o el resultado aún no está descargado». Los resultados
  llegan con `update-data`, así que esto es normal un rato y **no** es el modelo fallando;
- **sin empezar** → no se muestra nada; el pronóstico es el contenido.

En fútbol la comparación es a tres bandas (el empate es un resultado de verdad, no la ausencia de
uno) y en tenis el resultado es un nombre y el marcador por sets, porque el archivo guarda un ganador
y no dos marcadores.

El emparejamiento «este partido programado ↔ aquel partido del archivo» es **el mismo que ya usaban
los cinco puntuadores** de predicciones, no una segunda implementación: si fueran dos, la tarjeta y el
panel de aciertos podrían discrepar sobre si el mismo partido ya terminó.

`npm run audit` comprueba la coherencia de todos los números —**1325 comprobaciones**, todas verdes—
y que ninguna fecha caiga más allá de 400 días.

### La escala tipográfica

La app tenía **doce tamaños de letra distintos** y 222 usos a 12 px o menos, incluido uno a 9 px.
Eso son dos problemas a la vez: cuesta leerla, y doce niveles no son una jerarquía sino la
ausencia de una.

Ahora son **ocho niveles y todos más grandes**: 11 · 13 · 14 · 15 · 16 · 17 · 20 · 26 px. El
cuerpo pasó de 12 a 14 px (+17 %) y las etiquetas de 10-11 a 13. El texto más pequeño que se
lee en cualquier pestaña es de 11 px, comprobado en el navegador.

Tres cosas se rompieron al agrandar, y las tres están arregladas:

- **Las cabeceras pegajosas de cada día** iban a un `top` de 86 px escrito a mano, que era la
  altura de la cabecera *antes*. Un número que describe el tamaño de otro elemento está mal en
  cuanto ese elemento cambia, así que ahora la cabecera publica su altura real y las fechas se
  cuelgan de ella. Se comprueba sola: mide 95 px en móvil y 100 px en escritorio.
- **Las cinco pestañas ya no cabían** en un móvil. Los emojis y el subtítulo aparecen a partir de
  640 px de ancho; por debajo manda la palabra, que es lo que identifica al deporte. Verificado
  a 360, 390, 412, 640 y 900 px.
- **Los nombres se cortaban**: «New Engl…», «Manchester United F…», «Madison Bumga…». Había 35
  textos recortados. Los nombres de equipo y de jugador ahora se parten en dos líneas en vez de
  perder letras — dos líneas cortas no cuestan nada, unos puntos suspensivos se comen justo el
  dato por el que existe la tarjeta. **Cero textos recortados** en las cinco pestañas.

## Los partidos de hoy se quedan hasta medianoche (arreglado)

Un partido jugado por la mañana desaparecía por la tarde, y el filtro que debía conservarlo estaba
bien: la causa era que **la fila ya no existía**.

Cada refresco de cuotas hacía un `DELETE FROM …_upcoming` sin condiciones y reinsertaba lo que
devolvía la fuente. Una fuente de partidos *próximos* nunca devuelve uno que ya empezó, así que el
partido de la mañana se borraba de la base — y el refresco corre al arrancar el servidor. Toda la
función de «los partidos de hoy se quedan» estaba filtrando una fila que ya no estaba.

El borrado ahora tiene tres partes:

| | |
|---|---|
| Partidos **futuros** | se borran: el refresco los va a reinsertar con cuotas frescas |
| Anteriores a la ventana | se borran: nadie los va a mirar y son lo que hacía crecer la tabla sin fin |
| **Todo lo demás** | **se queda**: ya empezaron pero son de hoy, y son justo los que quieres ver el resultado |

Estaba en los cinco deportes, y la NFL además tenía una segunda copia del error: su calendario
filtraba con una ventana propia de cuatro horas en vez de la de la app, y la más estrecha ganaba en
silencio. Ahora las dos usan la misma regla.

Verificado plantando un partido ya empezado en cada uno de los cinco y corriendo el refresco: los
cinco sobreviven, y una fila de 2020 sigue limpiándose. El audit tiene una comprobación nueva para
que no vuelva.

---

## «Solo me salen dos partidos»

La cabecera dice 58.367 partidos y la lista enseña dos. Son dos cosas distintas y la
pantalla no lo decía:

- El **archivo histórico** es nuestro y está completo.
- Los **próximos** los publican las casas de apuestas, con pocos días de antelación y solo
  cuando les ponen precio.

Así que dos partidos suele ser lo correcto. A mitad de un Grand Slam hay un único torneo
activo y en las rondas finales le quedan dos o cuatro. Sin decirlo, se lee como que la app
no cargó, y la reacción natural es volver a actualizar — que **gasta cuota y devuelve los
mismos dos**. Ahora, cuando la lista baja de seis partidos, sale una línea que lo explica y
que distingue los dos casos: cuotas de demostración (falta la clave) o el calendario real
tal como está. Con seis o más no aparece, porque encima de treinta tarjetas sería relleno.

## Banderas: 318 jugadores las llevaban de otro país

La app pinta la bandera de cada jugador en la tarjeta del partido, en su perfil y en la
clasificación por Elo, y la de la sede de cada liga en las pastillas de las otras cuatro
pestañas. Antes eran emoji; ahora son SVG servidos desde `web/public/flags/`. El cambio no
es estético, o no solo:

**El problema.** El código que convertía el país en bandera tenía 28 países a mano y, para
el resto, cortaba las dos primeras letras del código del COI y las trataba como ISO-3166.
Funciona para `ESP`→`ES` y falla en silencio para una cuarta parte del circuito:

| código | daba | es | jugadores |
|--------|------|-----|-----------|
| `RSA` Sudáfrica | 🇷🇸 Serbia | 🇿🇦 | 14 |
| `CHI` Chile | 🇨🇭 Suiza | 🇨🇱 | 9 |
| `EST` Estonia | 🇪🇸 España | 🇪🇪 | 11 |
| `ESA` El Salvador | 🇪🇸 España | 🇸🇻 | 11 |
| `SLO` Eslovenia | 🇸🇱 Sierra Leona | 🇸🇮 | 14 |
| `UAE` Emiratos | 🇺🇦 Ucrania | 🇦🇪 | 1 |
| `PAK` Pakistán · `PAR` Paraguay | 🇵🇦 Panamá, los dos | 🇵🇰 🇵🇾 | 17 |
| … 35 países más | | | |

**318 de 1.272 jugadores, y ninguno salía en blanco.** Todos salían con una bandera
equivocada y segura de sí misma, que es peor que no poner ninguna: un hueco se lee como «no
lo sé» y una bandera se lee como «es de aquí». Y en Windows no se veía nada de eso, porque
Segoe UI Emoji no trae glifos de bandera y lo que aparecía eran las dos letras.

**Lo que hay ahora.** Una tabla completa en `config/countries.json` —el juego entero del
COI más los alias ISO-3 que el archivo mezcla (`PAR` y `PRY` son los dos Paraguay)— y
**ninguna heurística de respaldo**, porque la heurística de respaldo es exactamente lo que
produjo los 318. Un código que no está en la tabla no tiene bandera: sale una pastilla gris
con sus tres letras.

Los SVG (`lipis/flag-icons`, MIT, versión clavada) están **en el repo**, no enlazados a un
CDN. Tres razones: la app sigue funcionando sin internet como el resto de ella, un CDN que
se apague dentro de un año no haría saltar ningún check, y con los ficheros en disco
`verify:data` puede afirmar que todos los países de la base tienen su bandera — contra una
URL remota lo más que se puede comprobar es que la cadena está bien formada, y `RSA` →
`rs.svg` está perfectamente bien formada.

`verify:data` comprueba cuatro cosas (probadas inyectando cada fallo): que todos los
códigos de la base resuelven, que su SVG existe, que los 14 casos que el prefijo fallaba
apuntan a su país con el nombre escrito al lado, y que ningún ISO-2 tiene dos nombres de
país distintos. Hoy: **1.272 de 1.274 jugadores con bandera propia** (los 2 restantes
constan como `N/A` en el archivo).

## Sugerencias por deporte («lo que el modelo destacaría»)

Cada pestaña muestra una tarjeta por partido, que responde «¿qué pasa con este?». No respondía la
pregunta con la que uno llega de verdad: **de todos estos, ¿en cuáles dice el modelo algo raro?**
Averiguarlo obligaba a leerse veinte tarjetas.

Arriba de cada deporte hay ahora una tabla de hasta seis filas. Cada fila es un mercado concreto de
un partido concreto:

| Partido | Apuesta | Modelo | Mercado | Dif. | Cuota mínima | Devolvería |
|---|---|---|---|---|---|---|
| Chicago Cubs @ San Diego Padres | **Chicago Cubs +1.5** · línea de carreras | 63.4 % | — | — | 1.58 | busca ≥ 1.58 |
| Cleveland Guardians @ Boston Red Sox | **Over 8.5** · total de carreras | 56.5 % | — | — | 1.77 | busca ≥ 1.77 |

**La «cuota mínima» es el número que ninguna casa te muestra**: 1 ÷ probabilidad del modelo. Por
encima de esa cuota el modelo cree que el precio es generoso; por debajo, que es caro.

Los mercados son los que **cada modelo produce de verdad**: 1X2, doble oportunidad, over/under 2.5 y
ambos marcan en fútbol; ganador, total y línea ±1.5 en béisbol; ganador, hándicap y total en
baloncesto y NFL; ganador en tenis. Los córneres y los «gana cualquier mitad» **no están**, porque
esta app no tiene datos de córneres ni marcadores al descanso, y un número verosímil sin nada detrás
es lo peor que podría enseñar esta tabla.

Cuatro decisiones que hacen que la lista sirva:

1. **Se ordena por la diferencia con el mercado, no por la confianza del modelo.** «El favorito gana
   al 92 %» no es un hallazgo, es un precio. El único orden defendible es dónde el modelo y la casa
   **discrepan**, porque es el único sitio donde el modelo puede estar aportando algo.
2. **Una fila por partido y un tope por mercado.** Sin el tope la lista degeneraba: la doble
   oportunidad es P(1)+P(X), estructuralmente ~75 % en casi cualquier partido, así que llenaba las
   seis filas con seis números casi idénticos. El tope se calcula según cuántos mercados haya, para
   no castigar al tenis —que solo produce uno— dejándolo con dos filas y cuatro huecos.
3. **Las cuotas demo no cuentan como mercado.** Sin API key la app se inventa las cuotas *a partir
   de la probabilidad del propio modelo* más un margen. Quitarles el margen devuelve el número del
   modelo, así que la diferencia es cero por construcción: compararlas sería informar sobre su
   propia aritmética. Se tratan como «sin cuota» y el panel lo dice.
4. **Nunca sugiere un partido que ya empezó.** El calendario mantiene los partidos de hoy en
   pantalla a propósito, que está bien para ver un resultado y mal para proponer una apuesta.

Y el aviso va **encima** de la tabla, no en una nota al pie. En la pestaña de NFL ese aviso dice que
el modelo **no le gana a la línea de cierre** (50,6 % contra el hándicap, con el equilibrio en
52,4 %), que está medido y dice que no.

---

### La dirección de la app: 7373 (y por qué no 5173)

**La app vive en `http://localhost:7373`** y su API en el `7374`. Esa dirección es estable:
puedes guardarla en marcadores o en la pantalla de inicio del móvil y siempre será esta app.

Antes eran el 5173 y el 4000, y eso era el problema: el 5173 es el puerto **por defecto de
Vite**, así que lo quiere cualquier proyecto de Vite del ordenador, y el 4000 es el de la mitad
de las APIs de Node que existen. Con dos proyectos, `http://localhost:5173` era una app
distinta según lo que hubieras arrancado esa mañana — una dirección así no se puede guardar. El
7373/7374 no es el defecto de ninguna herramienta común, los dos números son contiguos para que
se recuerden juntos, y son solo de esta app.

Si además el puerto elegido estuviera ocupado, el backend moría con
`EADDRINUSE: address already in use 0.0.0.0:7374` **y el frontend cargaba igual**: una app
perfectamente pintada sin un solo dato, que es un fallo bastante más confuso que un error claro.
Así que `npm run dev` **elige los puertos antes de que nada se ate** y se los pasa a los dos
procesos. Ese orden es todo el asunto: si cada proceso eligiera el suyo, el proxy `/api` del
frontend apuntaría a un puerto donde el backend no acabó.

```
====================================================
  App        http://localhost:7373
  API        http://localhost:7374/api
  En el móvil  http://192.168.1.34:7373
====================================================
```

Con el 7373 ocupado por otro programa lo dice y se corre, sin que nadie edite un archivo de
configuración. Salta el 7375, que está reservado para `npm run preview`:

```
ℹ️  Puertos por defecto ocupados (¿otra app corriendo?), uso otros:
   API  7374 → 7376
   web  7373 → 7377
```

Verificado con otra app ocupando el 5173: esta arranca en el 7373/7374 y **no toca el 5173**.
Y con dos copias a la vez, cada una recibe **puertos distintos** y —matando la API de la
segunda— su web devuelve 500 mientras la primera sigue sirviendo: **cada proxy llega a su
propia API**, que es la propiedad que importa.

**Si lo que ocupa el puerto es otra copia de esta app, no se corre: se para.** Moverse ahí es
una trampa: la copia nueva acaba en el 7377, el marcador sigue diciendo 7373 y la página que se
abre es la otra (otra carpeta, otra versión, quizá sin la clave de cuotas). Pasó de verdad. La
reconoce por el `<title>` de la página o por la forma de `/ready` (`scripts/otra-copia.mjs`) y
dice cómo cerrarla:

```
❌ Ya hay otra copia de esta app abierta en http://localhost:7373.
   …
   Ciérrala con Ctrl+C en su terminal, o desde aquí:
     lsof -ti tcp:7373-7374 -sTCP:LISTEN | xargs kill
```

El `-sTCP:LISTEN` no es adorno: `lsof -ti :7373` a secas lista también a quien está
**conectado** al puerto —el navegador con la app abierta— y `xargs kill` lo cerraría con ella.
Las dos a la vez, a propósito: `npm run dev -- --junto` (se corre como con cualquier otro
programa).

Si quieres números concretos, `PORT` y `WEB_PORT` en el `.env` los fijan. Un puerto fijado que
esté ocupado **no se mueve**: se para y lo dice, porque si pediste el 7400 mereces una respuesta
sobre el 7400.

```bash
npm run dev                            # 7373 + 7374, con red de seguridad si están ocupados
PORT=7400 WEB_PORT=7401 npm run dev    # o los que tú digas (dos números distintos)
npm run dev:fixed                      # 7373 y 7374 a pelo, sin red de seguridad
```

## Árbol del repositorio (generado)

`node scripts/estructura.mjs` — ficheros rastreados por directorio, dos niveles bajo `server/src` y `web/src`.

```
.                                          11 ficheros
.githooks                                   1 ficheros
.github/workflows                           2 ficheros
config                                      9 ficheros
data/raw                                    1 ficheros
docs                                       11 ficheros
docs/plans                                  4 ficheros
experiments                                 6 ficheros
experiments/walkforward                     5 ficheros
scripts                                    16 ficheros
server                                      2 ficheros
server/src                                 23 ficheros  3 tests
server/src/alerts                           3 ficheros
server/src/ask                              6 ficheros  1 tests
server/src/audit                            2 ficheros  1 tests
server/src/auth                             6 ficheros  1 tests
server/src/baseball                        14 ficheros  1 tests
server/src/basketball                      13 ficheros
server/src/db                               8 ficheros  3 tests
server/src/doctor                           1 ficheros  2 tests
server/src/evaluation                       8 ficheros  5 tests
server/src/experiments                      2 ficheros  1 tests
server/src/football                        31 ficheros  4 tests
server/src/ingest                           8 ficheros  3 tests
server/src/latency                          5 ficheros
server/src/live                             6 ficheros
server/src/market                           1 ficheros
server/src/markets                          3 ficheros
server/src/model                            7 ficheros
server/src/news                             4 ficheros
server/src/nfl                             10 ficheros
server/src/odds                             5 ficheros  4 tests
server/src/paper                            3 ficheros  2 tests
server/src/picks                            1 ficheros  1 tests
server/src/points                           4 ficheros
server/src/postprocess                      5 ficheros
server/src/prematch                         5 ficheros  1 tests
server/src/recent                           1 ficheros  1 tests
server/src/routes                           9 ficheros
server/src/scripts                         49 ficheros
server/src/security                         3 ficheros  1 tests
server/src/shadow                           4 ficheros  1 tests
server/src/staking                          8 ficheros  1 tests
server/src/test                             2 ficheros  1 tests
server/src/trust                           10 ficheros  5 tests
server/src/weather                          2 ficheros  1 tests
web                                         6 ficheros
web/public                                  5 ficheros
web/public/flags                          212 ficheros
web/src                                     3 ficheros
web/src/components                         46 ficheros
web/src/lib                                20 ficheros
```
