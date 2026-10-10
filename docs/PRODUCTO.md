# Funciones de producto (Fase 6)

Lo que se construye encima de los modelos, el banco de papel y los precios guardados. Ninguna de
estas funciones cambia una probabilidad publicada ni un parámetro del modelo, y ninguna toca una
fila de las tablas inmutables: leen de ellas y escriben en tablas propias. Cada una tiene su
interruptor en `config/features.json` y se apaga sin tocar código. El plan está en
[plans/phase-6.md](plans/phase-6.md).

## Laboratorio de estrategias

`estrategias.laboratorio` · Apuestas › Laboratorio · `GET/POST /api/estrategias`

Una estrategia es un banco de papel con nombre y su propia configuración: deportes, mercados (hoy
solo ganador), ventaja mínima, fracción de Kelly, tope por partido, exposición total y cortes por
pérdida diaria y semanal, más dos interruptores: si pasa por la capa de confianza (abstención y
recorte, como el banco principal) y si respeta el freno de calibración medido
(`experiments/calibration.json`, que deja a cero el tamaño de un deporte cuyo modelo pierde contra
el cierre). Parte siempre de la política vigente y se valida con los mismos rangos que una versión
de la política. Todas apuestan en paralelo, en el mismo ciclo que el banco principal y sobre las
mismas candidatas: las predicciones registradas con cuotas reales, nunca las de demostración. Cada
banco empieza en 1.000, lleva su exposición y sus pérdidas, y no ve las de los demás. Como el banco
principal, respeta los **topes por grupo de correlación**: su propio tope por partido y los de
equipo y jugador de la política vigente (3 %), sobre su banco. Los grupos de cada apuesta quedan
congelados con ella (`strategy_bets.correlation_groups`, migración 13); las apuestas de antes de la
migración cuentan solo con su partido.

Una estrategia **no se edita**. Cambiar la ventaja mínima a mitad de camino mezclaría dos hipótesis
en un mismo registro; para probar otra cosa se crea otra estrategia y se archiva la vieja (una vez:
deja de apostar y lo pendiente se sigue liquidando). Las tablas `strategies` y `strategy_bets` viven
en el libro mayor con los triggers de `paper_bets`: lo de apostar queda congelado, el cierre se fija
una vez, la liquidación una vez y nada se borra.

La comparación pone el banco principal como fila de referencia y, por estrategia: banco, ROI, CLV
medio contra el cierre de consenso, caída máxima, acierto y apuestas. El orden es el de creación,
no el de rendimiento, y una fila con menos de 30 apuestas liquidadas dice que no se compara con
otras: ordenar por ROI con once apuestas sería coronar al azar.

**Cada banco mira sus propias pérdidas.** El corte por pérdida diaria y semanal de cada estrategia
y del banco principal sale de sus propias apuestas liquidadas hoy y desde el lunes (hora local),
con la misma regla (`perdidasRealizadas` en `staking/policy.ts`). Hasta el seguimiento de la hoja
de ruta, el banco principal leía el registro personal (`bets`) y, con él vacío, no tenía límite de
pérdida; ver [plans/seguimiento.md](plans/seguimiento.md).

## «¿Qué habría pasado?»

`estrategias.historico` · Apuestas › Laboratorio · `GET/POST /api/estrategias/historico`

La política vigente, una estrategia guardada o una configuración sin guardar, reproducida sobre los
partidos históricos con cuota. Los escribe la corrida de referencia de los backtests de tenis
(tennis-data.co.uk, media de casas al cierre), fútbol (football-data.co.uk; Pinnacle temprano y de
cierre cuando están las dos) y NFL (nflverse, moneyline de cierre) en
`experiments/estrategias/<deporte>.json`: fecha, temporada, probabilidad del modelo fuera de
muestra y cuotas. Se recorre día a día con la misma `decideEvent` del banco de papel: las apuestas
de un día se dimensionan con el banco del inicio del día y la exposición acumulada de ese día, y
los cortes por pérdida usan lo realizado en la simulación.

