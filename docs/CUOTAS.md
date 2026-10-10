# Cuotas y mercado

The Odds API, la demostración etiquetada, los snapshots históricos, la comparación con el mercado y el escáner de líneas.

## La comparación con el mercado, visible en las cinco pestañas

Es para lo que existe la tarjeta —¿el modelo se aparta del precio?— y era lo único que no
se veía:

- En **baloncesto** había dos barras apiladas: la del modelo y otra más fina debajo,
  «Mercado, sin vig», **sin un solo número**. Comparar a ojo dos rectángulos casi iguales
  no es comparar: tres puntos porcentuales son once píxeles.
- En **NFL, béisbol y fútbol** ni siquiera había segunda barra. La probabilidad del mercado
  estaba en el desglose, a dos clics.

Ahora hay **una sola barra** con el corte del mercado marcado encima, así que la distancia
entre el corte de color y la marca blanca **es** la discrepancia, con la cifra al lado
(«mercado, a 3.1 pp»). Cuando coinciden, lo dice en palabras.

La marca se dibuja sobre la misma fracción que los segmentos, no sobre 100: con segmentos
que suman 0,98 —que pasa con los redondeos— dibujarla sobre 100 la desplazaría un punto
entero.

Y de paso la tarjeta de baloncesto pierde la segunda barra: 700 → 690 px, y una cosa menos
que mirar.

## «¿Por qué me aparece partido demo?»

La app cae a cuotas de demostración —generadas por el propio modelo— por **tres motivos
distintos**, y hasta ahora los tres se veían igual: la etiqueta `odds demo` y nada más.
Solo se guardaba *que* había caído, no *por qué*.

| razón | qué pasa | qué hacer |
| --- | --- | --- |
| `sin_clave` | falta `ODDS_API_KEY` | `npm run clave` y `npm run update-data` |
| `fuente_falla` | la clave está, pero el proveedor no contestó: cuota agotada, clave inválida o sin internet | `npm run doctor` — lo dice sin gastar cuota |
| `sin_eventos` | todo bien, pero no hay tenis en juego | **nada**: entre torneos no se publica nada |

Eso importa porque el aviso decía siempre *«pon tu clave en ODDS_API_KEY»*, que es un
consejo **equivocado en dos de los tres casos** — y el más frustrante, porque manda a
revisar algo que ya está bien. `sin_eventos` es el caso normal entre torneos y no hay nada
que arreglar; `fuente_falla` con la cuota agotada tampoco se arregla tocando la clave.

Ahora la razón se guarda al refrescar (`odds_fallback_reason`), sale en `/api/meta` y la
pantalla dice la de verdad. El detalle del error del proveedor se guarda solo mientras esa
sea la causa: dejarlo puesto haría que se enseñara el mensaje de un fallo que ya no ocurre.

Comprobado en el navegador con las cuatro ramas, incluida la neutra (clave puesta y razón
desconocida, que es lo que ve una base anterior a este cambio). Y `fuente_falla` se
registró sola en una prueba real: clave puesta, proveedor inalcanzable, `HTTP 403` guardado
como detalle.

## «Quiero las cuotas reales»: `npm run odds`

```bash
npm run odds
```

Pide las cuotas de los seis deportes y dice, deporte a deporte, si han llegado y —cuando
no— **por qué no**:

```
  Fútbol      ✓ 84 partidos con cuotas reales
  Baloncesto  · 8 de demostración
              ↳ no hay ningún partido con precio publicado
  NFL         · sin línea publicada (el calendario sigue siendo real)
  Tenis       ✓ 12 partidos con cuotas reales
──────────────────────────────────────────────────────────────
Parcial: 3 de 5 con cuotas reales (Fútbol, Béisbol, Tenis).
```

Existía un hueco que ni `update-all` ni `doctor` tapaban. `update-all` reingiere el
**histórico** de los cinco deportes —un centenar de megas y dos minutos— para acabar
refrescando las cuotas al final: si lo único que ha cambiado es que ahora hay una clave en
el `.env`, ese histórico ya estaba bien y se vuelve a bajar entero para nada. Y `doctor`
diagnostica pero no arregla, a propósito.

Cuesta **5 peticiones**, una por deporte, y lo dice antes de gastarlas. Al terminar recuerda
cuántas quedan.

