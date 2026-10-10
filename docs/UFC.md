# UFC

El séptimo deporte. Estuvo en sombra mientras su primer modelo (un Elo de luchador) no ganaba a algo
tan simple como «el de mejor récord». **Se publicó en octubre de 2026** con un segundo modelo que sí
pasa la misma prueba que los demás deportes, registrado antes de calcularlo
([plans/ufc-combinado.md](plans/ufc-combinado.md)). Está en `SPORT_IDS` (`server/src/sports.ts`):
pestaña propia, Hoy, ¿Acertó?, Destacados, registro de predicciones, banco de papel, estrategias,
capa de confianza, archivo y búsqueda. Ya no hay interruptor `deportes.ufc`.

## Datos

`npm run update-data:ufc` hace dos cosas, y cada ejecución queda en `ingestion_runs`:

1. **El archivo**: los cuatro CSV que publica `Greco1899/scrape_ufc_stats` en GitHub (rascados de
   ufcstats.com y actualizados cada semana): eventos con su fecha, resultados de las peleas,
   luchadores y sus medidas, a `ufc_events`, `ufc_fighters` y `ufc_fights`. Todo en una transacción:
   si falta un fichero o no trae ninguna pelea legible, no se escribe nada.
2. **Las peleas que vienen**, si hay `ODDS_API_KEY` y no se pasa `--skip-odds`: The Odds API,
   `mma_mixed_martial_arts`, mercado ganador (un crédito por región). La fuente del archivo solo trae
   peleas ya disputadas, así que **sin clave no hay cartelera**, y la pestaña lo dice así. Con el
   servidor arrancado, las cuotas se refrescan solas con las del resto de deportes.

Lo que no se inventa:

- **Nombres ambiguos.** Las peleas solo traen nombres, y algunos los comparten varios luchadores
  (en octubre de 2026, 9 nombres y 52 peleas). Esas peleas se guardan sin atribuir (`ambigua`), no
  se puntúan ni mueven el Elo de nadie.
- **Peleas sin evento con fecha** (27): se descartan y se cuentan.
- **Medidas que no constan** («--»): NULL.

Con el archivo de octubre de 2026: 8.923 peleas guardadas en 791 eventos (la última, la UFC 332 del
3 de octubre de 2026) y 4.628 luchadores.

**El orden de la fuente no es información.** Hasta ~2009 la fuente pone siempre primero al ganador;
después, la esquina roja. Ni el modelo ni las referencias lo usan: los dos luchadores se ordenan por
su id de ufcstats, y un test comprueba que dar la vuelta a todas las peleas no cambia ni una
predicción. Dentro de un evento, la fuente lista la estelar primero; las peleas se recorren de la
primera a la estelar (`orden`).

### Qué peleas de la casa son de la UFC

La clave del proveedor es la de **todo el MMA**: UFC, PFL, Bellator… y los eventos no dicen de qué
organización son. Lo que sí se sabe es quién ha peleado en la UFC. Una pelea se considera de una
cartelera de la UFC si, a menos de 12 horas de su hora, hay al menos 3 peleas con los dos luchadores
ya en la UFC (`config/ufc.json`). Lo demás se descarta y se cuenta (la pestaña dice cuántas). Dentro
de una cartelera puede haber un debutante: la pelea se enseña, **sin número**, y la tarjeta dice por
qué.

Un nombre de la casa se resuelve a un luchador **solo por coincidencia exacta** tras quitar tildes,
mayúsculas, puntos, guiones y los sufijos «Jr.», «Sr.», «II»…; nunca por parecido. Un nombre que
comparten varios se queda sin id.

**A y B.** Las tablas de la UFC usan los nombres de columna de los deportes de equipo (`home_*`,
`away_*`) para que las piezas comunes las lean igual, pero **no hay local**: A es el luchador de id
de ufcstats menor, no el que la casa puso primero. Así, si la casa da la vuelta a los dos entre una
actualización y otra, la pelea es la misma fila con las cuotas en el mismo lado.