Lo que no se puede reproducir se dice. Con solo la cuota de cierre se apuesta al cierre y el CLV
sería cero por construcción: sale DESCONOCIDO. La capa de confianza no existía en el pasado, así
que el histórico aplica solo la política de apuestas. Son los partidos con los que se desarrolló el
modelo, así que el resultado es optimista por construcción y no sustituye al banco en vivo. El
holdout final (fútbol 2026+, NFL 2024+) no entra: el fichero se escribe sin él y la lectura lo vuelve
a filtrar. Con la política vigente la NFL no apuesta nada —el freno de calibración la deja a cero— y
la pantalla lo explica; sin el freno, 2.114 apuestas entre 2010 y 2023 dejan el banco en 51,76 con
un ROI de −4,8 %, que es justo lo que el freno evita.

## Bandeja

`alertas.bandeja` · `/bandeja` y la campana · `GET /api/bandeja`

Todo lo que la app avisa también queda dentro de la app: cada notificación de `notificar()` (el
banco de papel apostó o liquidó, un trabajo de datos falló, un informe está listo) y cada alerta
de `emitirAlerta()` (valor detectado, mercado movido, calidad de datos, deriva, topes de riesgo…),
haya o no un canal configurado. Sin canales, es el único sitio donde se ve. Cada aviso lleva su
tipo, su gravedad, su deporte y un enlace: a la ficha del partido (por el id de próximos, con la
clave en `?clave=` para que un partido ya jugado enseñe su resultado) o al informe. Se filtra por
leídas, tipo y deporte, se marca uno a uno o todo de golpe, y la campana de la barra lateral y de la
cabecera móvil cuenta las no leídas. La tabla `inbox` es del libro mayor: de un aviso solo cambia si
se ha leído y nada se borra.

## Resumen diario e informe semanal

`informes.diario`, `informes.semanal`, `informes.pdf` · `/informes` · `GET /api/informes`

Cada mañana, a partir de las 7:00 de `APP_TIMEZONE` (sin ella, la zona del servidor), el trabajo
`resumen-diario` archiva el resumen del día: los partidos de las próximas 24 horas ordenados por
confianza, cuántos favoritos del modelo ganaron ayer por deporte (contado, no evaluado: un día no
mide a nadie), el banco de papel con su aviso de muestra y, si está quieto, por qué, las estrategias
activas y las alertas de las últimas 24 horas. El lunes, el trabajo `informe-semanal` archiva la
semana anterior: salud del modelo por deporte (log loss y Brier de la ventana de 28 días contra el
backtest, PSI, deriva, con su aviso de muestra), el CLV de las apuestas de papel que cerraron esa
semana, el banco y cada estrategia, las alertas de deriva, la frescura de los datos y los
experimentos registrados con su veredicto. Los dos trabajos corren cada hora y generan el informe
solo si falta, así que un servidor que arranca a las 11 no se salta el día.

Un informe archivado no se reescribe (tabla `reports`, append-only, uno por tipo y periodo): dice lo
que se sabía el día que se escribió. Al archivarse sale por los canales configurados como
`digest_listo` o `informe_semanal` y entra en la bandeja. Se lee en `/informes/:id`, que pinta su
Markdown sin HTML incrustado, y se descarga en PDF: un PDF de texto escrito en el servidor sin
dependencias (Helvetica con WinAnsi, así que tildes, ñ, «» y € salen bien). A mano:
`npm run jobs -- ejecutar resumen-diario` o `informe-semanal`, o el botón de la página, generan el
del periodo actual si falta.

## Comparador de líneas

`mercado.lineas` · Apuestas › Líneas · `GET /api/odds/lineas`

Para cada mercado abierto con cuotas observadas en las últimas 48 horas (los snapshots que ya se
guardan): por selección, la mejor cuota y su casa, la peor, el consenso (la mediana, el precio que
usa la app), cuántas casas cotizan y su dispersión (desviación típica de la probabilidad implícita,
en puntos porcentuales); por mercado, el margen del consenso y el que queda tomando la mejor cuota
de cada lado, que si es negativo es una surebet (y sale arriba). En hándicaps y totales solo se
comparan cuotas de la misma línea —la más cotizada—, porque −3,5 y −3 son apuestas distintas.