Tres detalles que no son de estilo:

- **Un deporte que revienta no para a los otros cuatro.** Cada uno habla con un endpoint
  distinto del proveedor, y el fallo de uno no dice nada de los demás.
- **La NFL nunca aparece en «qué hacer».** Su estado sin precios es «sin línea publicada»,
  y sus partidos siguen siendo reales: meterla en la lista de problemas mandaría a buscar
  una avería que no existe.
- **Sale con error solo si NINGUNO lo consigue.** Un parcial es un resultado legítimo —
  tener cuotas de tres deportes y no de los otros dos suele ser el calendario — y devolver
  error ahí rompería cualquier script que encadene esto.

## Odds reales y partidos próximos (The Odds API)

Los partidos próximos **reales** (los que se juegan hoy/esta semana) y sus cuotas vienen de
The Odds API. Sin key, la app muestra un demo con partidos de ejemplo.

1. Regístrate gratis en **https://the-odds-api.com** y copia tu API key (botón *Get API Key*).
   El plan gratuito da 500 requests/mes.
2. Ponla con

   ```bash
   npm run clave
   ```

   que la pide sin enseñarla, la escribe en el `.env` de la raíz (lo crea desde `.env.example` si
   no existe), deja **una sola** línea `ODDS_API_KEY=` aunque hubiera varias, la comprueba contra el
   listado gratuito del proveedor (no gasta créditos) y avisa si la terminal tiene otra
   `ODDS_API_KEY` que gana sobre el `.env`. A mano también vale:

   ```bash
   ODDS_API_KEY=tu_clave_aqui
   ODDS_REGIONS=eu
   ```

   (NUNCA subas tu `.env` — está en `.gitignore`. Para cambiar de clave basta con editar esa línea
   y reiniciar; no hay nada que tocar en el código.)
3. Ejecuta `npm run update-data`. La ingesta **descubre automáticamente los torneos de tenis
   activos** en ese momento (Grand Slams, Masters/1000, 500…) y trae sus partidos, así aparece
   lo que realmente se juega hoy — no una lista fija.

### «Me aparecen cuotas de demostración»: `npm run doctor`

Es un síntoma con **cinco** causas distintas y desde fuera se parecen todas: no hay `.env` en la
raíz (o está en otra carpeta), la línea de la clave está mal escrita, The Odds API la rechaza,
el plan del mes está agotado, o el servidor se arrancó **antes** de editar el `.env` — que solo
se lee al arrancar.

```bash
npm run doctor
```

Comprueba las cinco en orden y termina diciendo cuál es y con qué comando se arregla. No gasta
cuota: la única llamada es a `/v4/sports/`, que The Odds API documenta como gratuita y existe
justo para validar una clave sin pagar por ello (`--sin-red` se salta incluso esa). Nunca imprime
la clave entera —`6467••••••••a339`— porque esta salida es lo que uno pega en un chat al pedir
ayuda. Y no edita el `.env` por ti: es el único dato del proyecto que no se puede regenerar solo.

### El cupo gratuito, y cómo se agotó

**The Odds API cobra un crédito por mercado y POR REGIÓN.** Una llamada pidiendo
`h2h,spreads,totals` en `eu,uk` cuesta **seis** créditos, no uno. El listado `/sports` es gratis.

Esa aritmética, que el código no estaba haciendo, agotaba el plan gratuito **en dos días y medio**:

| Por ciclo de refresco (antes) | Créditos |
|---|---:|
| Tenis, ~4 torneos activos × 1 mercado × 2 regiones | 8 |
| Baloncesto, 7 ligas × 1 × 2 | 14 |
| Fútbol, 13 ligas × 1 × 2 | 26 |
| **Total** | **48** |

48 × 4 ciclos al día × 30 días = **5.760 al mes**, contra un cupo de 500.

Lo que se cambió:

1. **Una sola región** por defecto en vez de dos. `eu,uk` duplicaba el precio de cada llamada para
   tener una segunda opinión sobre los mismos precios.
2. **El cupo se lee y se recuerda.** Cada respuesta trae `x-requests-remaining`; ahora se guarda, se
   comprueba antes de gastar y **se muestra en el pie de la app**, en todas las pestañas.
