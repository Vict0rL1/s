# ⚽⚾🏀🎾 Sports Predictor

Aplicación web + API REST para **predecir resultados deportivos** combinando historial
partido a partido, **ratings Elo**, forma reciente y **odds de casas de apuestas**.

Cuatro deportes, en **pestañas separadas** (nunca mezclados):

- **⚽ Fútbol** — las principales ligas del mundo, cada una en su **sub-pestaña**: Premier League,
  LaLiga, Bundesliga, Serie A, Ligue 1, Eredivisie, Primeira, Championship, MLS, Liga MX,
  Brasileirão, Argentina y Champions. **1X2** (con el empate como opción de primera), goles
  esperados, over/under 2.5, ambos marcan y marcadores probables.
  Ver [docs/FOOTBALL.md](docs/FOOTBALL.md).
- **⚾ Béisbol** — MLB (y NPB, KBO y universitario con probabilidades de mercado). El deporte donde
  **un solo jugador anunciado el día antes**, el lanzador abridor, mueve más el pronóstico que nada
  salvo los propios equipos — y puedes cambiarlo tú. Ganador, total, línea de carreras (±1.5) y
  rejilla de marcadores, todo de la misma distribución.
  Ver [docs/BASEBALL.md](docs/BASEBALL.md).
- **🏀 Baloncesto** — NBA, WNBA, NCAA (M y F), EuroLeague y NBL: Elo por equipo con ventaja de
  campo, margen de puntos y descanso, más **diferencia esperada (spread)** y **total de puntos**.
  Ver [docs/BASKETBALL.md](docs/BASKETBALL.md).
- **🎾 Tenis** — ATP y WTA singles: Elo por superficie, forma, head-to-head, marcador por sets.
  Ver [docs/MODEL.md](docs/MODEL.md).

El modelo es **explicable, no una caja negra**: cada señal se expresa en puntos Elo y se
muestra lado a lado con la probabilidad implícita del mercado, incluyendo la detección de
posible *value* cuando el modelo discrepa de las cuotas.

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

- **El lanzador abridor como pieza central.** En ningún otro de los cuatro deportes un solo
  jugador pesa tanto, y —a diferencia de una alineación de fútbol— **se anuncia el día antes**, así
  que el modelo puede tenerlo. Cada abridor lleva una razón de supresión de carreras ajustada por
  rival, y si sabes quién lanza (o lo han cambiado) **lo eliges tú y se recalcula todo**.
- **Las carreras no son Poisson y aquí no se finge que lo sean.** Una entrada acaba con tres outs,
  no con el reloj, así que las entradas grandes se agrupan: media 4,47 carreras, varianza 9,49. Una
  binomial negativa lo recoge; usar Poisson cuesta 1,3 puntos de acierto en el over/under.
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

