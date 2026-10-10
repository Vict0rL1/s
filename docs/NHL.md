# NHL

El sexto deporte. Estuvo en sombra desde la Fase 8 y **se publicó en octubre de 2026** al pasar la
misma prueba que los demás (abajo). Está en `SPORT_IDS` (`server/src/sports.ts`): pestaña propia,
Hoy, ¿Acertó?, Destacados, registro de predicciones, banco de papel, estrategias, capa de confianza,
archivo y búsqueda. El plan y el diario están en [plans/nhl-ufc.md](plans/nhl-ufc.md).

## Datos

`npm run update-data:nhl` hace cuatro cosas, y cada ejecución queda en `ingestion_runs`:

1. **Resultados**: los calendarios por temporada de sportsdataverse en GitHub (copia de la API de la
   NHL), a `nhl_games`. Con el archivo ya bajado, solo las dos últimas temporadas; sin él, de la
   2009-10 a la actual (`--desde`/`--hasta` para otras). La fuente trae el marcador final pero no
   si hubo prórroga o tanda: `final_period` queda vacío (no se supone «REG»). El marcador final de
   la NHL ya cuenta la prórroga o la tanda como un gol, que es como cuenta los totales el modelo.
2. **Equipos**: las 32 franquicias (y las tres antiguas, ATL, PHX y ARI) a `nhl_teams`, con el
   nombre completo con el que las nombran las casas (`server/src/nhl/equipos.ts`).
3. **Calendario**: los partidos por jugar de la temporada en curso, con su hora en UTC, a
   `nhl_upcoming` (los próximos 30 días). Con esto la pestaña funciona sin clave de cuotas.
4. **Cuotas**, si hay `ODDS_API_KEY` y no se pasa `--skip-odds`: The Odds API, `icehockey_nhl`,
   mercados ganador (con prórroga y tanda: así se paga el moneyline en la NHL) y total de goles; dos
   créditos por región, y ninguno fuera de temporada (lo decide el listado gratuito de `/sports`).
   La fila con precio sustituye a la del calendario del mismo partido. Las cuotas se refrescan
   también solas con el resto de deportes mientras el servidor está arrancado.

Un nombre de una casa se resuelve por el nombre completo, un alias conocido («Utah Hockey Club»), el
apodo («Rangers») o la ciudad **solo si es de un equipo** (con «New York» no se adivina). El que no
se resuelve se queda sin id y sin predicción.

**Marcadores de relleno.** Nueve temporadas del calendario (2009-10 a 2012-13 y 2018-19 a 2022-23)
traen un marcador falso: todos los partidos «3-2», o el local que gana siempre. La ingesta lo detecta
y toma los goles de las «team box» de la misma fuente, cruzadas por orden de fecha **solo si los dos
equipos coinciden en todos los partidos**; si no cuadra uno, la temporada no se guarda y la ingesta
lo dice. Las nueve cruzaron enteras.

`npm run update-data:nhl -- --fuente nhl --desde 2015-10-01 --hasta 2025-06-30` usa en cambio la API
web pública de la NHL (`api-web.nhle.com`), semana a semana, que sí dice cómo acabó cada partido.

`update-results` y `update-all` incluyen la NHL; el trabajo programado de resultados también.

## Modelo

Un Elo de equipo (K 6, ventaja de campo de 35 puntos y multiplicador por diferencia de goles, como
el resto de deportes de equipo) y, encima, una Poisson por equipo. El reparto de los goles de la
liga entre los dos equipos se busca para que la probabilidad de ganar —prórroga y tanda incluidas,
a la mitad de la fuerza del Elo— sea exactamente la del Elo. De ahí salen, sin contradecirse:

- el **ganador** con prórroga y tanda (el número grande de la tarjeta),
- el partido **a 60 minutos**: gana el local, empate (va a la prórroga) o gana el visitante,
- el **total de goles del acta** (la prórroga o la tanda suman uno), en la línea de la casa o, sin
  ella, en la media línea más cercana a lo esperado; con línea entera se da también el nulo,
- los **marcadores** más probables a 60 minutos.

El Elo no se guarda en una tabla: se recorre el archivo entero (22.000 partidos, milisegundos) con los
mismos `actualizar` y parámetros que el backtest y se guarda en memoria hasta que cambia `nhl_games`.
Los Elo no se pliegan entre franquicias que se mudaron (ATL→WPG, ARI→UTA): así se midió.