3. **Una reserva** (2 % del plan, mínimo 25). Por debajo de ahí el refresco automático se abstiene,
   para que los últimos créditos queden para el botón **↻ Actualizar** que pulses tú, y no se los
   coma un temporizador a las 4 de la mañana.
4. **El listado `/sports` se pide una vez y se comparte.** Es gratis, pero cinco deportes hacían cada
   uno su llamada en cada ciclo.
5. **La NFL filtraba mal**: era el único deporte que pedía todas sus ligas sin comprobar si estaban
   en temporada, y encima con tres mercados. En marzo pagaba 6 créditos por no traer nada.
6. **`AUTO_REFRESH_MINUTES=0` no desactivaba nada.** `Number('0') || 720` es 720, así que lo primero
   que prueba cualquiera para frenar el gasto no hacía absolutamente nada. Arreglado.

Resultado: **~8 créditos por ciclo, dos veces al día, unos 480 al mes** — dentro del plan gratuito.

### Y cuando el plan crece, el ritmo crece solo

Nada de lo anterior debería tener que reescribirse por cambiar de plan, así que ya no hace falta:
**la app aprende cuánto puede gastar y se ajusta sola.**

`x-requests-remaining` + `x-requests-used` **es** el tamaño del plan, y llega gratis en cada
respuesta. Con ese número la app calcula tres cosas que antes eran constantes escritas a mano:

| | Cómo sale | Plan de 500 | Plan de 20.000 |
|---|---|---:|---:|
| Reserva para el botón ↻ | 2 % del plan (mínimo 25) | 25 | **400** |
| Presupuesto automático | 60 % del plan | 300 | **12.000** |
| Intervalo de refresco | presupuesto ÷ coste de un ciclo | cada ~3,4 días | **cada ~2 h** |

El coste de un ciclo también se mide en vez de suponerse: es la diferencia del contador `used` de
la propia API entre el principio y el final del ciclo. Con las ligas de hoy sale **34 créditos**
(13 de fútbol + 7 de baloncesto + 4 de béisbol + 6 de NFL + ~4 de tenis, a una región). La NHL
suma **2 por ciclo** en temporada (ganador y total, `icehockey_nhl`) y cero de junio a septiembre:
el listado gratuito de `/sports` dice si está activa. La UFC suma **1** (ganador,
`mma_mixed_martial_arts`, todo el MMA: de ahí solo se guardan las carteleras de la UFC).

El 40 % que no se presupuesta no es timidez: absorbe lo que una recta no puede prever — trece ligas
de fútbol configuradas de las que juegan cinco en una semana cualquiera, y los refrescos que pidas
tú a mano.

**Dos límites, y hacen cosas distintas.** La reserva protege el *final* del plan; la **guarda de
ritmo** protege la mitad del mes, que es donde un plan cuarenta veces mayor se pierde de verdad —
no llegando a cero, sino gastando tres semanas en tres días. Si el gasto va por delante del
calendario, el refresco automático se abstiene hasta que el mes lo alcance; **el botón ↻ nunca se
bloquea por esto**.

Si prefieres fijarlo tú, `AUTO_REFRESH_MINUTES` en el `.env` manda y el ajuste automático se aparta.

**¿Y si mejor gasto los créditos en más casas de apuestas?** Es la otra opción legítima con un plan
grande: `ODDS_REGIONS=eu,uk` duplica el coste de cada llamada pero cruza más casas, así que el
consenso sin vig sale de más precios. Con 20.000 créditos cabe: el ciclo pasa a 68 y el intervalo a
unas 4 h, todo calculado solo. No lo he cambiado por defecto porque **mueve todos los números de
mercado de la app** y esa es una decisión tuya, no mía.

### Que se actualice solo

Con la key configurada, el servidor **refresca las odds automáticamente** mientras corre (al arrancar
y cada `AUTO_REFRESH_MINUTES`, **12 h** por defecto), en los cinco deportes. Las ligas fuera de
temporada no gastan nada. También puedes pulsar **↻ Actualizar** en el dashboard para refrescar al
instante, y el pie de la app te dice cuántas peticiones te quedan.

Para desactivarlo del todo: `AUTO_REFRESH_MINUTES=0`.

## El histórico del mercado: snapshots de cuotas

Cada respuesta real de The Odds API queda guardada **casa por casa**, en los cinco deportes, y
nunca se sobrescribe. Así se puede reconstruir cómo se movió un mercado:

