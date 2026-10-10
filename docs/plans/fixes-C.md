# Arreglos de la revisión del 8 de octubre de 2026 · Lote C (dinero y modelo)

Mismo método: cada hallazgo se reproduce con un test que falla antes de tocar el código; después
se arregla y se cierra con doctor, tests, `verify:data`, `audit`, typecheck, lint, build y
Playwright en verde. Reglas: los holdouts no se tocan, las tablas inmutables no se modifican, los
parámetros de los modelos solo cambian por el registro de experimentos (aquí no cambia ninguno:
todo es dinero, medición y contabilidad).

Lo que se verificó leyendo el código antes de escribir este plan está en cada punto. Dos matices
sobre lo que decía la revisión, con la evidencia: C1 (la «matriz conjunta del mismo partido» no
hace falta porque «Mi selección» solo combina el mercado ganador) y C7 (las dos definiciones de
ROI dan hoy el mismo número; se unifican igual).

## C1 · La combinada infla con ρ = 0,0047

**Verificado.** `picks/parlay.ts` aplica la corrección por pares con la ρ que devuelve
`staking/correlation.ts` para «misma liga y día»: 0,0047, que es el **extremo alto** del intervalo
medido (punto 0,0013, intervalo [−0,0020, +0,0047], indistinguible de cero). Prudente para
DIMENSIONAR (reduce importes en el libro manual), pero en la combinada **multiplica** la
probabilidad conjunta: con dos patas al 10 % el factor es 1 + 0,0047·9 = 1,042 por par, y con
diez patas de la misma jornada (45 pares) ×6,4 antes del tope. La ventaja de la combinada salía
inflada. Sobre la «matriz de marcadores del mismo partido»: `Seleccion.tsx` solo manda patas del
mercado ganador (`opciones` = local/empate/visitante), así que dos patas del mismo partido son
resultados excluyentes del mismo mercado y la conjunta exacta es 0, que es lo que ya hace
(`incompatibles`). No hay otro mercado que combinar; si lo hubiera, haría falta la matriz.

- **Test (falla antes):** dos patas de la misma liga y día al 10 %: la conjunta es el producto
  (0,01), sin inflar, y el vínculo dice que entre partidos distintos se usa ρ = 0; el factor nunca
  pasa de 1; tres patas de la misma jornada: conjunta ≤ producto.
- **Arreglo:** entre partidos distintos ρ = 0 (la ρ del libro manual sigue siendo la prudente para
  dimensionar); el factor se acota a [0, 1] (la corrección solo puede recortar); la etiqueta lo
  dice. Las patas del mismo partido siguen siendo incompatibles.

## C2 · Surebets, steam y referencia mezclan líneas

**Verificado.** `marketAt`/`toPoint` (`odds/snapshots.ts`) hacen la mediana de TODAS las cuotas de
una selección aunque sean de líneas distintas (Más de 2,5 a 1,90 y Más de 3,0 a 2,20 son el mismo
`selection`); `surebetDe` empareja la mejor cuota de cada selección sin mirar la línea (Más de 2,5
con Menos de 3,0 «suma menos de 1»); la referencia afilada compara con la misma mezcla. El
comparador de líneas ya resuelve esto con `deLaLineaMasCotizada` (`odds/lineas.ts`), que la
inteligencia de mercado no usaba.

- **Tests (fallan antes):** (1) `marketAt` con cuotas en dos líneas devuelve el consenso de la línea
  más cotizada, con su `line`; (2) `surebetDe` con Más 2,5 / Menos 3,0 → null, y con las dos
  patas en la misma línea → surebet; (3) el steam no compara puntos de líneas distintas. Al
  reproducir C3 cayó también el test existente de `inteligenciaMercado`: su fixture tenía el punto
  anterior a 110 minutos del último y esperaba steam, que es justo el fallo; ahora lo pone a 50.
- **Arreglo:** `deLaLineaMasCotizada` pasa a `snapshots.ts` (lo reexporta `lineas.ts`) y
  `toPoint` la usa; `surebetDe` empareja solo líneas complementarias (misma |línea|; sin línea,
  como antes); `steamDe` solo mide dentro de la misma línea que el último punto.

## C3 · La ventana de 60 minutos del steam no se aplica

**Verificado.** `steamDe` parte de `base = puntos[n−2]` y recorre hacia atrás mientras los puntos
estén dentro de la ventana; si el penúltimo punto ya está fuera (dos horas antes), la base se
queda en él y el movimiento se mide contra un punto de fuera de la ventana. Un movimiento lento se
señala como steam.

- **Test (falla antes):** dos puntos a 3 h de distancia con 5 pp de diferencia → null.
- **Arreglo:** si no hay ningún punto anterior dentro de la ventana, no hay steam.

## C4 · La deriva compara lo publicado con lo crudo

**Verificado.** `monitoring/series.ts` saca la distribución y el log loss en vivo de
`evaluation/live.ts`, que para fútbol, NFL, NHL y UFC usa `COALESCE(shown_*, prob_*)`: la
probabilidad **publicada** (calibrada y mezclada con el mercado). La referencia es el diagrama del
backtest (`experiments/reliability.json`), construido por `informeComun` con las probabilidades
**del modelo** (sin mezcla). El PSI y los «errores típicos» comparan dos cosas distintas, y el
tenis, el baloncesto y el béisbol (que sí usan `prob_*`) van con otra vara.

- **Test (falla antes):** `predicciones('football')` trae también `pModelo` (= `prob_*`) distinto
  de `p` cuando `shown_*` difiere; `monitorizacion` calcula el PSI con `pModelo`.