## Modelo

Una **regresión logística sin término independiente** (simétrica: dar la vuelta a los dos da la
vuelta a la probabilidad) sobre cinco diferencias entre los dos luchadores, todas con lo que se sabía
antes de la pelea (`server/src/ufc/combinado.ts`):

| Rasgo | Qué es | Peso (ajuste vigente) |
|---|---|---|
| `elo` | la diferencia de Elo de luchador (K 48, debutantes ×1,5 sus cinco primeras peleas), en logit | 0,653 |
| `record` | logit del récord suavizado (Laplace) de uno menos el del otro | 0,146 |
| `edad` | diferencia de edad el día de la pelea, por década | −0,698 |
| `alcance` | diferencia de alcance, por 10 cm | 0,093 |
| `experiencia` | ln(1 + peleas en la UFC) de uno menos el del otro | 0,117 |

Penalización L2 fija (λ = 1). Los pesos se ajustan con **todas las peleas decididas anteriores al
holdout** (8.288 en octubre de 2026); el holdout (2026 en adelante) no entra ni para ajustar. Lo que
falta (una fecha de nacimiento, un alcance) vale 0: que falte depende en parte de cuánto peleó
después el luchador, así que no se usa como rasgo.

El Elo no se guarda en una tabla: se recorre el archivo entero con el **mismo** `recorrer` del
backtest y los rasgos salen de la **misma** función (`rasgosDe`); se guarda en memoria hasta que
cambia el archivo. Lo que se publica es exactamente lo que se midió.

**Lo que no hace, y la tarjeta lo dice.** Solo sabe lo hecho en la UFC: un veterano de otra
organización empieza como un debutante. No conoce lesiones, cambios de categoría ni el corte de
peso. **No se mezcla con el mercado ni se calibra**: no hay cuotas históricas de la UFC alcanzables
con las que medir esa mezcla, así que la diferencia con la casa se enseña como *desacuerdo*, no como
valor. La banda de fiabilidad es a juicio (por las peleas detrás del Elo de cada uno: ±6,7 pp con
diez cada uno), no medida contra el mercado.

## Evaluación: la prueba con la que se publicó

`npm run backtest:ufc` recorre las peleas en orden y predice cada año con una logística ajustada
**solo con los años anteriores** (walk-forward): toda predicción puntuada es fuera de muestra. Se
puntúan victorias de peleas atribuidas, tras 500 peleas de calentamiento. **El holdout final empieza
en 2026** (`experiments/holdout.ts`): el Elo sigue el calendario por él, pero no se puntúa ni ajusta
nada. La validación es 2025.

Cuatro referencias, todas simétricas y con lo visto hasta la pelea anterior: moneda al aire; el que
lleva más peleas en la UFC; el de mejor récord en la UFC (suavizado); un Elo básico (K 32).

**La regla para publicar** (la misma que antes): ganar a las cuatro, pelea a pelea con bootstrap
emparejado, con el intervalo por debajo de cero, **en todo lo puntuable y en 2025 por separado**.

### Primer intento: el Elo solo (no pasó)

Todo lo puntuable (7.799 peleas): 0,6802; contra «mejor récord» −0,0028 [−0,0056, +0,0000]; en 2025,
+0,0038 [−0,0088, +0,0171]. Se quedó en sombra. Los dos experimentos están en el registro.

### Segundo intento: la logística (pasó)

Plan escrito y subido **antes** de calcular: dos candidatos fijos (C1 Elo + récord; C2 los cinco
rasgos), elección solo con el entrenamiento, la prueba una vez. El entrenamiento eligió C2 (0,66766
frente a 0,67955).

Todo lo puntuable, sin holdout (7.799 peleas): **0,6662** (Brier 0,2367, acierto 59,5 %, ECE
0,48 pp).