```
Sinner vs Alcaraz (h2h, mediana de las casas)
  10:00  Sinner 1.82
  13:00  Sinner 1.76
  16:00  Sinner 1.69
  cierre Sinner 1.67   (última observación, 10 min antes de empezar)
```

`GET /api/odds/history/:eventId?market=h2h` devuelve la evolución de cada selección, la
apertura, la última cuota y el cierre.

| Tabla | Qué guarda | ¿Se puede editar? |
| --- | --- | --- |
| `odds_snapshots` | evento, deporte, competición, mercado, selección, casa, cuota, línea, cuándo se vio, cuándo la publicó la casa, origen, si el evento ya había empezado | **No**: triggers de SQLite rechazan UPDATE y DELETE |
| `odds_event_observations` | cada vez que un evento apareció en una descarga | **No** |
| `odds_quote_state` | la última cuota de cada casa: caché para decidir si hay cambio | sí, y se puede reconstruir de las otras dos |

**Decisión: solo se guardan CAMBIOS.** Una cuota que no se movió no genera otra fila: el estado
del mercado en cualquier instante es «el último snapshot anterior», y la prueba de que seguía
vigente la da `odds_event_observations`. Por eso la cuota de cierre sabe decir *cuándo* se
observó por última vez aunque no cambiara. Si una casa **deja** de ofrecer una selección, se
anota una fila de «retirada»; sin ella, esa cuota vieja seguiría viva para siempre en la
reconstrucción. Un cambio de **línea** con la misma cuota también es un cambio.

Las cuotas de demostración nunca entran: no pasan por el cliente del proveedor.
`fb_odds_history` sigue existiendo porque la usa el módulo de noticias (solo la mediana del
fútbol); el histórico general es este.

## Por qué ESTE deporte sale en demostración (`npm run doctor`)

Cada deporte guardaba `*_odds_source = 'fixture'`, que dice **que** está en demostración.
Las causas son cuatro y piden cosas opuestas — una se arregla y otra se espera — así que
ahora se guarda también **cuál**:

| causa | qué pasa | qué hacer |
| --- | --- | --- |
| `sin_clave` | falta `ODDS_API_KEY` | ponerla en `.env` |
| `fuente_falla` | el proveedor no contestó: cuota agotada, clave inválida o sin red | mirar el detalle, que trae el error literal |
| `sin_ligas` | el proveedor contestó y **ninguna** de las competiciones que ofrece es de las configuradas | nada en el `.env`: o no hay liga en juego, o al proveedor le cambió la clave del deporte |
| `sin_eventos` | reconocimos la liga y no hay ni un partido con precio | esperar |

`sin_ligas` era la que más falta hacía y la que **no se podía diagnosticar de ninguna
manera**: la ingesta hace `if (!league) continue;` sobre cada competición que el proveedor
lista, así que si ninguna casa las ofrece bajo la clave que el proyecto conoce, las 140
filas del fútbol caen a demostración **sin una sola línea de log**. Por eso esa causa
guarda además las claves que el proveedor sí ofreció, que es el dato con el que se
arregla.

`npm run doctor` lo enseña debajo de cada deporte:

```
✗ Fútbol      140 de DEMOSTRACIÓN
  ↳ el proveedor no contestó (cuota agotada, clave inválida o sin red)
    Odds API /sports: HTTP 403
✗ Tenis        27 de DEMOSTRACIÓN
  ↳ no hay ODDS_API_KEY
```

La NFL no aparece nunca aquí: su estado sin precios es «solo calendario», que no es una
cuota inventada y no se cuenta como demostración.

## La latencia del escáner de líneas (`npm run latency`)

Desde que una casa publica un precio hasta que ese precio está **en tu pantalla** hay
cuatro tramos, y tienen dueños distintos. El total no es lo accionable: si tardas ocho
minutos, lo único que sirve es saber en cuál de los cuatro se van.

| etapa | qué mide | de quién depende | presupuesto |
| --- | --- | --- | --- |
| `origen` | la casa publica → lo tenemos | la cadencia de sondeo y el proveedor | 4 min |
| `ingesta` | lo tenemos → escrito en la base | nuestro parseo y la base de datos | 30 s |
| `servidor` | petición → respuesta | nuestra API | 20 s |
| `cliente` | respuesta → pintado | la red y el navegador | 10 s |