**Lo que no hace, y la tarjeta lo dice.** No conoce al portero titular (lo que más mueve un partido
de hockey), ni las bajas, ni los partidos seguidos. **No se mezcla con el mercado ni se calibra**: en
otros deportes el peso de la mezcla y el calibrador se ajustaron con cuotas históricas, y de la NHL
no hay ninguna alcanzable. La diferencia con la casa se enseña como *desacuerdo*, no como valor. La
banda de fiabilidad (±4,7 pp con una temporada completa detrás de cada equipo) es a juicio, no
medida contra el mercado. El total de goles sale de una media de la liga fija repartida por el Elo:
dice casi lo mismo en todos los partidos, así que está en la tarjeta pero no en «lo más probable».

## Evaluación: la prueba con la que se publicó

`npm run backtest:nhl` recorre los partidos en orden, predice cada uno con el Elo de antes de
jugarlo y lo puntúa (log loss, Brier, acierto y ECE) contra dos referencias: «siempre el local» con
su tasa histórica hasta ese día y un Elo básico sin margen ni Poisson. Los primeros 300 partidos
son calentamiento. **El holdout final empieza en la temporada 2025-26** (`experiments/holdout.ts`):
el Elo sigue el calendario por ella, pero no se puntúa ni se enseña.

Con 21.960 partidos (octubre de 2026), sobre los 20.214 puntuables de 2009-10 a 2024-25:

| | Log loss |
|---|---|
| Modelo | **0,6731** (Brier 0,2402, acierto 57,8 %, ECE 1,45 pp) |
| Siempre el local | 0,6896 · el modelo, −0,0165 [−0,0193, −0,0135] |
| Elo básico | 0,6805 · el modelo, −0,0073 [−0,0090, −0,0057] |

Gana a las dos con el intervalo lejos del cero: **pasó la prueba de publicación**. No hay
comparación con el mercado (no hay cuotas históricas): el registro en vivo la irá teniendo, partido
a partido, desde que haya clave.

El mismo comando escribe lo que escriben los otros cinco backtests de referencia: la capa común de
métricas (`experiments/backtest_metrics.json`), la calibración que lee el módulo de riesgo, con las
bandas de acierto por umbral (`experiments/calibration.json`, sin veredicto contra el mercado), y el
walk-forward por medias temporadas (`experiments/walkforward/nhl.json`, 31 periodos).

`npm run backtest:nhl -- --ajustar [--registrar]` prueba una rejilla de K, ventaja de campo y vuelta
a la media entre temporadas (elegida en 2009-10 → 2023-24, validada en la 2024-25) y los goles de la
liga tomados de la última temporada. Ninguno mejora de forma demostrable a los valores de partida;
los dos experimentos están en el registro como no concluyentes.

La evaluación sale en **Confianza › Diagnóstico** («NHL: la prueba con la que se publicó») y en
`GET /api/nhl/backtest`.

## En la app

- **Pestaña NHL** (`/nhl`): Hoy, lo más probable (solo el ganador), la tabla del día, los partidos
  por día con su tarjeta, el historial en vivo y la clasificación por Elo.
- **Registro** (`nhl_prediction_log`, libro mayor, migraciones 16 y 17): la predicción se escribe la
  primera vez que se sirve y no se reescribe; los triggers impiden borrarla o cambiar lo que dijo.
  Cuando un partido pasa de la fila del calendario a la de la casa, solo se mueve el puntero
  (`upcoming_id`), que es como lo encuentran Hoy, Destacados y el banco. La clave es la fecha en
  Nueva York y los dos equipos.
- **Banco de papel y estrategias**: apuestan al ganador con cuotas reales, repreciando el mercado con
  la cuota que se va a apostar (como todos los deportes); no hace falta que la predicción tuviera
  precio al registrarse. Liquidación sin empates (la prórroga y la tanda deciden siempre).
- **Sin simulación de temporada**: el calendario se guarda solo para las próximas semanas y la
  clasificación de la NHL reparte un punto por la derrota en la prórroga, que el archivo no dice. La
  página de liga enseña la clasificación por Elo en su lugar.
- **Escudos neutros**: el conjunto abierto de colores de equipos pone a casi todos los de la NHL en
  negro y no tiene a Seattle ni a Utah; no se inventa un color.
- El **doctor** la cuenta con su temporada (octubre a junio), sus cuotas y su archivo; `npm run
  audit` comprueba que cada predicción cuadra (ganador, 60 minutos y total suman 1).