| Referencia | Log loss | Δ modelo − referencia [IC 95 %] |
|---|---|---|
| Moneda al aire | 0,6931 | −0,0269 [−0,0321, −0,0216] |
| Más peleas en la UFC | 0,6944 | −0,0281 [−0,0331, −0,0230] |
| Mejor récord en la UFC | 0,6830 | −0,0168 [−0,0211, −0,0124] |
| Elo básico | 0,6842 | −0,0180 [−0,0221, −0,0139] |
| Elo de luchador solo | 0,6802 | −0,0140 [−0,0179, −0,0103] |

Solo 2025 (501 peleas): **0,6454**; contra «mejor récord» −0,0271 [−0,0435, −0,0110], contra el Elo
solo −0,0309 [−0,0461, −0,0157]. **Pasa.**

Comprobado después (sin cambiar la elección): el peso de la edad es estable en cada ajuste anual
desde 2007 (−0,56 a −0,68 por década); **barajar las fichas entre luchadores devuelve el log loss
al del Elo solo** (0,6804), así que la ganancia sale de la ficha de cada uno y no de un artificio; y
el más joven gana más cuanto mayor es la diferencia (52 % con menos de 2 años, 63 % con más de 6).

El mismo comando escribe lo que escriben los otros seis backtests de referencia: la capa común de
métricas (`experiments/backtest_metrics.json`), la calibración con las bandas de acierto por umbral
(`experiments/calibration.json`, sin veredicto contra el mercado) y el walk-forward por medio año
(`experiments/walkforward/ufc.json`, 41 periodos). `-- --combinado [--registrar]` repite la prueba;
`-- --ajustar [--registrar]`, la del primer intento.

La evaluación sale en **Confianza › Diagnóstico** («UFC: la prueba con la que se publicó») y en
`GET /api/ufc/backtest`. La regresión nocturna la vigila con una tolerancia de 0,004.

## En la app

- **Pestaña UFC** (`/ufc`): lo más probable (solo el ganador), la tabla del día, las peleas por día
  con su tarjeta y la clasificación por Elo de los luchadores en activo (una pelea en los dos últimos
  años; todas las categorías juntas, porque el Elo no las separa).
- **Tarjeta de pelea**: A vs B, el ganador a dos vías, **lo que aporta cada rasgo** en puntos de
  probabilidad (cuánto cambiaría el número sin él), los dos luchadores lado a lado (Elo, récord,
  edad, alcance, altura, guardia, última categoría y pelea, forma), el cara a cara y la casa.
- **Ficha de luchador** (`/luchador/:id`): Elo y puesto, récord y ficha, la historia de su Elo, sus
  diez últimas peleas (con método y asalto) y las próximas con su probabilidad. Las páginas de liga
  y de equipo de la UFC llevan a la pestaña y a esta ficha.
- **Registro** (`ufc_prediction_log`, libro mayor, migraciones 18 y 19): la predicción, con sus cinco
  rasgos, se escribe la primera vez que se sirve y no se reescribe; los triggers impiden borrarla o
  cambiar lo que dijo. Si la casa cambia el id del evento, solo se mueve el puntero (`upcoming_id`).
  El resultado llega del archivo (que la fuente actualiza cada semana: puede tardar unos días), con
  los dos luchadores en cualquier orden.
- **Banco de papel y estrategias**: apuestan al ganador con cuotas reales, repreciando el mercado con
  la cuota que se va a apostar. **El empate devuelve la apuesta y el «sin resultado» la anula**, como
  el ganador a dos vías de las casas; ¿Acertó? no puntúa ninguno de los dos.
- **¿Acertó?** reconstruye también las peleas recientes del archivo que la app no llegó a enseñar,
  con los rasgos de antes de cada una y los pesos ajustados antes del holdout (se miran; no ajustan
  nada).
- **Sin simulación de temporada**: la UFC no tiene temporada ni clasificación de liga.
- El **doctor** la cuenta con sus cuotas y su archivo (todo el año, una cartelera casi cada semana);
  `npm run audit` comprueba sobre peleas reales que cada predicción suma 1, es simétrica, que los
  aportes de los rasgos suman el logit y que el récord de la ficha cuadra con las peleas del Elo.