### Un check de latencia que dependía de lo que hubiera en la base

La regla importante de la alerta es que **sin medición completa no se declara
incumplimiento**: si falta una etapa, el total está por debajo del real y decir «se
cumple» sería falso. Comprobar eso necesita un caso con el total pasado y alguna etapa sin
medir, y ese caso se montaba escribiendo muestras en la base.

El montaje era frágil de una forma que tardó en aparecer. El total suma el **p95** de cada
etapa: con la tabla vacía, la única muestra inyectada *era* el p95 de su etapa y el total
se pasaba del objetivo. Con la tabla ya poblada —después de tener el servidor un rato
levantado— esa misma muestra caía entre doscientas y no movía el p95 ni un milisegundo, así
que el montaje dejaba de montar nada. No producía un falso verde: rompía. Pero rompía por
el andamio y no por el comportamiento que vigila, y un check que se rompe según lo que haya
medido cada uno es un check que alguien acaba silenciando.

Arreglado igual que se arregló antes `allocate` → `allocateFrom`: la decisión se separó de
la lectura en `decideLatency(total, etapas, presupuesto)`, que no toca la base. Los tres
casos se escriben a mano —total pasado con una etapa sin medir, el mismo total con las
cuatro medidas, y uno dentro del objetivo— y el contraste entre los dos primeros es lo que
demuestra que manda la guarda y no otra cosa. Comprobado quitando la guarda: falla.

El objetivo por defecto es **5 minutos de punta a punta (p95)**, y el reparto es
deliberadamente asimétrico: cuatro de los cinco minutos se le dan a `origen` porque ahí
es donde se va el tiempo de verdad. `LATENCY_TARGET_MS` lo cambia y escala el reparto
manteniendo las proporciones.

Se publica el **p95**, no la media. Un ciclo que va bien 95 veces y se atasca 5 tiene una
media estupenda y una experiencia mala, porque lo que se nota es justo el atasco.

### Lo primero que dice el informe es si el objetivo es alcanzable

Antes de reprocharle nada a nadie:

```
OBJETIVO: 5.0 min de punta a punta (p95)
  ✗ NO alcanzable con este plan. 500 peticiones al mes y 10 por ciclo dan un sondeo
    cada 864 min, o sea 432.0 min de antigüedad media frente a los 4.0 del objetivo.
    Se arregla con un plan mayor o sondeando menos deportes, no con código.
```

La antigüedad media de un precio es **medio intervalo de sondeo** —llega uniformemente
entre dos sondeos— así que el plan pone un suelo que ninguna optimización de parseo
toca. Con el plan gratuito de 500 peticiones al mes, un precio tiene de media unas seis
horas cuando lo lees. Decirlo primero evita mandar a alguien a optimizar serialización
cuando lo que hay que cambiar es el plan.

### La medición incompleta NO se pinta como un aprobado

Cuando falta alguna etapa por medir, el total está por debajo del real. Un `✓` verde ahí
sería una afirmación falsa, así que se marca con `·` y se dice qué falta:

```
· Medición incompleta: sin muestras de origen, cliente. El total de abajo es solo
  de las etapas que sí se han medido.
```

Lo mismo con las etapas vacías: salen con `n = 0` y su motivo, nunca con un `0 ms` que
se lee como un récord.

Y la suma de cuatro p95 **no** es el p95 del total —solo sería cierto si se atascaran
siempre a la vez— así que sale pesimista. Se usa así a propósito: para un objetivo de
latencia, equivocarse por el lado pesimista es el lado correcto.

### Sondeo adaptativo: el mismo presupuesto, gastado donde importa

«Adaptativo» suena a «sondear más a menudo», y con The Odds API eso es imposible: son
500 peticiones **al mes** en el plan gratuito, y sondear un solo deporte cada minuto
serían 43.200. No hay ajuste fino que arregle un factor de ochenta y seis.

Lo que sí se puede es gastar el mismo presupuesto de forma **desigual**. Antes todo se
refrescaba cada N minutos: el partido que empieza en veinte minutos y la línea que lleva
tres días quieta recibían la misma atención. Ahora pesan dos cosas:

* **Proximidad** — decae como una exponencial con semivida de 6 horas. La forma importa
  más que los números: un escalón («a partir de 60 minutos, ×10») produce un salto de
  gasto en un instante y deja el minuto 61 tan desatendido como el día anterior.
* **Movimiento reciente** — cada cambio observado en 24 h multiplica, con techo en ×4
  para que una línea histérica no se lleve el presupuesto entero.

Con techo también en la aceleración total (×8): gastar hoy ocho veces más es no tener
nada mañana.

**La unidad es el deporte, no el partido**, y hay que decirlo: la API cobra por petición
y devuelve todos los eventos del deporte en cada una, así que «refrescar solo este
partido» no existe. Pedir el Arsenal–City trae la Premier entera y cuesta lo mismo. Lo
que se decide es cada cuánto se pide cada deporte, y la urgencia se hereda del partido
que más la tenga.

Las dos heurísticas son **declaradas, no medidas**, y se dicen así. Lo que sí es
aritmética es la consecuencia: repartir un presupuesto fijo proporcionalmente a un peso
baja la latencia media ponderada por ese peso.

### WebSocket: se comprueba, no se supone

El encargo decía «WebSockets donde la API los ofrezca». La parte importante de esa frase
es *donde los ofrezca*, y averiguarlo es trabajo. Escribir un cliente contra un endpoint
que no existe es peor que no escribirlo: parece que la funcionalidad está y falla en
tiempo de ejecución en casa de otro.

Así que hay una **sonda** que intenta el apretón de manos de verdad y guarda lo que
contestó el servidor, con fecha:

```
npm run latency -- --probe
```

Un 404 o un 400 son respuestas válidas: dicen que ahí no hay WebSocket. Lo que **no** es
una respuesta es un error de conexión, y la sonda distingue las dos cosas — «no pude
comprobarlo» no es «no hay». La primera versión no distinguía y concluía «el proveedor
es REST» desde una red que simplemente no alcanzaba el host: un veredicto sobre la red
disfrazado de veredicto sobre la API.

Entre **nuestro** servidor y el navegador sí hay empuje, y es SSE en vez de WebSocket
porque el tráfico va en una sola dirección, el navegador reconecta solo y atraviesa
proxies que a veces rompen los WebSocket. Son dos tramos distintos del recorrido y no
hay que confundirlos.

### Alertas push, no refresco manual

Un precio puede llevar veinte minutos escrito en la base y no estar en la pantalla
porque nadie ha pulsado nada. Ese hueco **cuenta igual que el resto**: si el objetivo es
cinco minutos, un refresco manual lo hace inalcanzable por definición, porque depende de
que alguien mire.

El panel de la pestaña 🎟️ escucha el canal y se actualiza solo. Con permiso, además
avisa con una notificación del sistema, etiquetada por partido para que un aviso nuevo
**sustituya** al anterior en vez de apilarse — una línea que se mueve cinco veces deja
si no cinco notificaciones casi idénticas, y la persona las silencia todas.

El permiso **no** se pide al cargar. Un permiso denegado es permanente hasta que la
persona lo cambie a mano en el navegador, así que pedirlo sin contexto no es un intento
fallido: es haber gastado la única oportunidad. Se pide desde el botón.

Y se **mide de todos, se avisa de algunos**. Cada precio nuevo es una muestra válida y
tirarla sesgaría los percentiles, pero avisar de todos es otra cosa: el primer sondeo con
una clave nueva ve por primera vez cada partido de cada liga, y sin techo eso son decenas
de notificaciones de golpe. Se avisa de los cinco partidos más próximos —los accionables,
porque una línea del sábado que se mueve el miércoles no exige mirar ahora mismo— y el
resto va en un solo aviso que dice cuántos son. Un canal de alertas que se silencia el
primer día es un canal de alertas que no existe.

### La última etapa la mide el navegador, porque es la única que puede

El servidor no sabe cuánto tardó la red del usuario ni cuánto tardó React en pintar. Sin
esa medición, «de punta a punta» sería en realidad «hasta que salió de mi máquina», que
es la parte fácil. Así que el cliente cierra el cronómetro y lo reporta.