## Qué incluye — 🏀 Baloncesto

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
| Histórico ATP | [Tennismylife `TML-Database`](https://github.com/Tennismylife/TML-Database) | Gratis, sin API key, partido a partido desde 1968 hasta la temporada actual, con superficie, ronda, sets, estadísticas de saque/quiebre **y el ranking oficial de cada jugador en cada partido**. Mismo formato de columnas que el dataset clásico de Jeff Sackmann. |
| Histórico WTA | [tennis-data.co.uk](http://www.tennis-data.co.uk/alldata.php) | Los repos `JeffSackmann/tennis_atp` y `tennis_wta` dejaron de estar accesibles (404) y TML solo cubre ATP, así que la WTA viene de aquí: un `.xlsx` por temporada, gratis y sin API key, con superficie, ronda, marcador set a set, ranking y puntos. **Además trae las cuotas de cierre de cada partido.** No tiene estadísticas de saque. |
| Cuotas históricas | [tennis-data.co.uk](http://www.tennis-data.co.uk/alldata.php) | Cuotas de cierre partido a partido (promedio entre casas). Es lo que permite medir de verdad si el modelo le gana al mercado — ver `npm run backtest -- --market`. |
| Datos de jugador | Incluidos en el histórico | Ranking oficial + puntos, país y mano. (El ATP Tour no ofrece API pública, y hacer scraping de su web sería frágil y de legalidad dudosa.) |
| Odds | [The Odds API](https://the-odds-api.com) | Cuotas head-to-head de partidos próximos, **de tenis y de baloncesto**, con la misma key. Plan gratuito (500 req/mes). |
| Resultados de baloncesto | [ESPN API pública](https://site.api.espn.com) | Gratis y sin key. Cubre NBA, WNBA y NCAA (M y F). |
| Histórico NBA profundo | [FiveThirtyEight `nba-elo`](https://github.com/fivethirtyeight/data/tree/master/nba-elo) | 59.008 partidos reales 1946–2015. Con esto se **ajusta y valida** el modelo de baloncesto; termina en 2015, así que nunca es la fuente de los ratings de hoy. Detalles en [docs/BASKETBALL.md](docs/BASKETBALL.md). |
| Fútbol: resultados + cuotas 1X2 | [football-data.co.uk](https://www.football-data.co.uk) | Fuente principal de fútbol: temporadas actuales de las grandes ligas **con cuotas de cierre 1X2**. |
| Fútbol: histórico para ajustar | [footballcsv](https://github.com/footballcsv) | ~20 temporadas de Inglaterra, España y Alemania en GitHub. Es con lo que se ajustó y validó el modelo. |
| Fútbol: plantillas y lesionados | [vaastav/Fantasy-Premier-League](https://github.com/vaastav/Fantasy-Premier-League) | Solo Premier League: minutos, goles y asistencias esperados por 90, y el parte de bajas del día. Dominio público, sin key. |
| Béisbol: histórico **con abridores** | [Retrosheet](https://www.retrosheet.org) vía [chadwickbureau/retrosheet](https://github.com/chadwickbureau/retrosheet) | 37.262 partidos de MLB (2010–2025) con el abridor de cada uno. El marcador se cuenta de las jugadas y se verifica con `npm run verify:bsb`. |
| Béisbol: temporada en curso + abridores anunciados | [MLB Stats API](https://statsapi.mlb.com) | Gratis y sin clave. Retrosheet publica al acabar la temporada, así que sin esto los Elo irían un año atrasados. |

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
npm run dev      # levanta API (:4000) + frontend (:5173)
```

Abre **http://localhost:5173**. Elige ATP/WTA y un torneo (Wimbledon, US Open…), verás los
próximos partidos con la predicción del modelo y las odds lado a lado.

> El seed usa **datos sintéticos** (nombres reales, partidos simulados) para que la app
> funcione end-to-end sin conexión. El badge "datos demo" lo indica. Reemplázalo con datos
> reales usando `npm run update-data`.

---

## Odds reales y partidos próximos (The Odds API)

Los partidos próximos **reales** (los que se juegan hoy/esta semana) y sus cuotas vienen de
The Odds API. Sin key, la app muestra un demo con partidos de ejemplo.

1. Regístrate gratis en **https://the-odds-api.com** y copia tu API key (botón *Get API Key*).
   El plan gratuito da 500 requests/mes.
2. En tu archivo `.env`:

   ```bash
   ODDS_API_KEY=tu_clave_aqui
   ODDS_REGIONS=eu,uk
   ```

   (NUNCA subas tu `.env` — está en `.gitignore`.)
3. Ejecuta `npm run update-data`. La ingesta **descubre automáticamente los torneos de tenis
   activos** en ese momento (Grand Slams, Masters/1000, 500…) y trae sus partidos, así aparece
   lo que realmente se juega hoy — no una lista fija.

### Que se actualice solo

Con la key configurada, el servidor **refresca las odds automáticamente** mientras corre
(al arrancar y cada `AUTO_REFRESH_MINUTES`, 6 h por defecto). También puedes pulsar
**↻ Actualizar** en el dashboard para refrescar al instante. La cabecera muestra la hora de la
última actualización.

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
| `npm run backtest:fb` | **Fútbol**: mide el modelo con RPS y calibración del empate |
| `npm run build` | Build de producción del frontend + typecheck del backend |
| `npm run typecheck` | Chequeo de tipos de ambos workspaces |

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

## API REST (puerto 4000)

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

## Estructura del proyecto

```
config/        tours.json + tournaments.json + basketball.json + football.json
data/          SQLite + datos crudos + dataset seed
docs/          MODEL.md (tenis) · BASKETBALL.md · FOOTBALL.md · BASEBALL.md
server/
  src/            tenis: ingesta, modelo Elo, API
  src/basketball/ baloncesto: ingesta, modelo, backtest, track record propios
  src/football/   fútbol: ingesta, modelo Poisson, backtest con RPS, track record
web/
  src/components/            tenis
  src/components/basketball/ baloncesto
  src/components/football/   fútbol (con sub-pestañas por liga)
```

Los tres deportes están separados a propósito en todas las capas —tablas, modelo, endpoints y
pestaña— porque discrepan justo en los campos que un modelo necesita: el tenis tiene superficie y no
tiene campo propio; el baloncesto tiene cancha y margen de puntos; el fútbol tiene **empate** y
mercados de goles. El razonamiento está en [docs/BASKETBALL.md](docs/BASKETBALL.md) y
[docs/FOOTBALL.md](docs/FOOTBALL.md).

## Cómo funciona el modelo

Fútbol: **[docs/FOOTBALL.md](docs/FOOTBALL.md)** · Béisbol: **[docs/BASEBALL.md](docs/BASEBALL.md)** · Baloncesto: **[docs/BASKETBALL.md](docs/BASKETBALL.md)** ·
Tenis: **[docs/MODEL.md](docs/MODEL.md)** para la explicación completa del cálculo del Elo, cómo
se combinan las señales y las limitaciones. La lógica también está comentada en el código
(`server/src/model/`).