Es de solo lectura. **El banco de papel apuesta al consenso, no a la mejor línea** (la hoja de ruta
daba por hecho lo contrario): es conservador a propósito, porque la mejor cuota suele ser de una
casa que limita o que tarda en mover. La columna «mejor sobre consenso» enseña cuánto precio deja
esa decisión; cambiarla sería una versión nueva de la política, no de esta pantalla.

## Archivo de predicciones

`archivo.predicciones` · Confianza › Archivo · `GET /api/archivo`

Todo lo que el modelo dijo antes de cada partido, de los siete registros inmutables, en una lista:
la probabilidad tal como se enseñó (la enseñada en fútbol y NFL, donde existe), el favorito y su
banda (50–60, 60–75, ≥ 75 %), el mercado de entonces, el resultado (en la NFL un empate devuelve el
moneyline y cuenta como nulo, ni acierto ni fallo), la confianza de la última evaluación anterior
al inicio, el CLV de la apuesta de papel o, si no la hubo, de la señal registrada, y la versión de
la política con la que se evaluó. Se busca por texto sin tildes y se filtra por deporte, liga,
confianza, banda, resultado y fechas; los filtros van en la URL. El resumen cuenta aciertos sobre
resueltas con su aviso de muestra (100 predicciones), sin convertirlo en conclusión. Lee y no
escribe; con los volúmenes de hoy se calcula al vuelo.


## Ampliaciones (Fase 8)

Todas detrás de un interruptor **apagado por defecto**. El plan, con lo que no se pudo hacer en el
entorno donde se construyeron, está en [plans/phase-8.md](plans/phase-8.md).

### Tenis en vivo punto a punto

`tenis.enVivo` · la tarjeta de tenis desplegada, «Motor en vivo» · `POST /api/live/avanzar`

Encima del marcador que ya se tecleaba, dos botones «Punto para…» y «Deshacer». El marcador avanza
en el servidor con la misma regla que usa el motor en vivo (saque, ventajas, tiebreak y cambio de
set), así que la pantalla no lleva una segunda copia de cómo se cuenta el tenis. De cada punto se
apunta quién sacaba y quién lo ganó, y de ahí salen los puntos al saque de hoy (la actualización
bayesiana del motor) y el último juego, con si fue break. Deshacer vuelve exactamente al estado
anterior. No hay una fuente de marcador en vivo gratuita y fiable, así que no se conecta ninguna:
se teclea mirando el partido, y la pantalla lo dice.

### Asistente por Telegram

`asistente.telegram` · trabajo `asistente-telegram` (cada minuto)

El mismo asistente determinista de la app (las mismas plantillas, nada generado) contestando por
Telegram con el bot de las notificaciones. Solo responde a los chats de `TELEGRAM_CHAT_ID` y de
`TELEGRAM_ASISTENTE_CHATS`; a cualquier otro no le contesta. Detalle en
[NOTIFICACIONES.md](NOTIFICACIONES.md#el-asistente-por-telegram).

### NHL

Estuvo aquí en sombra; desde el seguimiento «NHL y UFC» es el sexto deporte publicado, con su
pestaña. Ya no tiene interruptor. En [NHL.md](NHL.md).

### UFC

Estuvo aquí en sombra (el Elo de luchador no ganaba a «el de mejor récord»); desde octubre de 2026 es
el séptimo deporte publicado, con su pestaña y la ficha de cada luchador, al pasar la prueba con una
logística que suma al Elo el récord, la edad, el alcance y la experiencia. Ya no tiene interruptor.
En [UFC.md](UFC.md).

### Props de jugador de la NBA

`apuestas.propsNba`, reservado y **sin modelo**. La hoja de ruta pedía evaluar primero si había box
scores gratuitos: no hay una fuente legítima y alcanzable (`stats.nba.com` pide cabeceras de
navegador y sus condiciones no permiten ingesta automática, las alternativas piden clave o prohíben
el rastreo, y la red del entorno bloquea las de la NBA). Sin datos no se construye un modelo de
jugador; si alguien enciende el interruptor, el doctor avisa de que no hace nada.