Dos detalles que no son adorno: se usa `performance.now()` y no `Date.now()` (el reloj
del sistema puede saltar a mitad de la medición, y una latencia negativa en un panel es
la clase de dato que hace desconfiar de todo el panel), y se cierra tras **dos**
`requestAnimationFrame` anidados, porque el primero corre antes del pintado del fotograma
y medir ahí daría un número sistemáticamente corto.

### Lo que se sabía y estaba mal antes de esto

Dos hallazgos de la investigación, porque explican de dónde salió el trabajo:

* La ingesta **descartaba `last_update`**, que es la única marca de tiempo de origen que
  el proveedor devuelve. Sin ella no había forma de medir la primera etapa, que es la
  que se come el 80 % del presupuesto.
* `AUTO_REFRESH_MINUTES` traía 720 por defecto — **12 horas**, o seis de antigüedad
  media. La cadencia automática ya lo arreglaba en cuanto se conoce el plan, pero el
  suelo seguía sin estar medido.

Y una advertencia sobre `origen`: son en realidad dos cosas pegadas —«la casa publica →
la API se entera» y «la API lo tiene → nosotros lo pedimos»— que **no se pueden
separar**, porque el proveedor no sella cuándo lo recibió él: devuelve el `last_update`
de la casa. Se mide la suma y se llama `origen` para no fingir una precisión que no hay.


---

## Mercados de menos liquidez (`npm run study:thin`)

Cuatro familias de mercados que la app no tocaba, cada una con **su propia distribución**
en vez de reciclar la del partido.

### Las dos mitades — de 8,35 pp de error a 2,08

El marcador al descanso llevaba ingerido desde el principio y había un modelo escrito,
medido y **deliberadamente apagado**, con el motivo al lado: tomaba la λ del partido y la
multiplicaba por la cuota de goles de la primera parte. Su diagnóstico era correcto —«la
media es correcta por construcción; la FAMILIA de la distribución es la equivocada»— y
pedía un trabajo que no se había hecho. Ahora está hecho, en tres partes:

1. **Un Dixon-Coles propio por mitad.** Uno ajustado sobre los goles de la primera parte
   y otro sobre los de la segunda, cada uno con su ataque, su defensa, su ventaja de campo
   y su ρ. Un equipo que sale fuerte y se apaga no se describe con un solo par de números.
2. **COM-Poisson en vez de Poisson.** Los goles de un equipo en una mitad están
   **INFRA**dispersos: menos ceros y más unos de los que admite una Poisson con la misma
   media. Medido sobre 24.778 partidos, un equipo se queda a cero en la primera parte el
   47,93 % de las veces y la Poisson dice 51,98 %. La ν ajustada por máxima verosimilitud
   sobre 40.828 muestras de entrenamiento sale **1,20** (>1 = infradispersa).
3. **ρ ajustada, y sale positiva.** En el partido entero ρ es negativa; en una mitad sale
   **+0,014 a +0,117** según la liga. No es un error de signo: lo que sobra en una mitad
   respecto a la independencia no son los 0-0, son los 1-1.

La ν ajustada sale **1,30**. Una medición anterior hecha a mano daba 1,20, porque usaba la
λ del partido × la cuota de la primera parte en vez de la λ del ajuste de la mitad — que
es exactamente el error que este módulo existe para no cometer. El número que se publica
es el del script.

Sobre 3.634 partidos de validación que el ajuste no vio, con las dos columnas medidas
sobre los **mismos** partidos:

| mercado | antes | ahora |
|---|---|---|
| descanso 1 | +3,81 | **+1,67** |
| descanso X | −5,00 | **−1,72** |
| descanso 2 | +1,19 | **+0,05** |
| descanso +0,5 goles | +4,87 | **+2,26** |
| descanso +1,5 goles | −1,75 | +1,01 |
| el local gana una mitad | +6,70 | **+3,23** |
| el visitante gana una mitad | +4,67 | **+1,78** |

El peor mercado pasa de **6,70 pp a 3,23**, y cinco de los siete mejoran. (Ese «antes» ya
es el mejor «antes» posible: usa λ del Dixon-Coles. La nota vieja del código llegaba a
8,35 pp porque las suyas venían del Elo.)

**Sigue siendo peor que el partido entero**, que está dentro de 1,5 pp en todo lo que
publica. Así que se publica con el error medido **al lado de cada línea** en la tarjeta:
un «+2,3 pp» quiere decir que en realidad pasa más de lo que dice el número.

