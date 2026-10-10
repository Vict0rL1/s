# Fuentes de datos

De dónde sale cada dato de cada deporte, cómo se actualiza y cómo se verifica. Lo que cada deporte incluye y lo que no.

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
| NHL: resultados y calendario | [sportsdataverse-data](https://github.com/sportsdataverse/sportsdataverse-data/releases) (releases `nhl_schedules` y `nhl_team_boxscores`) | Copia de la API de la NHL, un CSV por temporada: 21.960 partidos de 2009-10 a hoy y los que faltan de la temporada en curso, con su hora. Nueve temporadas traen marcadores de relleno y se arreglan con las «team box» de la misma fuente, solo si cruzan todos los partidos ([NHL.md](NHL.md)). La API de la NHL (`api-web.nhle.com`) queda como segunda fuente (`--fuente nhl`). |
| UFC: peleas, luchadores y medidas | [Greco1899/scrape_ufc_stats](https://github.com/Greco1899/scrape_ufc_stats) | Los CSV que rasca de ufcstats.com cada semana: 8.923 peleas hasta la UFC 332 (3 de octubre de 2026), luchadores, fecha de nacimiento, alcance y altura. Solo peleas ya disputadas: las que vienen llegan con las cuotas (`mma_mixed_martial_arts`, de la que solo se guardan las carteleras de la UFC) ([UFC.md](UFC.md)). |


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
- **Dixon-Coles jerárquico:** ataque y defensa por equipo, ventaja de campo *por liga*, decay
  temporal de un año de semivida y priors que encogen hacia la media a los equipos con pocos
  partidos. La salida es la **distribución completa de marcadores**, y de ahí se derivan el 1X2, el
  over/under, el «ambos marcan» y los hándicaps — no hay un modelo por mercado.
- **Modelo verificado sobre 20.824 partidos reales** de 14 ligas, sin puntuar el holdout:
  **RPS 0.2076** frente a 0.2230 de la referencia, y una calibración del empate que pasó de errar
  5–8 pp a **±1,4 pp**. Contra el Elo anterior gana en el marcador exacto (p = 0,0005) y en el
  hándicap, pero **no de forma medible en el 1X2** (p = 0,054): la mejora está en la forma de la
  distribución de goles, no en acertar quién gana. Está escrito así en la ficha de la app.
- **Tres señales que se probaron y se descartaron** —ataque/defensa *encima del Elo*, racha y
  congestión de calendario— siguen en el código, apagadas y con su interruptor, para que el
  resultado negativo se pueda reproducir en vez de tener que creérselo. Que el ataque/defensa sí
  funcione dentro del Dixon-Coles y no como corrección del Elo no es una contradicción: allí son los
  parámetros que se ajustan, aquí eran un parche multiplicativo sobre un número que ya los resumía.
- **El Elo de respaldo tenía la ventaja de campo de otra época.** El Elo —que solo decide los
  partidos de un recién ascendido, porque el Dixon-Coles aún no lo conoce— usaba +65 puntos por
  jugar en casa y decía victoria local un 46 % de las veces cuando pasaba un 43 %, en las seis
  temporadas y en 11 de 14 ligas. Elegido de nuevo solo con temporadas anteriores a 2025
  (`npm run study:home-elo`): **+35**. En 2025, que no se usó para elegir, el sesgo pasa de
  **−2,6 pp (3,6 errores estándar)** a **+0,9 pp (1,2, ruido)**. El log loss mejora
  (−0,0016) pero sin significación propia (p = 0,21), y así consta en el registro: lo que decide
  es el sesgo medido fuera de muestra, no el log loss. El backtest publicado pasa de 1,0147 a
  **1,0143** de log loss. Afecta a pocos partidos al año, pero caen casi todos en las primeras
  jornadas, que es cuando más se miran.
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

- **Lo que se enseña es casi el precio, y ese precio ahora está bien leído.** El modelo pesa un
  10 % en la mezcla porque, medido, es peor que la línea de cierre. Sin clave de cuotas no hay
  moneyline, así que el «precio» sale de la **línea de hándicap** convertida en probabilidad — y
  esa conversión es, en la práctica, la predicción. Se hacía con la curva del propio modelo, que
  es demasiado plana: con 7 puntos decía **69 %** y el favorito gana el **75 %**; con 10, **76 %**
  contra **82 %**. Ahora es una curva ajustada a los resultados (`npm run study:nfl-spread`):
  walk-forward 2010–2023 sobre 3.781 partidos, con la mezcla encima, **log loss −0,0023**
  (IC95 [−0,0038, −0,0008], p = 0,004). El porcentaje de aciertos no cambia —quién es favorito lo
  decide el signo de la línea, y eso ningún ajuste lo mueve—; cambia **cuánto** se le da, que es
  lo que usan el filtro de confianza, las bandas y cualquier apuesta.
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
- **La ventaja de campo se aprende, no se fija.** Era una constante de 100 Elo ajustada sobre
  todo el archivo —sobre todo partidos anteriores a 2011— y la cancha de la NBA vale hoy mucho
  menos: desde 2021 el modelo decía victoria local un **62,4 %** y pasaba un **55,3 %**, siete
  puntos inflados en **cada** predicción. Ahora se mueve partido a partido con el mismo error que
  los ratings (`npm run study:home-bb`): ~120 Elo en los 80, 78 en 2015, **~43 hoy**. La tasa se
  eligió con temporadas hasta 2020 y se confirmó en 2021+: **log loss −0,0123** (IC95 [−0,0158,
  −0,0085], p = 0,0005) y sesgo local de **−7,0 a 0,0 pp**. Sobre los 86.000 partidos del
  archivo: Brier 0,2044 → **0,2034**, ECE 0,77 → **0,30 pp**, y contra FiveThirtyEight en sus
  58.281 partidos pasa de perder (0,2041 vs 0,2039) a **ganar** (0,2036 vs 0,2039). `verify:data`
  mide ahora el sesgo local de las temporadas recientes en baloncesto, béisbol y NFL: con la
  constante vieja, la NBA falla por nueve errores estándar.
- **La pretemporada, aplicada también en vivo.** La reproducción acerca cada equipo a la media al
  cruzar un verano, pero lo hacía al encontrar el primer partido de la temporada nueva: hasta que
  ese partido estaba en la base, el vivo predecía la jornada 1 con los Elo de las Finales a plena
  fuerza. El mejor equipo salía con 1.786 cuando el modelo mide que debe empezar en 1.700 —unos
  diez puntos de probabilidad contra un rival medio, justo en octubre—. Ahora se aplica en cuanto
  el partido está a más de 60 días del último jugado (la NFL ya lo hacía), y la tarjeta lo dice.
  Y el propio arrastre, revisado con los seis parámetros del modelo (`npm run study:params-bb`,
  elegir ≤ 2020, validar 2021+, Bonferroni): **0,75 → 0,70**, log loss −0,0004 (p = 0,001). Los
  otros cinco ya estaban en su punto. ECE de la NBA: 0,30 → **0,12 pp**.
- **El béisbol, revisado igual y sin cambios.** Ocho parámetros (`npm run study:params-bsb`):
  ninguno mejora fuera de muestra, y dos de los candidatos empeoran. Está apuntado en el registro
  con el resto: un resultado negativo también es un resultado. Pero tenía el mismo fallo de
  pretemporada que la NBA, y peor: Retrosheet publica al acabar cada temporada, así que si la
  fuente en curso (MLB Stats API) no responde, **toda una temporada** se predecía con los ratings
  del octubre anterior a plena fuerza. Simulado prediciendo cada temporada 2016–2025 con los
  ratings congelados de la anterior: log loss 0,68309 sin regresión, **0,68196** con ella. Ahora
  se regresan equipos y abridores una vez por invierno cruzado, la tarjeta dice hasta qué fecha
  llegan los datos, y `verify:data` lo comprueba. (Aun así, 0,682 contra 0,670 con datos al día:
  lo que de verdad importa es que `update-all` traiga la temporada en curso.)
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
- **Modelo calibrado y verificado:** `npm run backtest` mide la exactitud real — **65.3% de
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
- Datos guardados localmente en **SQLite**, en dos ficheros (`data/history.db`, la historia
  reconstruible, y `data/ledger.db`, lo tuyo: apuestas, predicciones registradas, precios
  observados), para no depender de llamadas repetidas a las APIs. Ver
  [docs/BASE_DE_DATOS.md](docs/BASE_DE_DATOS.md).

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

## Actualizar todo (`npm run update-all`)

Los seis deportes en una tirada:

```bash
npm run update-all                   # todo, con cuotas
npm run update-all -- --skip-odds    # solo el histórico, sin gastar cuota
npm run update-all -- --only fb,bb   # solo algunos (fb, tennis, bb, bsb, naf, nhl)
```

```
RESUMEN
  ✅ ⚽ Fútbol           10 s
  ✅ 🎾 Tenis             5 s
  ✅ 🏀 Baloncesto       15 s
  ✅ ⚾ Béisbol          66 s
  ✅ 🏈 NFL               1 s

  5/5 correctos en 98 s.
```

### Por qué un script y no cinco `&&`

* **Un fallo no puede parar a los demás.** Encadenando con `&&`, si la fuente del
  béisbol está caída la NFL no se actualiza — y no porque le pase nada, sino porque iba
  detrás. Aquí cada deporte es independiente: el que falle se anota y se sigue, y el
  código de salida es 1 para que un cron se entere.
* **Hay que saber cuál falló.** Cinco comandos encadenados dejan un muro de salida; esto
  deja una tabla con el comando exacto para repetir solo el que se rompió.
* **El orden no es indiferente.** El fútbol va primero porque es el que más partes tiene
  (histórico, próximos, cuotas y plantillas) y el que más tarda: si algo va a fallar,
  mejor enterarse en el primer minuto.

### La cuota, que es lo que de verdad cuesta

«Actualizar todo» son cinco tiradas contra The Odds API y el plan gratuito son **500
peticiones al mes**. Correrlo varias veces al día lo quema en una semana.

El histórico de resultados cambia una vez por jornada y **no necesita precios**, así que
para el uso diario `--skip-odds` es lo normal. Las cuotas ya se refrescan solas mientras
el servidor está arrancado, con una cadencia que se ajusta al tamaño del plan y que
acelera cuando hay un partido inminente.

Lo que sí cambia a diario son las plantillas y el parte de lesionados:

```bash
npm run update-squads:fb    # mucho más barato que la actualización completa
```

### Un flag que no hacía nada

`--skip-odds` lo aceptaban cuatro de los cinco scripts. El de la NFL no tomaba
argumentos, así que lo recibía, lo **ignoraba en silencio** y pedía cuotas igualmente:
una tirada que se creía gratis gastaba cuota solo ahí. Ahora los cinco lo respetan y el
de la NFL lo dice en su salida.

---

## Tener los datos al día sin hacer nada (`npm run fetch-data`)

Hay un workflow (`.github/workflows/data.yml`) que cada noche reconstruye la base, la
comprueba y la publica comprimida (**9 MB**) en una release rodante. Desde cualquier
clon:

```bash
npm run fetch-data              # la baja si no hay ninguna
npm run fetch-data -- --force   # reemplaza la que haya, conservando tus apuestas
```

De «repositorio recién clonado» a «todos los datos al día» en segundos, en vez de los
~2 minutos y 100 MB de descargas que cuesta `npm run update-all`.

### Las cuotas NO van dentro, y es a propósito

Dos motivos:

* Gastarían cuota de The Odds API **cada noche**, y el plan gratuito son 500 al mes.
* Un precio de hace ocho horas no sirve para nada.

Las cuotas las refresca el propio servidor mientras está arrancado, con una cadencia que
se ajusta al tamaño de tu plan y acelera cuando hay un partido inminente. O sea: **si
tienes el servidor en marcha, no tienes que actualizar cuotas nunca**.

### El repositorio es público, así que la base publicada también

Está bien para datos deportivos —son públicos de origen— y estaría **muy mal** para el
registro de apuestas de alguien. En un runner limpio no hay apuestas, pero «no debería
haber» no es una garantía, así que antes de subir corre `npm run check-publishable`, que
falla si encuentra algo. Distingue los dos motivos, porque no son el mismo:

* **privacidad** — `bets` con filas bloquea la publicación. Es dinero de una persona.
* **integridad** — un `*_prediction_log` con filas significa que alguien arrancó la app
  sobre esa base, o sea que no es una construcción limpia. No filtraría nada delicado;
  bloquea porque indica que la base no es la que se cree.

### Y la descarga se niega a destruir lo tuyo

La base publicada se construye en un runner limpio, así que su tabla `bets` está
**vacía**. Instalarla encima de la tuya borraría tus apuestas — y lo haría en silencio,
porque la app arrancaría perfectamente después.

Por eso `fetch-data` no toca una base existente sin `--force`, y ni con `--force` se
pierde nada: guarda una copia con fecha y **copia tus tablas** (apuestas y track record)
a la base nueva antes de dejarla en su sitio.

Antes de instalar nada valida: SHA-256 contra el publicado, descomprime a un temporal,
lo abre y cuenta filas. Un SQLite truncado **no falla al abrirse** — falla mucho más
tarde, con una consulta cualquiera y un mensaje que no señala a la descarga.

Probado con la release simulada en local: checksum incorrecto, fichero truncado y
release inexistente dejan la base intacta, las apuestas intactas y ningún temporal.

### El cron solo corre desde la rama por defecto

GitHub ejecuta los `schedule` **únicamente desde la rama por defecto** del repositorio.
Mientras este workflow viva solo en una rama de trabajo, la ejecución nocturna no se
dispara: se puede lanzar a mano desde Actions → Datos → «Run workflow», pero el horario
no existe hasta que el fichero llega a la rama por defecto.

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

## El pipeline de noticias (`npm run news`)

Un pipeline que **cambia** las predicciones, no que las decore. Las ausencias entran
antes de calcular los goles esperados, así que mueven el 1X2, el over/under, la rejilla
entera y las props del jugador — y la tarjeta enseña cuánto puso cada una, en goles.

```
texto libre → [Anthropic API] → JSON → emparejar jugador → λ → 1X2, goles, props
```

### Qué se le pide al modelo, y qué no

El feed de plantillas ya da `status` y `chance_next`, y para el 80 % de las notas eso es
toda la información que hay. **Esas no pasan por el modelo**: dos reglas resuelven
«Knee injury - Unknown return date» y «75% chance of playing», y el script dice cuántas
fueron de cada tipo y cuánto costaron las que sí. Un pipeline que manda todo a un LLM
funciona igual y cuesta cincuenta veces más; la diferencia no se ve hasta la factura.

El modelo se reserva para lo que ninguna regla lee: una rueda de prensa («no forzaremos
con Pedri, aunque entrenó ayer»), un once publicado en un tuit, un parte médico escrito
en prosa. Y para una distinción que el feed **no** hace y que importa mucho:

| texto | feed | modelo |
|---|---|---|
| «Has joined Rangers on loan» | `status: u` | `salida`, permanente |
| «Knee injury - Unknown return» | `status: i` | `lesion`, puede resolverse el jueves |

Las dos son «no disponible» para el feed y son cosas muy distintas para el modelo.

La salida va restringida por **structured outputs** (`output_config.format`), así que el
JSON valida por construcción: no hay que limpiar vallas de markdown ni reintentar por
formato. Cada campo del esquema existe porque **cambia una predicción** — no hay
«titular» ni «resumen», porque enseñar un dato que no se usa hace creer que el modelo lo
tiene en cuenta.

```bash
npm run news                                   # las notas del feed
npm run news -- --text "Guardiola confirmó que Rodri no viaja"
npm run news -- --show                         # qué le hacen a cada partido
```

### El emparejado se niega a adivinar

El modelo recibe los nombres de la plantilla y suele acertar, pero «suele» no basta para
algo que mueve una λ. El emparejado es determinista: exacto, luego apellido, y **si dos
jugadores comparten apellido no elige** — la noticia se guarda sin jugador, no mueve nada
y sale marcada. Equivocarse de jugador no da un error, da una predicción distinta que
nadie puede explicar.

### Cuánto vale una ausencia, en goles

No es una opinión sobre el jugador. Es una cadena en la que cada eslabón está medido:

1. La **cuota** del jugador en el once habitual — qué parte de la producción ofensiva y
   de los minutos representa.
2. Los **pesos** de `players.ts` — 0,31 sobre el ataque y 0,38 sobre lo encajado,
   ajustados sobre tres temporadas de alineaciones reales de la Premier con el rival y el
   campo controlados. Es la única señal de este proyecto que le ganó al Elo.
3. La **λ del partido** — el 5 % de ataque no vale lo mismo en un partido de 3,2 goles
   que en uno de 1,9.

El contrafactual es «¿cuánto valdría esto si **sí** jugara?», no «añádelo a la lista de
bajas». La primera versión hacía lo segundo y daba **cero para todos**, porque la
disponibilidad base ya trae aplicadas las bajas que publica la fuente: meter a un
lesionado en la lista de bajas no cambia nada, ya estaba fuera.

Verificado de punta a punta: marcando de baja a un titular del Arsenal, λ pasa de 2,52 a
2,44, el 1X2 local de 76,3 % a 74,5 % y el over 2.5 de 64,4 % a 63,5 %.

### Un cero viene con su motivo

En la instantánea de la primera jornada, Saliba y Timber están lesionados y su impacto
sale **cero** — porque llevan cero minutos, no están en el once observado, y el modelo no
puede saber que eran titulares. Eso se dice en la tarjeta con esas palabras. Un cero sin
explicación se lee como «esto da igual», y aquí significa lo contrario.

Ese diagnóstico destapó un bug de verdad: la cuota de ataque salía de `xgi90`, que es
null por debajo de 270 minutos jugados, así que a principio de temporada el denominador
era **cero** y toda la maquinaria de ausencias estaba apagada sin avisar. Ahora la cuota
usa producción acumulada y se encoge hacia la cuota de minutos cuando aún no hay
producción — el mismo encogimiento que el resto del proyecto.

### Alineación confirmada contra esperada

Hasta una hora antes, quién juega es una suposición. Cuando el club publica el once, la
**diferencia** con lo esperado es la noticia: un titular fijo que no está en la lista es
información que ningún parte médico da, porque los clubes no anuncian «hoy descansa».
Precedencia: lo que marcas tú > el once publicado > los partes.

### Rotación por calendario: avisa, no ajusta

La congestión se midió a nivel de equipo en este proyecto y salió **cero** — jugar cada
tres días no hace peor al equipo de forma medible, porque el entrenador rota y el equipo
rotado sigue siendo bueno. Ese resultado se respeta. Lo que sí cambia con el calendario
es **quién** juega, que es otra cosa: `rotationRisk` ensancha la incertidumbre y avisa,
y **no toca la λ**. Convertirlo en un ajuste de fuerza sería resucitar por la puerta de
atrás un efecto que ya se midió y se descartó.

### El reloj: ¿llegaste antes o después que el mercado?

Cada precio observado se guarda con su hora (`fb_odds_history`, solo cuando cambia), y
cada noticia con la suya. Con las dos series se puede responder la única pregunta que
importa sobre una noticia:

| veredicto | qué significa |
|---|---|
| **noticia-primero** | la línea se movió después. Hubo ventana. |
| **mercado-primero** | la línea ya se había movido. El mercado lo sabía y llegas tarde. |
| **sin-movimiento** | el precio no se movió: no importaba, o nadie la vio. |

El segundo caso es el normal y es incómodo, así que se mide y se enseña. Lo que **no** se
afirma es causalidad: que el precio se mueva después de una noticia no demuestra que se
moviera por ella, y la tarjeta lo dice.

Umbral de 1,5 puntos de probabilidad para contar como movimiento: por debajo de eso el
precio se mueve solo, por redondeo y por qué casas están en la muestra. Un umbral más
bajo llenaría la lista de ruido y siempre habría «un movimiento» cerca de cualquier
noticia — que es como se fabrica una correlación.

### Sin clave, no hay respaldo silencioso

Sin `ANTHROPIC_API_KEY` la extracción de texto libre no funciona y lo dice. No hay un
camino de respaldo con expresiones regulares que rellene el hueco: sería peor y
silencioso, y nadie se enteraría de que la pieza buena lleva un mes sin funcionar. Las
reglas baratas siguen funcionando, porque esas nunca dependieron del modelo.

---