- **Arreglo:** `PrediccionEnVivo.pModelo` (lo que dijo el modelo; `p` sigue siendo lo publicado,
  que es lo que miden los segmentos y el diagrama en vivo); la monitorización usa `pModelo` para
  el PSI y el log loss contra el backtest, que es como se midió el backtest.

## C5 · Las estrategias no están congeladas del todo

**Verificado.** `ConfigEstrategia` congela `staking` (bien), pero los topes de grupo
(`cabeEnGrupos` → `limitesConTopePorPartido` → `limitesVigentes()` → `politica().grupos`) se leen
de la política VIGENTE en cada pasada: cambiar la política en Ajustes cambia el comportamiento de
una estrategia ya creada, que es justo lo que «no se edita» quería impedir. `strategy_bets` no
guarda `policy_version_id` (el banco principal sí). Y el tope por equipo del 3 % recorta la
PRIMERA apuesta de una estrategia con `maxPerEvent` > 3 %: el tope de equipo existe para dos
partidos abiertos del mismo equipo, no para que una sola apuesta no llegue a su propio tope por
partido.

- **Tests (fallan antes):** `configDe` guarda `grupos` (los dos topes) y cambiar la política
  después no cambia lo que usa la estrategia; una apuesta de estrategia lleva `policy_version_id`;
  con `maxPerEvent` 5 % y un solo partido, la primera apuesta no se recorta al 3 %.
- **Arreglo:** `ConfigEstrategia.grupos` congelado al crear (las antiguas, sin él, usan la
  política de entonces y así se dice); migración 21: `strategy_bets.policy_version_id`; el tope
  de equipo/jugador nunca es menor que el tope por partido del banco.

## C6 · La simulación de temporada: «pendiente» = sin resultado

**Verificado.** `calendarioGuardado(…, hoy)` toma como pendientes los partidos del calendario con
fecha ≥ hoy: uno jugado antes de su fecha (o con la fecha de la fuente en otra zona horaria) se
simula ADEMÁS de contar en la clasificación, y uno aplazado (fecha pasada, sin resultado) deja de
contarse. Pendiente tiene que ser «sin resultado emparejado», no «fecha futura».

- **Test (falla antes):** con un partido del calendario ya jugado (mismo local, visitante y fecha
  en los resultados) y otro con fecha pasada sin resultado, `pendientes` deja fuera al jugado y
  dentro al aplazado.
- **Arreglo:** `pendientesDe(calendario, jugados)`: fuera lo que tiene resultado con el mismo
  par y fecha (±1 día, por las zonas horarias; sin fecha, por par; cada resultado descuenta un
  solo partido, por los cruces que se repiten en la NBA o la MLB); el calendario se lee entero
  (sin filtrar por hoy). Un calendario reconstruido ya nace sin lo jugado.

## C7 · Dos definiciones de ROI

**Verificado.** `beneficio / arriesgado` (banco de papel, estrategias, histórico, `betting.ts`,
segmentos) y `beneficio / n` (`football/clv.ts`, `evaluation/walkforward.ts`). Hoy dan el mismo
número porque las dos últimas apuestan una unidad fija (arriesgado = n), pero son dos fórmulas que
divergen en cuanto alguien cambie el importe. Un helper (`evaluation/roi.ts`) para todos, con el
arriesgado explícito.

- **Test (falla antes):** `roiDe({ beneficio, arriesgado })`; y los ficheros que calculan ROI lo
  importan (comprobación sobre el fuente).

## C8 · CLV con nada observado después de apostar

**Verificado.** `captureClosing` (banco) y `cierreEstrategias` toman como cierre la última
observación anterior al inicio, sin mirar si es POSTERIOR a la apuesta: si nadie volvió a pedir
cuotas, el «cierre» es el mismo snapshot con el que se apostó (CLV 0) o uno anterior. Un CLV así
no mide nada.

- **Test (falla antes):** apuesta hecha con la última observación y ninguna después → el cierre
  se queda a NULL (y no se fija nunca con ese dato).
- **Arreglo:** el cierre exige una observación posterior a `placed_at`.

## C9 · El segmento «ganó el visitante»

**Verificado.** `dimensionesPrediccion` segmenta por `resultado` («ganó el local/visitante»): el
desenlace. Dentro de «ganó el visitante», el acierto es la fracción de predicciones que favorecían
al visitante: describe lo que pasó, no selecciona nada antes del partido. Las apuestas ya
segmentan por el lado de la apuesta (`lado`).

- **Test (falla antes):** las predicciones tienen `lado` (el lado que favoreció el modelo: «al
  local», «al empate», «al visitante»; tenis «al primero/segundo») y no `resultado`.
- **Arreglo:** `resultado` → `lado`, con la misma forma que en las apuestas.

## C10 · Las apuestas de tenis se liquidan por nombre

**Verificado.** `liquidar` compara el nombre actual de `players` con `paper_bets.selection` (el
nombre que se enseñó, que viene de `prediction_log.p1_name/p2_name`): si difieren (acento, inicial,
renombrado), la apuesta se da por PERDIDA. Y si el nombre no cuadra con ninguno, también perdida.

- **Test (falla antes):** el jugador se llama «Carlos Alcaraz» en `players` y la apuesta dice
  «C. Alcaraz» (el nombre del registro): gana si ganó; una selección que no es ninguno de los dos
  no se liquida como perdida (se anula).
- **Arreglo:** el lado apostado se resuelve contra los nombres del REGISTRO (`p1_name`/`p2_name`)
  y se liquida por `winner_id` contra `p1_id`/`p2_id`; sin lado reconocible → `void`.