**Y lo que no mejora:** el log loss del 1X2 al descanso no se mueve — 1,06780 → 1,06693,
IC 95 % [−0,0051, +0,0032], p = 0,67. Indistinguible. No es una contradicción: el log loss
mide sobre todo **discriminar** (separar los partidos que acaban 1 de los que acaban X) y
lo que ha mejorado es **calibrar** (que cuando dice 73 % pase el 73 %). Para estos
mercados manda la segunda, porque el sesgo va siempre en la misma dirección y se paga en
cada apuesta; pero el modelo nuevo no distingue mejor los partidos que el viejo, y eso
también está escrito.

### Props de jugador — la distribución de minutos, no su media

«Marca 0,45 por 90 y juega unos 70 minutos, o sea 0,35 goles» da la media correcta y la
probabilidad equivocada. Los 70 minutos no son 70: son 90 si es titular y aguanta, 25 si
entra del banquillo y **0 si no juega**. Así que:

```
P(marca) = Σ_m  P(minutos = m) · [1 − e^(−tasa·m)]
```

La masa en «no juega» aporta exactamente cero, y aplastarla a un promedio infla todas las
probabilidades. Las tasas van encogidas hacia el promedio de la posición (10 partidos de
prior) y **la titularidad también** (5 partidos): sin eso, en la jornada 1 todo el que
jugó tiene una titularidad del 100 % y las props salían con 79,9 minutos esperados y un
0 % de no jugar **para toda la plantilla** — el suplente con la misma seguridad que el
capitán.

Solo la Premier League tiene datos de jugadores. Salen goles, asistencias, gol-o-asistencia
y tarjetas; las tarjetas por jugador son una columna que la fuente publicaba y que nada
leía hasta ahora.

### Córners y tarjetas — el modelo está, los datos no

El esqueleto es el mismo (nivel de liga × lo que genera este equipo × lo que concede el
rival × localía) y la **familia se mide, no se elige**: `fitCounts` contrasta la
dispersión y devuelve Poisson o binomial negativa según lo que salga. Que los córners y
las tarjetas estén sobredispersos es razonable de esperar —el árbitro es un factor común
a todo el partido— pero «razonable de esperar» no es una medición.

**No hay datos.** Los publica football-data.co.uk (columnas HC/AC/HY/AY/HR/AR), la ingesta
ya las lee y hay columnas y migración para ellas, pero ese sitio no es alcanzable desde
donde se generaron estos datos, y las dos fuentes que sí lo son solo traen marcadores
(el CSV de footballcsv tiene cinco columnas: `Round,Date,Team 1,FT,Team 2`). El modelo se
queda **apagado y diciéndolo**, en vez de rellenar el hueco con una media inventada. En una
máquina que alcance esa fuente, `npm run update-data:fb` las llena y se enciende solo.

### Y por qué a estos mercados hay que exigirles más

Toda la app se apoya en que discrepar del precio es interesante. En el 1X2 de la Premier
eso es defendible: decenas de casas, margen del 4 %. En «córners del Betis por encima de
5,5» puede haber dos casas, un margen del 15 % y un límite de veinte euros — y ahí se
rompen las dos mitades a la vez, porque **la línea informa menos** (no ha pasado dinero
informado por ella) y **el margen se come la ventaja**. Las dos apuntan igual: exigir más,
no menos.

| profundidad | umbral | ejemplos |
|---|---|---|
| profundo | 4 pp | 1X2, total de goles, ambos marcan |
| medio | 6 pp | hándicap, marcador exacto, 1X2 al descanso, marca un gol |
| fino | 10 pp | gana alguna mitad, descanso/final, córners, tarjetas, asistencia |
| muy fino | 14 pp | ve tarjeta, marca 2 o más |

Esos multiplicadores son **estructurales, no medidos**, y se declara así: traducen el
margen típico de cada tipo de mercado, de forma que exigir el triple en un mercado de
nicho es aproximadamente exigir la misma ventaja *neta*. Cuántas casas cotizan cada
mercado **no se consulta**: el proveedor lo sirve por un endpoint por evento que se cobra
aparte, y pedirlo para sesenta partidos gastaría la cuota de quien use la app sin
preguntárselo. Por eso `books` es `null` —«no consultado»— y no `0`, que sería «ninguna».

---
