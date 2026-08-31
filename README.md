# ⚽⚾🏈🏀🎾 Sports Predictor

Aplicación web + API REST para **predecir resultados deportivos** combinando historial
partido a partido, **ratings Elo**, forma reciente y **odds de casas de apuestas**.

Cinco deportes en **pestañas separadas** (nunca mezclados), más una pestaña para tus propias apuestas:

- **⚽ Fútbol** — las principales ligas del mundo, cada una en su **sub-pestaña**: Premier League,
  LaLiga, Bundesliga, Serie A, Ligue 1, Eredivisie, Primeira, Championship, MLS, Liga MX,
  Brasileirão, Argentina y Champions. **1X2** (con el empate como opción de primera), goles
  esperados, over/under 2.5, ambos marcan y marcadores probables.
  Ver [docs/FOOTBALL.md](docs/FOOTBALL.md).
- **⚾ Béisbol** — MLB (y NPB, KBO y universitario con probabilidades de mercado). El deporte donde
  **un solo jugador anunciado el día antes**, el lanzador abridor, mueve más el pronóstico que nada
  salvo los propios equipos — y puedes cambiarlo tú. Ahora también **el estadio**: Coors Field sube
  el total un 22 %, Seattle lo baja un 8 %. Ganador, total, línea de carreras (±1.5) y rejilla de
  marcadores, todo de la misma distribución.
  Ver [docs/BASEBALL.md](docs/BASEBALL.md).
- **🏈 Fútbol americano** — NFL: hándicap, total y ganador con una distribución de margen que
  **conoce los números clave del deporte** (el margen acaba en 3 el 15 % de las veces y en 9 el
  1.6 %) y que sabe **quién juega de quarterback**. Es el único deporte de la app cuyo modelo
  **se puede medir contra la línea de cierre real** — y el backtest dice, sin adornos, que no la
  bate, aunque ahora se queda más cerca.
  Ver [docs/NFL.md](docs/NFL.md).
- **🏀 Baloncesto** — NBA, WNBA, NCAA (M y F), EuroLeague y NBL: Elo por equipo con ventaja de
  campo, margen de puntos y descanso, más **diferencia esperada (spread)** y **total de puntos**.
  Ver [docs/BASKETBALL.md](docs/BASKETBALL.md).
- **🎾 Tenis** — ATP y WTA singles: Elo por superficie, forma, head-to-head, marcador por sets.
  Ver [docs/MODEL.md](docs/MODEL.md).
- **🎟️ Apuestas** — *no es un deporte*: es tu registro. Qué apostaste, cuánto, a qué cuota y cómo
  acabó, con beneficio, ROI, calendario del mes y rachas. Y lo que ningún historial de casa de
  apuestas te dice: **si seguir al modelo te sirvió o no**.

El modelo es **explicable, no una caja negra**: cada señal se expresa en puntos Elo y se
muestra lado a lado con la probabilidad implícita del mercado, incluyendo la detección de
posible *value* cuando el modelo discrepa de las cuotas.

Cada pestaña abre con **«donde el modelo no está de acuerdo con el mercado»**: los mercados
concretos —1X2, doble oportunidad, over/under, ambos marcan, hándicap, línea de carreras— en los
que el modelo se separa más de la cuota, con la probabilidad de cada uno y **la cuota mínima que
necesitarías** para que la apuesta valga la pena según el modelo. Ver
[«Sugerencias por deporte»](#sugerencias-por-deporte-lo-que-el-modelo-destacaría).

> ⚠️ **Aviso**: es una estimación estadística, **no** una certeza ni una recomendación para
> apostar. No considera lesiones de último momento, clima ni motivación (p. ej. exhibiciones).

![dashboard](docs/dashboard.png)

---

## Qué incluye — ⚽ Fútbol

- **Las principales ligas del mundo, cada una en su sub-pestaña** dentro de la pestaña de fútbol —
  nadie lee de corrido un listado que mezcla la Premier con el Brasileirão. La liga elegida se
  recuerda entre visitas. Se amplía en `config/football.json`, sin tocar la lógica.
- **1X2 completo:** local / empate / visitante con el empate tratado como lo que es, el resultado de
  ~1 de cada 4 partidos, no una nota al pie.
- **Mercados de goles coherentes entre sí:** goles esperados de cada equipo, over/under 2.5, ambos
  marcan y los marcadores exactos más probables. Todos salen de **la misma distribución**, así que
  es imposible que se contradigan.
- **La rejilla completa de marcadores**, 7×7, coloreada por resultado: se ve de un vistazo dónde
  está la probabilidad, cuánta se lleva cada bloque (local / empate / visitante) y cuánta queda
  lejos del marcador titular. Debajo, la **diferencia de goles** — que es otra pregunta distinta de
  «quién gana». La interfaz recibe la rejilla del servidor, así que no puede contradecir los
  porcentajes impresos encima.
- **Quién juega (Premier League).** Las lesiones y sanciones del día vienen ya marcadas; si sabes la
  alineación —se publica una hora antes— la marcas tú y **se recalcula la distribución entera**.
  Medido sobre tres temporadas de alineaciones reales: es la única señal probada en este proyecto
  que el Elo no contenía ya.
- **Modelo verificado sobre 17.200 partidos reales** (Premier, LaLiga, Bundesliga, Championship):
  **RPS 0.2063** frente a 0.2230 de la referencia, y una calibración del empate que pasó de errar
  5–8 pp a **±1 pp**.
- **Tres señales que se probaron y se descartaron** —ataque/defensa por equipo, racha y congestión
  de calendario— siguen en el código, apagadas y con su interruptor, para que el resultado negativo
  se pueda reproducir en vez de tener que creérselo.
- **Información de todos los equipos**: clasificación por Elo con goles a favor y en contra, y ficha
  por equipo (balance global / casa / fuera, puntos, últimos partidos).
- **Ligas sin fuente de resultados** (Champions) muestran partidos y probabilidades del mercado,
  diciéndolo claramente, en vez de inventar una predicción.

## Qué incluye — ⚾ Béisbol

- **El lanzador abridor como pieza central.** En ningún otro de los cinco deportes un solo
  jugador pesa tanto, y —a diferencia de una alineación de fútbol— **se anuncia el día antes**, así
  que el modelo puede tenerlo. Cada abridor lleva una razón de supresión de carreras ajustada por
  rival, y si sabes quién lanza (o lo han cambiado) **lo eliges tú y se recalcula todo**.
- **Las carreras no son Poisson y aquí no se finge que lo sean.** Una entrada acaba con tres outs,
  no con el reloj, así que las entradas grandes se agrupan: media 4,47 carreras, varianza 9,49. Una
  binomial negativa lo recoge; usar Poisson cuesta 1,3 puntos de acierto en el over/under.
- **El estadio, medido.** Coors Field y Petco Park no son el mismo deporte, y hasta ahora el modelo
  los trataba igual —con el dato ya descargado: la columna que nombra el estadio de los 37.262
  partidos del archivo. Coors sale **×1.220** (+22 % al total) y Seattle **×0.917**; 2,89 carreras
  entre los extremos, sobre un total de ~8,9. Validado hacia adelante en **seis cortes de 2014 a
  2024, los seis mejoran**, y el over/under acertado pasa de **53,4 % a 54,9 %**. La mejora se
  concentra **siete veces** en los parques extremos y es cero en los neutros: el modelo no se volvió
  más listo, dejó de equivocarse en Denver.
- **La diagonal de la rejilla está vacía a propósito**: un marcador final nunca queda empatado. Esa
  probabilidad es la de irse a entradas extra y se reparte en las casillas de una carrera.
- **Ganador, total, línea de carreras (±1.5), marcador exacto y diferencia**, todo sumado de la
  misma distribución, así que no pueden contradecirse.
- **Modelo verificado sobre 36.235 partidos reales de MLB** (2010–2025): **Brier 0.2431** contra
  0.25 de una moneda, y una calibración clavada dentro de ±0,4 pp en todas las bandas.
- **El contador de carreras se verifica solo**: los ficheros de Retrosheet traen las jugadas pero no
  el marcador, así que `npm run verify:bsb` recuenta una temporada entera y la compara con el
  registro oficial — 2.426 de 2.426 exactos, abridores incluidos.
- **Información de todos los equipos**: Elo, carreras a favor y en contra, balance en casa y fuera,
  **pitagórico** (lo que dicen sus carreras que debería ser su balance) y la rotación completa.

## Qué incluye — 🏈 Fútbol americano (NFL)

- **Los números clave del deporte, 3 y 7.** Un touchdown son 7 puntos y un field goal 3, así que
  el margen final se amontona: acaba en 3 el **15.1 %** de las veces y en 9 solo el **1.6 %**. Todos
  los demás deportes de la app valoran su hándicap con una curva suave; aquí eso se equivoca justo
  donde le preguntan, porque −3 y −3.5 no son la misma apuesta. La distribución lleva una tabla de
  pesos medidos, y vale **+0.141 nats por partido** (1.15× de verosimilitud) frente a la normal sola.
- **La ventaja de campo la mide la liga, no la fija el código.** Valía +2.75 puntos en 1999–2007,
  vale +1.92 en 2020–2025, y en 2020 con los estadios vacíos **el modelo la vio caer sola a +0.30**.
  Se rastrea con dos temporadas de memoria: 0.6353 de log loss en la era moderna contra 0.6389 si se
  deja fija.
- **Quién juega de quarterback.** Era la mayor omisión del modelo y el dato ya venía en el fichero
  que descargábamos: nflverse trae el titular de los **7276** partidos del archivo. Importa porque el
  **52 %** de los equipos-temporada usa más de un titular, así que un solo número por equipo promedia
  al titular con su suplente y está mal en las dos direcciones. Ahora el crédito de cada resultado se
  reparte entre el equipo y su quarterback (λ = 0.35, la misma cifra en tres cortes distintos de
  validación). Mejora el log loss un 0.46 % en general — y un **1.78 % en los partidos que empieza un
  suplente**, que es exactamente donde tenía que notarse.
- **El viento y el techo, sobre el total.** El residuo del total cae de forma monótona con el viento
  (+0.6 puntos con 0–4 mph, −5.1 con más de 21) y bajo techo se anota 2.44 puntos de más. Los dos
  términos son independientes: juntos bajan el RMSE del total de 13.614 a **13.525** fuera de muestra.
- **El único deporte que se puede medir contra el mercado — y no lo bate.** nflverse publica el
  spread y el total de cierre del **100 %** de los partidos desde 1999. El modelo se queda a 0.28
  puntos de la línea (eran 0.34 antes del quarterback) y acierta el **50.6 %** contra el hándicap, por
  debajo del 52.4 % que hace falta solo para cubrir la comisión. Está escrito en el panel de aciertos, no en la letra pequeña: es la
  razón de que la app no venda sus «posibles value» como dinero seguro.
- **La banda de incertidumbre calibrada contra algo externo.** El modelo se separa 7.3 pp de media
  de la línea de cierre, así que la tarjeta dice ±7.3 pp. Es la única de las cinco pestañas donde ese
  número no es un juicio razonable sino una medición.
- **Los tres mercados que ponen las casas**, en el orden en que los ponen: hándicap (aquí es *el*
  mercado), total y ganador. El hándicap se cotiza **en cualquier línea**, con su probabilidad de
  **nulo** — que en una línea entera de 3 puntos ocurre una de cada trece veces.
- **Funciona sin ninguna API key.** El mismo fichero trae el calendario de la temporada que viene
  antes de jugarse, así que hay partidos reales que predecir aunque no tengas cuotas configuradas.
- Además: bandas de «por cuánto gana» en unidades de anotación, marcadores más probables, historial
  directo, pitagórico con el exponente 2.37 de la NFL y ficha por equipo.

Detalles y todas las mediciones en **[docs/NFL.md](docs/NFL.md)**.

## Qué incluye — 🏀 Baloncesto

- **El hándicap y el total como probabilidades**, no solo como cifras. «Warriors −7.3» dice cuánto,
  no cuánto de probable; el margen del baloncesto resulta ser casi exactamente normal (σ 11.72
  medida sobre 58.281 partidos, ±1σ 70.1% contra el 68.3% teórico), así que de ahí salen la
  probabilidad de cubrir, la de over/under y el desglose de por cuánto gana.
- **Ligas apostables**, configurables en `config/basketball.json`: NBA, WNBA, NCAA masculino y
  femenino, EuroLeague y NBL. Qué ligas aparecen lo decide The Odds API según lo que esté activo
  ahora, no un calendario fijo.
- **Información de todos los equipos**: tabla ordenada por Elo con puntos anotados, recibidos y
  diferencial, y ficha por equipo (balance global / en casa / fuera, últimos partidos, Elo y su
  puesto en la liga).
- **Partidos próximos con cuotas** y, para cada uno, **tres cifras**: probabilidad de ganar,
  **diferencia esperada** (comparable al spread de la casa) y **total de puntos**.
- **Desglose completo**: por qué gana X en puntos de Elo (nivel, ventaja de campo, descanso), tabla
  que **suma exactamente** el rating usado, marcador estimado, medias de anotación, forma, balance
  por cancha, historial directo (con ventana reciente aparte) y comparación con el mercado.
- **Modelo verificado sobre 36.965 partidos NBA reales**: **68.4% de acierto** (baseline «gana el
  local»: 61.6%), Brier 0.2012 y error de margen de 9.2 puntos con sesgo cero. Y comparado contra
  **la predicción que publicó FiveThirtyEight** en esos mismos partidos: empate técnico
  (0.2012 vs 0.2014 de Brier).
- **Fiabilidad y track record propios**, igual que en tenis — incluida la precisión del margen, que
  es lo que importa si miras el handicap.
- **Ligas sin fuente de resultados** (EuroLeague, NBL) muestran partidos y probabilidades del
  mercado, diciendo claramente que no hay modelo Elo, en vez de inventar una predicción.

## Qué incluye — 🎾 Tenis

- **ATP y WTA**, singles. Torneos configurables (4 Grand Slams + Masters 1000 / WTA 1000 de
  fábrica) en `config/tournaments.json` — se amplía agregando entradas, sin tocar la lógica.
- **Elo general + por superficie** (dura / arcilla / hierba) con K-factor dinámico y ponderado por
  el margen de victoria.
- **Forma reciente**, **head-to-head** y **comparación contra el mercado** (probabilidad
  implícita sin vig + detección de value).
- **Probabilidad de victoria en grande** para cada jugador (con un decimal), y todas las cifras
  consistentes entre sí: los dos lados siempre suman exactamente 100.0%.
- **Datos de cada jugador en el partido**: ranking oficial ATP/WTA + puntos, país, edad y mano.
  Se muestran aunque el modelo no pueda predecir (jugador sin partidos en el historial), y en ese
  caso también se muestra la probabilidad implícita del mercado.
- **Modelo calibrado y verificado:** `npm run backtest` mide la exactitud real — **65.2% de
  acierto** y probabilidades calibradas dentro de ~1 pp, sobre **22.062 partidos ATP
  out-of-sample** (2015–2026). Incluye baseline de ranking y análisis de las discrepancias con el
  mercado. Ver [docs/MODEL.md](docs/MODEL.md).
- **Elo que aprovecha el marcador:** la K se escala con el **margen de games** (un 6-0 6-0 no
  informa lo mismo que un 7-6 6-7 7-6), penaliza la **inactividad** (volver de un parón largo hace
  rendir peor de lo que dice el Elo — medido, no supuesto) y **calibra distinto al mejor de 3 que al
  mejor de 5**. Cada cambio se aceptó solo tras verificar con el backtest que baja el Brier.
- **Track record propio:** la app **anota cada predicción antes** de que se juegue el partido y la
  puntúa cuando llega el resultado real, así que el dashboard muestra su acierto **en los partidos
  que tú viste** — no solo en el backtest histórico. Incluye comparación contra el mercado en esos
  mismos partidos. Ver [«Aciertos reales»](#aciertos-reales-de-la-app).
- **Fiabilidad por predicción:** cada probabilidad viene con un semáforo (alta / media / baja) y un
  **rango** (p. ej. *62% ± 3 pp*), calculado con cuántos partidos respaldan cada Elo, cuántos en esa
  superficie y si los datos del jugador están viejos. Un 62% con 800 partidos detrás y un 62% con 8
  ya no se ven iguales.
- **Resumen "qué es lo más probable"** en cada partido: en lenguaje natural, con el favorito,
  su probabilidad, el marcador probable y las razones (superficie, forma, H2H, saque, mercado).
- **Probabilidad de cada marcador** (2-0, 3-1, …) derivada matemáticamente de la probabilidad del
  partido, más probabilidad de set decisivo y de ganar sin ceder sets.
- **Señales físicas** por jugador: retiros, walkovers, días sin competir y carga de partidos
  (evidencia extraída de los resultados — no un diagnóstico médico ni una fuente de lesiones).
- **Historial en el torneo**: récord, títulos y mejor ronda de cada jugador en ese evento.
- **Desglose completo por partido**: explicación de *por qué* gana X (qué señal pesa más),
  ranking por Elo, últimos 5 resultados, récord en la superficie, comparativa de saque/quiebre
  (ace%, 1er saque, break points salvados) y marcador estimado.
- **Partidos próximos reales + auto-actualización:** con una API key, la app descubre los
  torneos de tenis activos ahora, trae sus partidos y refresca las odds sola cada pocas horas
  (o al pulsar *Actualizar*).
- **Dashboard** para elegir circuito y torneo, ver próximos partidos con barras
  modelo-vs-mercado, perfil de jugador (Elo por superficie + saque/quiebre + últimos
  resultados) y H2H.
- Datos guardados localmente en **SQLite** (`data/tennis.db`) para no depender de llamadas
  repetidas a las APIs.

## Fuentes de datos

| Tipo | Fuente | Por qué |
|------|--------|---------|
| Histórico ATP | [Tennismylife `TML-Database`](https://github.com/Tennismylife/TML-Database) | Gratis, sin API key, partido a partido desde 1968, con superficie, ronda, sets, estadísticas de saque/quiebre **y el ranking oficial de cada jugador en cada partido**. Mismo formato de columnas que el dataset clásico de Jeff Sackmann. **Ojo: el repo de GitHub se congeló en enero de 2026** — su propio README dice que la base viva se movió a `stats.tennismylife.org`, que no es GitHub. Así que llega a 2026-01-17 y ahí se queda. |
| Histórico WTA | [tennis-data.co.uk](http://www.tennis-data.co.uk/alldata.php) | Los repos `JeffSackmann/tennis_atp` y `tennis_wta` dejaron de estar accesibles (404) y TML solo cubre ATP, así que la WTA viene de aquí: un `.xlsx` por temporada, gratis y sin API key, con superficie, ronda, marcador set a set, ranking y puntos. **Además trae las cuotas de cierre de cada partido.** No tiene estadísticas de saque. |
| Cuotas históricas | [tennis-data.co.uk](http://www.tennis-data.co.uk/alldata.php) | Cuotas de cierre partido a partido (promedio entre casas). Es lo que permite medir de verdad si el modelo le gana al mercado — ver `npm run backtest -- --market`. |
| Datos de jugador | Incluidos en el histórico | Ranking oficial + puntos, país y mano. (El ATP Tour no ofrece API pública, y hacer scraping de su web sería frágil y de legalidad dudosa.) |
| Odds | [The Odds API](https://the-odds-api.com) | Cuotas head-to-head de partidos próximos, **de tenis y de baloncesto**, con la misma key. Plan gratuito (500 req/mes). |
| Resultados de baloncesto | [ESPN API pública](https://site.api.espn.com) | Gratis y sin key. Cubre NBA, WNBA y NCAA (M y F). |
| Histórico NBA profundo | [FiveThirtyEight `nba-elo`](https://github.com/fivethirtyeight/data/tree/master/nba-elo) | 59.008 partidos reales 1946–2015. Con esto se **ajusta y valida** el modelo de baloncesto; termina en 2015, así que nunca es la fuente de los ratings de hoy. Detalles en [docs/BASKETBALL.md](docs/BASKETBALL.md). |
| Baloncesto: **temporada actual sin depender de ESPN** | [sportsdataverse `hoopR-nba-data`](https://github.com/sportsdataverse/hoopR-NBA-data) | Espejo del calendario de ESPN en un CSV público, 2002 → hoy. Cierra el hueco de once años que dejaba 538 **sin necesitar más que GitHub**: con esto el archivo llega a junio de 2026 en vez de junio de 2015. Cuesta una descarga de 37 MB la primera vez (un solo CSV con todas las temporadas), luego caché de 24 h. |
| Fútbol: resultados + cuotas 1X2 | [football-data.co.uk](https://www.football-data.co.uk) | Fuente principal de fútbol: temporadas actuales de las grandes ligas **con cuotas de cierre 1X2**. |
| Fútbol: **resultados hasta la temporada actual** | [openfootball/football.json](https://github.com/openfootball/football.json) | La fuente principal de resultados de fútbol. Gratis, sin key, solo GitHub, y llega a mayo de 2026. Añadió Serie A, Ligue 1, Eredivisie, Primeira, Liga MX y Argentina, que antes no tenían modelo: de 4 a 10 ligas con Elo y de 19.483 a 21.591 partidos. Trae también el marcador al descanso. |
| Fútbol: **las temporadas que le faltan al mirror** | [repos de texto de openfootball](https://github.com/openfootball) (`espana`, `italy`, `deutschland`) | El mirror JSON tiene huecos: a `es.2` y `it.2` les faltan 2021-22, 2022-23 y 2023-24, y el formato Football.TXT sí las trae. Solo se usa cuando el JSON no tiene la temporada. Aportó 1.386 partidos a LaLiga Hypermotion y 1.167 a Serie B, y con ellos el salto de división pasó a medirse con 14 clubes en España (antes 9) y 17 en Italia (antes 9). |
| Fútbol: histórico para ajustar | [footballcsv](https://github.com/footballcsv) | El espejo con el que se ajustó y validó el modelo. **Ya solo se usa como último recurso: se quedó en la temporada 2020-21.** |
| Fútbol: plantillas y lesionados | [vaastav/Fantasy-Premier-League](https://github.com/vaastav/Fantasy-Premier-League) | Solo Premier League: minutos, goles y asistencias esperados por 90, y el parte de bajas del día. Dominio público, sin key. |
| Béisbol: histórico **con abridores** | [Retrosheet](https://www.retrosheet.org) vía [chadwickbureau/retrosheet](https://github.com/chadwickbureau/retrosheet) | 37.262 partidos de MLB (2010–2025) con el abridor de cada uno. El marcador se cuenta de las jugadas y se verifica con `npm run verify:bsb`. |
| Béisbol: temporada en curso + abridores anunciados | [MLB Stats API](https://statsapi.mlb.com) | Gratis y sin clave. Retrosheet publica al acabar la temporada, así que sin esto los Elo irían un año atrasados. |
| Fútbol americano: resultados, **líneas de cierre** y calendario | [nflverse/nfldata](https://github.com/nflverse/nfldata) | 7.276 partidos (1999–2025) con el spread y el total de cierre en el 100 % y el moneyline desde 2006 — lo que convierte «¿es bueno el modelo?» en una comparación contra el precio real. Trae también el calendario de la temporada siguiente, así que la pestaña funciona sin API key. |


### ¿Hasta cuándo llega cada deporte?

Medido en agosto de 2026, con todo actualizado desde este repositorio:

| Deporte | Último partido en la base | ¿Está al día? |
|---|---|---|
| ⚽ Fútbol | 2026-05-24 | **Sí.** Las grandes ligas europeas acabaron en mayo; la siguiente temporada arranca en agosto. |
| 🏀 Baloncesto | 2026-06-14 | **Sí.** Final de la NBA. La siguiente arranca en octubre. |
| 🏈 NFL | 2026-02-08 | **Sí.** Super Bowl LX. La temporada 2026 arranca en septiembre. |
| 🎾 Tenis (ATP) | 2026-01-17 | **No: le faltan ~7 meses.** Ver abajo. |
| 🎾 Tenis (WTA) | sin datos | **No.** Ver abajo. |
| ⚾ Béisbol | 2025-09-28 | **No: la temporada 2026 se está jugando ahora.** Retrosheet publica al terminar la temporada; el hueco lo cubre la MLB Stats API, que no es GitHub. |

Los tres primeros están al día de verdad: no es que la descarga fallara, es que
esos deportes están en su parón entre temporadas.

**Por qué el tenis y el béisbol no.** No es un problema de red ni de este código:

* `JeffSackmann/tennis_atp` y `tennis_wta` — el dataset estándar del tenis, sobre el
  que se diseñó esta app — **ya no existen**. Devuelven 404, y no es un bloqueo: otro
  repo de la misma cuenta (`tennis_MatchChartingProject`) sí responde.
* `Tennismylife/TML-Database`, que lo reemplazó para ATP, **se congeló en enero de
  2026**: su README dice que la base viva se movió a su web, que no es GitHub. Y nunca
  cubrió WTA.
* Retrosheet publica los partidos de béisbol **al acabar** la temporada, por diseño.

Lo que sí llega a la temporada en curso, desde tu máquina, son fuentes que **no**
están en GitHub y que este sandbox no alcanza: `tennis-data.co.uk` (ATP **y** WTA, con
cuotas de cierre) y `statsapi.mlb.com` (béisbol). Las dos están ya implementadas y
`npm run update-data` / `update-data:bsb` las intentan solas. Desde una red normal
deberían completar los dos huecos sin que toques nada.

Mientras estén incompletos, la app **lo dice en la propia pestaña** con un aviso
ámbar que indica cuántos meses de retraso lleva el historial; no finge estar al día.

### Los partidos del día se quedan hasta medianoche

Un partido que ya empezó **sigue en la lista el resto del día** — es cuando más
quieres ver cómo va. Desaparece a medianoche, no seis horas después de empezar.

Esto se rompió tres veces por mecanismos distintos y cada una pasó la auditoría,
porque comprobaba las piezas y no el resultado. Ahora hay una comprobación que mete
un partido de sonda que empezó hace dos horas y pregunta a la app si lo devuelve
(`npm run audit`, sección «¿Se quedan los partidos del día?»). No puede pasar
mientras el fallo exista.

**Sin `ODDS_API_KEY` el calendario también se refresca solo.** Antes no: el servidor
se saltaba el refresco entero sin clave, con el argumento de que las citas de
demostración son estáticas. No lo son — sus horas se generan relativas a ahora, así
que el calendario envejecía y la pestaña se quedaba vacía al día siguiente. Refrescar
sin clave no hace ni una petición HTTP ni gasta cuota.

---

## Requisitos

- **Node.js ≥ 22.5** (usa el módulo integrado `node:sqlite`, sin dependencias nativas).

## Instalación

```bash
git clone <este-repo>
cd <repo>
npm install
cp .env.example .env    # opcional: para odds reales, ver abajo
```

## Puesta en marcha rápida (con datos de demostración, sin internet)

```bash
npm run seed     # carga un dataset de muestra en data/tennis.db
npm run dev      # levanta API (:7374) + frontend (:7373)
```

Abre **http://localhost:7373**. Elige ATP/WTA y un torneo (Wimbledon, US Open…), verás los
próximos partidos con la predicción del modelo y las odds lado a lado.

> El seed usa **datos sintéticos** (nombres reales, partidos simulados) para que la app
> funcione end-to-end sin conexión. El badge "datos demo" lo indica. Reemplázalo con datos
> reales usando `npm run update-data`.

---

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

## Verificar los datos (`npm run verify:data`)

Había dos comprobaciones en el proyecto y ninguna respondía a esta pregunta. `npm run audit`
pregunta si la app cuenta con fidelidad lo que dijo el modelo; `npm run backtest:*` pregunta si el
modelo es bueno. **Las dos pasan sobre una base a la que le falta media temporada.**

Así que esta comprueba los **datos**, contra hechos de cada deporte que no dependen de ningún
modelo:

| | |
|---|---|
| Partidos por equipo y temporada | comparados con **las temporadas vecinas**, no con un número fijo |
| Cuánto gana el local | 45 % / 26 % / 29 % en fútbol, 53,5 % en béisbol, 62 % en la NBA |
| Marcadores posibles | y el suelo sale del archivo, no del juego moderno |
| Duplicados, equipos huérfanos, marcadores vacíos | uno por partido, todos existen, ninguno nulo |
| **Que los Elo se reproduzcan desde los partidos** | rehacerlos da la misma cifra: 0,00 de diferencia |

Lo de las temporadas vecinas es el punto fino. Una constante «una temporada son N partidos» no
funciona sobre un archivo que va de 1947 a hoy: la BAA de 1947-48 jugó 215 partidos donde sus
vecinas jugaron 380, y eso parece una descarga rota hasta que ves que tenía **ocho** equipos en vez
de doce — 54 partidos cada uno, perfectamente normal. La métrica es **partidos por equipo**: el
tamaño de la liga cambia el total y no el calendario; una descarga a medias cambia los dos.

Las temporadas que de verdad fueron cortas están **nombradas una por una** (la huelga del 94, el
COVID del 2020, los cierres patronales de la NBA), que es la alternativa honesta a ensanchar la
tolerancia hasta que no cace nada.

Probado quitando 110 partidos de la temporada 2018 de la NFL: la comprobación falla con
*«2018: 10 partidos por equipo frente a ~17 de sus vecinas»*.

---

## La navegación y la cabecera

**Los deportes están a la izquierda** desde 1024 px, en un rail de 15 rem, y arriba por debajo de esa
anchura. Es la mejor forma para seis elementos en pantalla ancha: las etiquetas se leen enteras en vez
de pelearse por una tira horizontal, y todo el ancho de la página queda para el contenido. En un móvil
de 390 px un rail se comería un tercio de la pantalla, así que ahí vuelve a ser una fila.

Es **una sola lista en dos orientaciones**, no dos listas (`SportNav`): los mismos seis deportes, el
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

Con el 7373 ocupado (una segunda copia de esto, por ejemplo) lo dice y se corre, sin que nadie
edite un archivo de configuración. Salta el 7375, que está reservado para `npm run preview`:

```
ℹ️  Puertos por defecto ocupados (¿otra app corriendo?), uso otros:
   API  7374 → 7376
   web  7373 → 7377
```

Verificado con otra app ocupando el 5173: esta arranca en el 7373/7374 y **no toca el 5173**.
Y con dos copias a la vez, cada una recibe **puertos distintos** y —matando la API de la
segunda— su web devuelve 500 mientras la primera sigue sirviendo: **cada proxy llega a su
propia API**, que es la propiedad que importa.

Si quieres números concretos, `PORT` y `WEB_PORT` en el `.env` los fijan. Un puerto fijado que
esté ocupado **no se mueve**: se para y lo dice, porque si pediste el 7400 mereces una respuesta
sobre el 7400.

```bash
npm run dev                            # 7373 + 7374, con red de seguridad si están ocupados
PORT=7400 WEB_PORT=7401 npm run dev    # o los que tú digas (dos números distintos)
npm run dev:fixed                      # 7373 y 7374 a pelo, sin red de seguridad
```

## Abrirla en el teléfono

Con la app corriendo (`npm run dev`):

```bash
npm run phone
```

Imprime la dirección que hay que escribir en el navegador del móvil —algo como
`http://192.168.1.42:7373`— y comprueba que la app y la API estén levantadas. El teléfono tiene que
estar en **la misma red Wi-Fi**; no se publica nada en internet.

Una vez abierta, en el menú del navegador: **«Añadir a pantalla de inicio»**. Queda con su icono, a
pantalla completa y sin barra de navegador, porque la app trae `manifest.webmanifest`, iconos de
192/512 px y el de 180 px que pide iOS.

**Si carga en el ordenador pero no en el teléfono**, casi siempre es el cortafuegos del sistema
bloqueando el puerto 7373 (macOS: Ajustes → Red → Firewall; Windows: permitir Node.js en redes
privadas).

Un detalle que evita un problema: el teléfono **no necesita alcanzar la API**. Llama a `/api/…` sobre
la misma dirección de la web, y el ordenador que sirve la página hace de proxy hacia el backend.

Para que vaya más rápido en el móvil, sirve el build en vez del servidor de desarrollo:

```bash
npm run build
npm run preview --workspace web    # queda en el puerto 7375
```

## Odds reales y partidos próximos (The Odds API)

Los partidos próximos **reales** (los que se juegan hoy/esta semana) y sus cuotas vienen de
The Odds API. Sin key, la app muestra un demo con partidos de ejemplo.

1. Regístrate gratis en **https://the-odds-api.com** y copia tu API key (botón *Get API Key*).
   El plan gratuito da 500 requests/mes.
2. En tu archivo `.env`:

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
(13 de fútbol + 7 de baloncesto + 4 de béisbol + 6 de NFL + ~4 de tenis, a una región).

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

## Actualizar datos (histórico + odds)

```bash
npm run update-data
# opciones:
npm run update-data -- --from 2015 --to 2025    # rango de temporadas
npm run update-data -- --tour atp               # solo un circuito
npm run update-data -- --skip-odds              # solo histórico
npm run update-data -- --source tennis-data     # forzar tennis-data.co.uk (trae cuotas)
npm run update-data -- --source tml             # forzar solo GitHub (comportamiento anterior)
```

**De dónde saca el histórico (`--source`)**

| Valor | Qué hace |
|---|---|
| `auto` *(por defecto)* | Intenta GitHub (TML) para cada circuito y, si no puede servirlo, cae a tennis-data.co.uk. Es así como la **WTA obtiene datos**: TML es solo ATP. |
| `tml` | Solo GitHub. Más estadísticas por partido (saque, break points), sin cuotas. |
| `tennis-data` | Solo tennis-data.co.uk. **Con cuotas históricas** en todos los partidos, sin estadísticas de saque. |

No es una fuente mejor que la otra: TML da más detalle por partido, tennis-data da cuotas. Con
`auto` obtienes ATP detallado y WTA funcionando.

Esto:
1. Descarga los CSV del histórico para el rango de años (cacheados en `data/raw/`).
2. Recalcula todos los ratings Elo.
3. Descarga odds en vivo de The Odds API (o genera fixtures si no hay key / fuera de temporada).

> `update-data` necesita acceso a internet (GitHub + The Odds API). En entornos sin red usa
> `npm run seed`.

### Descarga manual de tennis-data.co.uk

Si tu red bloquea ese dominio (el mensaje de error lo dirá):

1. Abre **http://www.tennis-data.co.uk/alldata.php**.
2. Baja el `.xlsx` de cada temporada que quieras (columna ATP o WTA).
3. Guárdalos en `data/raw/tennis-data/` con el circuito y el año en el nombre:
   `wta-2024.xlsx`, `atp-2024.xlsx`, …
4. Vuelve a ejecutar `npm run update-data`. Los detecta y los usa sin red.

También acepta `.csv`: si prefieres, abre el `.xlsx` y guárdalo como CSV.

### Método manual del histórico ATP (si la descarga automática falla)

Funciona siempre, sin git y sin credenciales. Útil si tu red filtra GitHub o si `git` tiene
credenciales guardadas que GitHub rechaza:

1. Abre https://github.com/Tennismylife/TML-Database → botón verde **Code** → **Download ZIP**.
2. Mueve el ZIP **sin renombrar ni descomprimir** a la carpeta `data/raw/` del proyecto.
3. Ejecuta `npm run update-data`. La app detecta el ZIP, lo descomprime sola y lo usa.

`npm run update-data -- --fresh` limpia la caché de descargas pero **conserva** los ZIP que hayas
puesto a mano, así que puedes reintentar sin volver a descargarlos.

---

## Aciertos reales de la app

El `npm run backtest` mide el modelo sobre 20 años de historial. Útil para ajustarlo, pero no
responde la pregunta que de verdad importa: **¿ha acertado los partidos que yo miré?**

Para eso la app lleva su propio registro:

1. Cada vez que muestra una predicción de un partido **real** próximo, la **guarda** (probabilidad,
   favorito, cuotas del momento, fiabilidad declarada).
2. Ese registro **no se reescribe nunca**: la primera cifra servida es la que se puntúa, así que no
   puede «mejorar» sola cuando se mueven las cuotas.
3. Cuando el resultado real entra al historial (al correr `npm run update-data`), la predicción se
   empareja con él y se puntúa.

El dashboard lo muestra arriba, plegable: acierto, Brier, log loss, calibración (dicho vs ocurrido),
**el mismo cálculo para el mercado en esos mismos partidos**, y el desglose por fiabilidad
declarada. Con menos de 30 partidos resueltos avisa de que la muestra es pequeña.

> El registro **sobrevive** a `npm run update-data`: reingerir el historial no borra tu track record.
> Los partidos de demostración (`odds demo`) **no** se registran: nunca se juegan, así que puntuar
> contra ellos no significaría nada.

Sirve además como detector de averías: si los datos se rompen o quedan viejos, el acierto cae y lo
ves, en vez de fallar en silencio.

## Scripts

| Comando | Qué hace |
|---------|----------|
| `npm run dev` | Levanta backend + frontend a la vez (ambos deportes) |
| `npm run seed` | Tenis: carga el dataset de demostración |
| `npm run update-data` | Tenis: refresca histórico real + odds |
| `npm run backtest` | Tenis: mide la exactitud del modelo |
| `npm run update-data:bb` | **Baloncesto**: equipos, resultados, partidos próximos y cuotas |
| `npm run backtest:bb` | **Baloncesto**: mide el modelo (incluye comparación con FiveThirtyEight) |
| `npm run update-data:fb` | **Fútbol**: equipos, resultados, partidos próximos, cuotas y plantillas |
| `npm run update-squads:fb` | **Fútbol**: solo las plantillas y el parte de lesionados (cambia a diario) |
| `npm run update-data:bsb` | **Béisbol**: equipos, resultados, lanzadores, partidos próximos y cuotas |
| `npm run backtest:bsb` | **Béisbol**: mide el modelo con Brier, calibración y error del total |
| `npm run verify:bsb` | **Béisbol**: recuenta una temporada y la compara con el registro oficial |
| `npm run update-data:naf` | **Fútbol americano**: equipos, resultados, líneas de cierre y calendario |
| `npm run backtest:naf` | **Fútbol americano**: mide el modelo **contra la línea de cierre real** |
| `npm run backtest:fb` | **Fútbol**: mide el modelo con RPS y calibración del empate |
| `npm run audit` | **Los cuatro**: comprueba que los números que muestra la app son coherentes entre sí |
| `npm run verify:data` | Comprueba los **datos** contra hechos de cada deporte: partidos por temporada, cuánto gana el local, marcadores posibles, y que los Elo se reproduzcan |
| `npm run study:devig` | Compara **multiplicativo vs. Shin vs. potencia** para quitar el margen de la casa, sobre 5.281 moneylines reales de la NFL |
| `npm run study:features` | Mide cada feature del modelo de fútbol por **log loss fuera de muestra**: lo que no se gana el sitio, fuera |
| `npm run study:sigma` | **Fútbol**: mide la escala del error del Elo (`ELO_SIGMA_C`), que fija el «± pp» de todas las tarjetas |
| `npm run doctor` | Diagnostica por qué la app muestra **cuotas de demostración**: `.env`, clave, cuota y qué hay guardado |
| `npm run build` | Build de producción del frontend + typecheck del backend |
| `npm run typecheck` | Chequeo de tipos de ambos workspaces |

### Comprobar que la información es correcta

`npm run audit` no mide el acierto del modelo (para eso están los backtests): comprueba
**propiedades que se tienen que cumplir por construcción**, en los cinco deportes a la vez. Un fallo
ahí es un bug, nunca una cuestión de ajuste.

Verifica, por deporte, que las probabilidades suman 1; que la rejilla de marcadores más su cola suma
1; que los bloques de la rejilla coinciden **exactamente** con el 1X2 que muestra la cabecera de la
tarjeta; que la distribución de márgenes suma 1 y que su casilla del 0 vale P(empate) en fútbol y
cero en béisbol (un marcador final nunca queda empatado); que el marcador que anuncia la tarjeta es
de verdad el máximo de la rejilla; que el balance mostrado coincide con lo que hay en la base de
datos; que el pitagórico está bien calculado; que «cubrir el hándicap» nunca es más probable que
ganar cuando el hándicap va en contra; que el veredicto es el resultado de mayor probabilidad; que
el signo de la diferencia esperada concuerda con el favorito; y que no hay ids de partido repetidos
ni fechas inválidas.

En fútbol americano comprueba además dos cosas que solo tienen sentido ahí: que **un hándicap de 0 es
exactamente la probabilidad de ganar** (lo que ata los dos mercados y habría cazado el error de signo
que tuvo la línea), y que **los factores del «por qué» suman el margen del titular** — un panel de
explicación cuyos términos no reconstruyen el número de arriba es decoración, no una explicación.

```
$ npm run audit
▸ Fútbol      32 predicciones · 24 partidos próximos
▸ Béisbol     12 predicciones · 8 partidos próximos
▸ Baloncesto  12 predicciones · 8 partidos próximos
▸ NFL         12 predicciones · 32 partidos próximos
▸ Tenis       30 predicciones
✅ 1.249 comprobaciones, todas correctas.
```

La primera vez que se ejecutó encontró cuatro fallos reales: en béisbol, la diagonal de la rejilla
de carreras dejaba 5·10⁻⁶ de probabilidad en marcadores empatados, justo en el borde superior del
rango, contradiciendo lo que la propia tarjeta afirma con palabras. Se arregló el reparto de esa
masa en `runDistribution` en vez de relajar la comprobación.

Y al extenderla al fútbol americano encontró otros dos, esta vez de verdad graves: el **lado
visitante del hándicap** estaba mal calculado (se pedía la línea contraria al equipo local en vez de
aplicar la línea al margen del visitante, así que «cubre» y «falla» no eran espejo: 0.284 contra
0.469 en el mismo partido), y el panel del «por qué» **sumaba 7,3 puntos de razones bajo un
pronóstico de 5,2**, porque usaba los Elo sin la regresión de pretemporada y colaba entre ellos el
ataque y la defensa, que mueven el total y no el margen. Ninguno de los dos habría movido un solo
punto de acierto en un backtest.

### Medir cambios del modelo

El backtest acepta banderas para **desactivar o reajustar** cada pieza y ver qué aporta, sobre los
mismos partidos:

```bash
npm run backtest -- --tour atp --from 2015   # ventana de evaluación
npm run backtest -- --mov 0                  # sin margen de victoria
npm run backtest -- --rest 0                 # sin penalización por inactividad
npm run backtest -- --bo3 0.7 --bo5 0.9      # otra calibración por formato
npm run backtest -- --calibration 1          # curva Elo cruda, un solo factor
npm run backtest -- --load 20                 # experimento: bonus por carga reciente
npm run backtest -- --tour wta --market       # modelo contra las cuotas históricas
```

Así ninguna decisión del modelo depende de una intuición: se compara y se queda la que mide mejor.

Con datos que traen cuotas (tennis-data.co.uk), el backtest imprime además la comparación
**modelo vs mercado real** sobre los mismos partidos, incluyendo si las señales de *«posible value»*
ganaron más de lo que el mercado les daba. Es la prueba honesta de si esas señales valen algo.

## Puesta en marcha del baloncesto

```bash
npm run update-data:bb     # equipos + resultados + partidos próximos y cuotas
npm run dev                # → abre la pestaña 🏀 Baloncesto
```

Opciones:

```bash
npm run update-data:bb -- --league nba        # solo una liga
npm run update-data:bb -- --seasons 12        # más temporadas de histórico
npm run update-data:bb -- --source 538        # histórico NBA real desde GitHub (llega a 2015)
npm run update-data:bb -- --skip-odds         # solo resultados
```

`--source` decide de dónde salen los resultados: `auto` (por defecto) usa ESPN y, si no lo alcanza,
cae al histórico NBA de FiveThirtyEight alojado en GitHub. Ese fichero es **real** pero termina en
2015, así que la app avisa en pantalla de que los Elo no describen a las plantillas actuales — nunca
lo presenta como datos al día.

Las cuotas usan **la misma `ODDS_API_KEY`** que el tenis. Sin key, la pestaña funciona igualmente
con una jornada de demostración etiquetada como tal.

## Puesta en marcha del fútbol

```bash
npm run update-data:fb     # equipos + resultados + partidos próximos y cuotas
npm run dev                # → abre la pestaña ⚽ Fútbol
```

Opciones:

```bash
npm run update-data:fb -- --league epl              # solo una liga
npm run update-data:fb -- --seasons 12              # más temporadas
npm run update-data:fb -- --source footballcsv      # espejo en GitHub (sin cuotas, va atrasado)
npm run update-data:fb -- --skip-odds               # solo resultados
npm run update-data:fb -- --skip-squads             # sin tocar las plantillas
npm run update-squads:fb                            # solo lesionados y sanciones (a diario)
```

Por defecto usa **football-data.co.uk** (temporadas actuales *y* cuotas 1X2 históricas) y, si no lo
alcanza, cae al espejo de GitHub. Las cuotas de partidos próximos usan la misma `ODDS_API_KEY`.

## API REST (puerto 7374)

Los tres deportes viven en espacios de nombres distintos: ningún endpoint puede devolver dos.

| Endpoint | Descripción |
|----------|-------------|
| `GET /api/meta` | Fuente de datos y conteos |
| `GET /api/track-record?tour=` | Acierto medido de la app en partidos ya jugados (+ mercado) |
| `GET /api/tours` | Circuitos ATP/WTA con conteos |
| `GET /api/tours/:tour/players?q=` | Jugadores (búsqueda) |
| `GET /api/players/:tour/:id` | Perfil: Elo general + por superficie + últimos resultados |
| `GET /api/tournaments?tour=` | Torneos configurados y cuáles tienen partidos próximos |
| `GET /api/matches/upcoming?tour=&tournament=` | Próximos partidos con odds y predicción |
| `GET /api/h2h?tour=&p1=&p2=` | Head-to-head entre dos jugadores |
| `GET /api/predictions/:id` | Predicción completa de un partido próximo |
| `GET /api/predictions?tournament=` | Predicciones de todos los próximos de un torneo |
| `POST /api/predict` | Predicción ad-hoc `{tour, p1, p2, surface, odds1?, odds2?}` |
| `GET /api/basketball/leagues` | Ligas con conteos y si tienen modelo Elo |
| `GET /api/basketball/games/upcoming?league=` | Partidos próximos con cuotas y predicción |
| `GET /api/basketball/games/:id` | Un partido con su predicción completa |
| `GET /api/basketball/teams/:league` | Todos los equipos de la liga |
| `GET /api/basketball/teams/:league/:id` | Ficha del equipo (balance, forma, anotación) |
| `GET /api/basketball/power?league=` | Ranking por Elo de todos los equipos |
| `GET /api/basketball/track-record?league=` | Acierto medido, incluido el error de margen |
| `POST /api/basketball/predict` | Predicción ad-hoc `{league, home, away, homeOdds?, awayOdds?}` |
| `GET /api/football/leagues` | Ligas con conteos y si tienen modelo Elo |
| `GET /api/football/fixtures/upcoming?league=` | Partidos próximos con 1X2, goles y cuotas |
| `GET /api/football/teams/:league/:id` | Ficha del equipo (balance, goles, forma) |
| `GET /api/football/power?league=` | Clasificación por Elo |
| `GET /api/football/track-record?league=` | Acierto medido en RPS |
| `POST /api/football/predict` | Predicción ad-hoc `{league, home, away, oddsHome?, oddsDraw?, oddsAway?}` |

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

## Qué incluye — 🎟️ Apuestas (tu registro)

Las cinco pestañas anteriores dicen lo que piensa el **modelo**. Esta dice lo que hiciste **tú**, y
están deliberadamente separadas: la precisión de un modelo no puede depender de a qué partidos te
apeteció apostar, y tu beneficio no puede maquillarse contando solo los partidos que al modelo le
gustaban.

- **Registrar en dos clics, o a mano.** Eliges un partido de los próximos —los 99 que tenga cargados,
  de los cinco deportes—, pulsas el lado al que apostaste, y escribes cuota y cantidad. La cuota se
  pre-rellena con la del mercado si la hay, pero **siempre es editable**: la de tu boleto es la única
  que cuenta. También puedes registrar cualquier cosa a mano.
- **El beneficio no se guarda, se calcula.** Sale de (estado, cantidad, cuota, retorno) cada vez que
  se lee, así que corregir un estado —lo que más se hace— nunca deja un número viejo detrás.
  Ganada, perdida, **anulada**, **media ganada / media perdida** (hándicap asiático) y **cashout**.
- **El ROI se calcula sobre lo que estuvo en riesgo**, no sobre todo lo apostado. Una anulada se
  devuelve: ni ganó ni perdió, así que no infla el denominador. Con una ganada y cinco anuladas el
  ROI sigue siendo +100 %, no +17 % — lo comprueba un test.
- **Las pendientes valen `null`, no 0.** Un cero diría «empataste», y promediar lo que aún no se sabe
  como ceros es exactamente cómo un tracker informa de un 0 % en una semana sin terminar.
- **Calendario del mes** con el resultado de cada día, en verde/naranja según el signo y con la
  intensidad proporcional al mayor día del mes. Pulsa un día para ver solo sus apuestas.
- **¿Te sirvió seguir al modelo?** Cuando eliges la apuesta desde un partido de la app, se guarda lo
  que pensaban el modelo y el mercado **en ese momento** — algo que no se puede recuperar después,
  porque las cuotas se mueven y los ratings se recalculan. Con eso la pestaña separa tus apuestas en
  «fui con el modelo» y «fui contra el modelo» y compara el ROI de cada grupo. Se oculta por debajo de
  diez apuestas comparables: con cuatro, eso es ruido con titular.
- **Sin símbolo de moneda.** Los mismos números sirvan euros, pesos o unidades; inventar una moneda
  que no elegiste sería incorrecto en la mayoría de instalaciones.

Todo vive en su propia tabla y su propio espacio de la API (`/api/bets`). Ningún modelo lee tus
apuestas y las apuestas no puntúan a ningún modelo.

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

Los cinco deportes están separados a propósito en todas las capas —tablas, modelo, endpoints y
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
