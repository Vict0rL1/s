# Sports Predictor — el prompt completo

Este documento es dos cosas a la vez:

1. **El encargo**, escrito de forma que alguien (o un modelo) pueda reconstruir la
   aplicación entera desde cero.
2. **El registro de lo que se hizo**, incluidos todos los errores encontrados y
   corregidos, y las cosas que se midieron y se **rechazaron**.

Escrito a partir del repositorio, no de memoria: 84 commits, 162 ficheros de servidor
(48.651 líneas), 52 de frontend (16.051 líneas), 2.751 líneas de README.

---

# PARTE 1 — EL PROMPT

> Construye una aplicación web en español para predecir resultados deportivos y analizar
> apuestas, con seis pestañas: ⚽ Fútbol, 🏀 Baloncesto, ⚾ Béisbol, 🏈 NFL, 🎾 Tenis y
> 🎟️ Apuestas.
>
> **La regla que gobierna todo el proyecto: nada se publica sin medirlo, y lo que no
> mejora se borra o se apaga con el motivo escrito al lado.** Un modelo elegante que
> pierde contra el que ya había no se publica. Una señal que no separa se borra. Una
> comprobación que no puede fallar no es una comprobación.
>
> **La segunda regla: un fallo nunca puede parecer un acierto.** Sin datos no se pinta un
> ✓ verde, se pinta «sin medir». Un modelo viejo dice de cuándo es. Una bandera que no se
> sabe no se adivina.

## Stack y restricciones técnicas

- **Monorepo npm-workspaces**: `server` (Fastify + TypeScript) y `web` (React + Vite +
  Tailwind 4). Raíz con los scripts comunes.
- **Node ≥ 22.5**, porque usa `node:sqlite` (`DatabaseSync`). Sin ORM, sin Postgres.
- **Los imports llevan extensión `.ts` explícita** (`import { getDb } from './db.ts'`).
  Es lo que permite ejecutar el servidor con `tsx` sin paso de compilación.
- **Una sola base SQLite** (`data/tennis.db`, ~37 MB) con los cinco deportes. Gitignorada.
- **Typecheck**: `npx tsc -p server --noEmit` y `npx tsc -p web/tsconfig.app.json --noEmit`
  **desde la raíz**. Lint con `oxlint`.
- **Puertos 7373 (web) y 7374 (API)**, elegidos a propósito para no chocar con el 5173 de
  todo proyecto Vite; si están ocupados, se busca uno libre.
- Todo el texto de la interfaz y los comentarios del código, **en español**.

## Principios de producto que deben notarse en la pantalla

1. **Explicar, no solo predecir.** Cada predicción trae su desglose: Elo, forma, cara a
   cara, mercado, y cuánto aporta cada parte.
2. **Decir la incertidumbre.** Cada probabilidad lleva su fiabilidad y su margen (±pp), y
   con pocos partidos detrás se marca.
3. **El mercado es el rival a batir, no el oráculo.** Se compara siempre contra la cuota
   de-vigada, y cuando el mercado gana, se dice.
4. **Una sola tarjeta, un solo nivel de superficie.** Nada de cajas dentro de cajas.
5. **El color solo identifica bandos**; los números van en tinta neutra.

---

# PARTE 2 — QUÉ HAY EN CADA PESTAÑA

## ⚽ Fútbol

- **17 ligas** (Premier, LaLiga, Bundesliga, Serie A, Ligue 1, Eredivisie, Primeira,
  Championship, MLS, Liga MX, Brasileirão, Primera argentina, Champions, y las segundas
  de España, Alemania, Italia y Francia).
- **Modelo jerárquico bayesiano Dixon-Coles**: ataque y defensa por equipo con priors que
  encogen hacia la media de la liga, ventaja de campo propia, corrección ρ para los
  marcadores bajos (0-0, 1-0, 0-1, 1-1), y decay temporal.
- **Rejilla de marcadores** (score matrix) con la probabilidad de cada resultado exacto.
- **Plantillas y lesionados** (fuente FPL + feeds), con las ausencias entrando en la λ
  esperada — no en un recuadro decorativo.
- **Mercados de menos liquidez**: las dos mitades, props de jugador, córners y tarjetas.
- **Pipeline de noticias** (`npm run news`): extrae con Claude la estructura de textos
  libres (ruedas de prensa, partes médicos) y convierte ausencias en goles esperados.

## 🏀 Baloncesto

- NBA, WNBA, NCAA, Euroliga, NBL australiana.
- Elo propio con ventaja de campo y descanso, contrastado contra FiveThirtyEight.
- Distribución de la diferencia de puntos, no solo el ganador.
- Escudos reales desde ESPN cuando la ingesta los trae.

## ⚾ Béisbol

- MLB, con el modelo construido **alrededor del lanzador abridor**.
- **Park factors** medidos por estadio.
- Matriz de carreras.
- Fuente: MLB Stats API + Retrosheet.

## 🏈 NFL

- El único deporte donde el modelo se puede puntuar **contra la línea de cierre**, porque
  nflverse la publica: 7.261 partidos, el favorito de la línea gana el 66,2 %, Brier de la
  línea **0,2127**.
- Elo con **rating específico del quarterback titular**.
- La probabilidad implícita del mercado se publica junto a la del modelo.

## 🎾 Tenis

- ATP y WTA. **30.853 partidos ATP** (2015→2026), 1.524 ediciones de torneo (874 nombres
  distintos: cada año cuenta como una edición). 1.275 jugadores con ficha.
- **Elo por jugador y por superficie** (dura, tierra, hierba), con forma reciente,
  fatiga y cara a cara.
- Acierto medido: **67,0 %** frente al **64,8 %** de fiarse del ranking oficial; cuando
  discrepa del ranking, acierta el 55,4 %.
- **Modelo jerárquico de puntos** (ver Parte 3) para set, hándicap de juegos y total.
- **Motor en vivo**: probabilidad de victoria desde el marcador exacto.
- Banderas reales de cada jugador.

## 🎟️ Apuestas

- Registro propio: importe, cuota, estado, beneficio, notas.
- Curva de beneficio y calendario.
- **Kelly fraccional** con topes, límites por día y por liga, y control de drawdown.
- Exposición agregada real frente a la suma ingenua.

---

# PARTE 3 — LOS MODELOS, CON SUS NÚMEROS

## El modelo jerárquico de puntos (tenis) — construido, medido y **NO publicado como modelo de partido**

**El encargo era reemplazar el modelo de partido por este.** Se construyó entero:
P(ganar punto al saque) y P(ganar punto al resto) por jugador, ajustados por la calidad
del rival mediante un ajuste conjunto (`logit P(i saca vs j) = μ_superficie + s_i − r_j`,
descenso de gradiente con L2), propagados por cadena de Markov punto → juego → tiebreak →
set → partido, con best-of-3 y best-of-5 y las variantes de tiebreak del set final por
torneo y época.

Y **pierde**. Walk-forward sobre 5.667 partidos ATP desde 2024:

| modelo | log loss del ganador |
| --- | --- |
| **Elo por jugador con superficie (el publicado)** | **0,558** |
| modelo de puntos, mejor de 8 configuraciones | 0,663 |
| modelo de puntos, peor de las 8 | 0,680 |

0,680 está a un paso del 0,693 de una moneda. **No se publicó como modelo de partido.**

*Por qué pierde*: las tasas de punto agregadas **tiran la información de quién ganó**. Se
puede ganar el 63 % de los puntos al saque y perder el partido por haber perdido los
importantes. El Elo aprende de victorias, que es justo lo que se predice.

*Lo que sí aporta, y por lo que se publica*: los mercados derivados que solo él produce,
todos de la **misma** distribución, así que no pueden contradecirse entre sí. En total de
juegos: **0,674** contra **0,724** de la marginal.

## El motor en vivo (tenis)

- Cadena de Markov punto a punto validada contra una simulación independiente de 800.000
  sets.
- **Actualización bayesiana del saque dentro del partido**: `p_post = (κ·μ + k)/(κ + n)`,
  con **κ = 63 puntos** medido por descomposición de varianza, no elegido.
- Detecta break points, saque para partido y momentum tras un quiebre.
- **El momentum se enseña pero NO se ajusta**, y se dice por qué: no existen datos punto a
  punto para medirlo.

## Fútbol: las dos mitades

De **8,35 pp de error a 2,08 pp**, en tres partes:

1. Un Dixon-Coles propio **por mitad** (ataque, defensa, ventaja y ρ separados).
2. **COM-Poisson en vez de Poisson**: los goles de una mitad están *infra*dispersos.
   Medido sobre 24.778 partidos: un equipo se queda a cero en la primera parte el 47,93 %
   de las veces y la Poisson dice 51,98 %.
3. Cópula entre mitades.

## Apuestas simultáneas: la correlación que no existía

Se midió antes de implementar, y salió **lo contrario de lo esperado**:

- Correlación entre partidos distintos (misma liga, misma jornada): **ρ ≈ 0**, validado
  con un grupo de control.
- Correlación entre mercados **del mismo partido**: **ρ ≈ 0,19**.

La primera versión mezclaba los dos grupos y daba un ρ=0,019 «significativo» que en
realidad medía 1X2 contra over del mismo marcador. Se separaron y uno colapsó a cero.

## Latencia de punta a punta

Cuatro etapas con dueño y presupuesto: `origen` (4 min), `ingesta` (30 s), `servidor`
(20 s), `cliente` (10 s). Objetivo total 5 minutos. El informe dice **en su primera línea
si el objetivo es alcanzable con tu plan** — con el plan gratuito de 500 peticiones/mes,
un precio tiene de media unas seis horas cuando lo lees, y ningún objetivo cambia eso.

---

# PARTE 4 — CADA ERROR ENCONTRADO Y CORREGIDO

Esta es la parte que más vale del proyecto. Todos salieron **midiendo o probando**, no
leyendo el código.

## Errores de modelo y de datos

| # | Error | Cómo se vio | Corrección |
|---|---|---|---|
| 1 | El LCG del Monte Carlo estaba **sesgado**: `seed * 1103515245` desborda 2^53 | P(x<0,62) daba 0,627 y los 9 casos de cadena «discrepaban», incluido el valor de libro | mulberry32 con `Math.imul`; ahora la media del generador se comprueba **antes** de que valide nada |
| 2 | `matchDistribution` bo5 tardaba **2.229 ms** (3,7 h por temporada) | un nodo por camino: 14⁵ ≈ 537.000 | fusión de estados equivalentes + caché de enumeración de sets → **7 ms** (318×) |
| 3 | λ = 1e6 para «apagar» las superficies hacía **divergir** el ajuste | 2.003 de 3.126 deltas no finitos, logLik NaN, y `fitPoints` lo devolvía en silencio; la fila del barrido daba 1,05661 **idéntico en las cuatro decadencias** | `useSurface: false` + guarda de divergencia que lanza si `λ·lr ≥ 2`, y comprobación de finitud post-ajuste |
| 4 | La simetría del set empatado parecía un parámetro ignorado | la simulación independiente reprodujo los mismos valores | **es real**: se documentó en vez de «arreglarlo» |
| 5 | Rompí el cálculo de la ventaja y **ningún check falló** | desde 0-0 la recursión nunca visita una ventaja (deuce cortocircuita) | checks de valor, no solo de identidad |
| 6 | Mi propio check de simetría **olvidaba cambiar el sacador** al cambiar de jugador | con `server=2` la suma daba exactamente 1 | corregido el check |
| 7 | `δ saque − δ resto` era el resumen equivocado | Nadal salía invertido en tierra | separados: su δ de resto en tierra es +0,096, el mayor suyo |
| 8 | El check de simetría del margen de juegos estaba **mal especificado** | abrir el partido vale +0,071 juegos | lo que debe ser cero es la media sobre ambos primeros sacadores |
| 9 | Jugadores **retirados** en la clasificación por Elo | Federer #4 (último partido 2021), Nadal #8 | filtro de actividad de 730 días + interruptor «Histórico»; los de fecha desconocida **no** se descartan |
| 10 | `player_rankings` mezcla fechas de snapshot en **4.031 días** | tres jugadores distintos con «#5» | no se puede arreglar aquí: se **dice**, con `officialRankingCoherence()` |
| 11 | Cada club de fútbol estaba **partido en dos ids** | el indicador de fiabilidad lo estaba avisando y tenía razón | normalización de nombres |
| 12 | Un bug **borraba los 0-0** del fútbol | auditoría de marcadores | corregido |
| 13 | `--skip-odds` **no hacía nada** en el script de la NFL | una pasada que se creía gratis gastó cuota solo ahí | el script no aceptaba argumentos; añadidos |

## Errores de la capa de riesgo y estadística

| # | Error | Corrección |
|---|---|---|
| 14 | `pairKey` sin ordenar alfabéticamente: `over_under~btts` escrito a mano **nunca casaba** | la mayor de tres correlaciones usaba en silencio el 0,5 por defecto; ahora las claves se construyen con el `pairKey` exportado |
| 15 | La correlación **inflaba el divisor de Bonferroni** de los experimentos de predicción | `metricFamily`/`familyKey` separados |
| 16 | El error estándar ingenuo no vale con pares no independientes | bootstrap por bloques sobre jornadas |
| 17 | El signo de la correlación no es un detalle | un factor con el signo cambiado recorta lo que había que dejar y deja lo que había que recortar, y por fuera parece igual de prudente |
| 18 | `allocate` dependía del contenido de la base | los próximos partidos caducan, así que el check se volvía vacío a los dos días **sin fallar**; se separó en `allocateFrom` puro |

## Errores de la interfaz

| # | Error | Detalle |
|---|---|---|
| 19 | **318 de 1.272 jugadores con la bandera de otro país** | el respaldo cortaba las dos primeras letras del código del COI: `RSA`→Serbia, `CHI`→Suiza, `EST`→España, `UAE`→Ucrania, `PAK` y `PAR`→Panamá los dos. Y **ninguno salía en blanco**: todos con una bandera segura de sí misma. En Windows, además, los emoji de bandera no existen. Corregido con tabla completa del COI + alias ISO-3, **sin heurística de respaldo**, y SVG en el repo |
| 20 | La **clasificación por Elo salía siempre plegada** | `defaultOpen = false` y un comentario que decía «abierta cuando es lo que el usuario vino a ver» — la segunda mitad no se cableó nunca |
| 21 | El aviso de cuotas demo decía **siempre** «pon tu clave» | hay tres causas (`sin_clave`, `fuente_falla`, `sin_eventos`) y el consejo era falso en dos |
| 22 | `liveOdds.ts` prefijaba `VITE_API_BASE` sobre `/api` | Vite ya hace de proxy: doble enrutado |
| 23 | Spam de notificaciones | la ingesta publicaba un evento por precio nuevo; un primer sync son decenas. Tope de 5 más inminentes + resumen |
| 24 | El informe pintaba `✓` junto a «sin datos del plan todavía» | cambiado a `·` cuando no hay medición |
| 25 | **`/` devolvía el JSON de la API en vez de la aplicación** | la ruta índice explícita gana al comodín de estáticos: «desplegado con éxito» e imposible de abrir |

## Errores de las propias comprobaciones

Los más importantes, porque una comprobación rota da falsa tranquilidad:

| # | Error | Detalle |
|---|---|---|
| 26 | El check de completitud de latencia era **vacuo** | se inyectó el fallo y no lo cazaba: sin muestras el total es 0 y `breached` sale falso de las dos formas |
| 27 | El mismo check **dependía de lo que hubiera en la base** | el total suma el p95 por etapa: con la tabla vacía una muestra inyectada *era* el p95; con la tabla poblada caía entre doscientas y no movía nada. No daba falso verde: **rompía**, por el andamio. Separado en `decideLatency(total, etapas)` puro |
| 28 | El aviso de «Node viejo» era **inalcanzable** | el comando pasaba `--experimental-sqlite` y Node 20 rechaza la bandera *antes* de leer el fichero: quien tenía Node viejo veía `node: bad option` en vez del mensaje. Comprobado contra un Node 20.20.2 real |

## Errores de infraestructura y arranque

| # | Error | Detalle |
|---|---|---|
| 29 | `data/raw/.gitkeep` **se borraba en cada actualización** | la limpieza de caché no lo eximía, y está rastreado en git: cada `update-all` dejaba un borrado pendiente que **abortaba el siguiente `git pull`**. Limpiar la caché acababa impidiendo traer código |
| 30 | `package-lock.json` reescrito por `npm install` | bastaba con otra versión de npm para que **todos** los pull se abortaran y la app quedara congelada |
| 31 | El diagnóstico del pull confundía dos casos | git dice «local changes» tanto para un fichero tocado como para una divergencia real: el mensaje mandaba a mirar el historial cuando el problema era un fichero |
| 32 | El arreglo de #30 tenía **su propio bug** | detectaba los ficheros cortando el prefijo de `git status --porcelain` con `slice(3)`, pero el helper hacía `trim()` y se comía el espacio inicial de la primera línea: `" D data/raw/.gitkeep"` → `"ata/raw/.gitkeep"`, el checkout fallaba y **no restauraba nada mientras decía que sí**. Sustituido por `git diff --quiet` fichero a fichero |
| 33 | El primer `npm run go` hacía `git pull` de la rama del proyecto **sobre la rama en la que estuvieras** | si no podía cambiar de rama (por cambios sin guardar), mezclaba dos historias sin mencionarlo |

---

# PARTE 5 — LO QUE SE MIDIÓ Y SE RECHAZÓ

Tan importante como lo que se publicó:

- **El modelo de puntos como modelo de partido**: pierde 0,663 contra 0,558. No se
  sustituyó, y se comprobó que la ventaja del Elo no fuera un artefacto de fuga temporal
  (el Elo mejora hacia el presente: 0,591 en 2023-H1 → 0,535 en 2025-Q4, que es
  envejecimiento, no fuga).
- **La correlación entre partidos distintos**: no existe (ρ≈0), con grupo de control.
- **El momentum tras un quiebre**: se enseña, no se ajusta. No hay datos punto a punto.
- **Córners y tarjetas**: el modelo está escrito, los datos no existen. Apagado con el
  motivo al lado.
- **Tres señales de fútbol** que no se ganaron el sitio y se borraron.
- **WebSockets del proveedor de cuotas**: se comprueba si los ofrece, no se supone.

---

# PARTE 6 — EL APARATO DE VERIFICACIÓN

- **`npm run verify:data`**: 362 comprobaciones sobre datos y modelos.
- **`npm run audit`**: 4.660 comprobaciones de coherencia numérica.
- **Registro de experimentos** con corrección por comparaciones múltiples (Bonferroni por
  familia de métrica) y **holdout final cerrado por código**.
- **Tres conjuntos, no dos**: entrenamiento, validación y un holdout que solo se abre una
  vez.
- **Cada comprobación nueva se prueba inyectando su bug.** Si al romper el código a
  propósito el check no falla, el check no sirve y se reescribe.

---

# PARTE 7 — COMANDOS

| Comando | Qué hace |
|---|---|
| `npm run go` | **El único que hace falta.** Comprueba Node, se pone en la rama, trae cambios, instala, verifica la base y arranca |
| `scripts/abrir.command` | Doble clic en Finder, sin terminal |
| `npm run update-all` | Los cinco deportes. `-- --skip-odds` no gasta cuota |
| `npm run doctor` | Dice por qué salen cuotas de demostración, **sin gastar cuota** |
| `npm run verify:data` | Las 362 comprobaciones |
| `npm run deploy` | Sube a Fly.io comprobando antes todo lo que fallaría al final |
| `npm run fetch-flags` | Baja los 211 SVG de banderas (una vez) |
| `npm run study:*` | Los estudios: points, live, correlation, thin, postprocess, calibration, devig, features, baselines |

## La cuota, que es lo que de verdad cuesta

The Odds API gratuita son **500 peticiones al mes**. Un `update-all` completo son cinco
tiradas. El servidor se re-cronometra solo para gastar ~60 % del plan al mes: cada 3 días
con el plan gratuito, cada 2 horas con uno de 20.000.

---

# PARTE 8 — DESPLIEGUE

**Fly.io**, no Supabase. Supabase es Postgres más auth: no ejecuta un proceso Node
persistente, y esta app *es* un proceso. Usarlo solo para los datos costaría reescribir
**355 llamadas `db.prepare(...)` repartidas por 73 ficheros** (80 si se cuentan los que
solo abren la base), para acabar necesitando
igualmente dónde correr el servidor.

Tres decisiones que no son de estilo:

1. **La base vive en un volumen, no en la imagen.** Una imagen se reemplaza entera en cada
   despliegue: con la base dentro, cada `fly deploy` borraría el registro de apuestas sin
   error y sin aviso, porque la app arrancaría perfectamente, vacía.
2. **El servidor sirve el frontend.** En desarrollo lo sirve Vite; en producción no lo
   serviría nadie.
3. **Contraseña obligatoria, o el proceso no arranca.** `/api/bets` sirve importes y
   beneficios, y `/api/refresh` gasta la cuota de quien lo pulse. Un aviso en el log se lee
   una vez, en un despliegue que salió bien, y la app queda abierta meses funcionando
   perfectamente — el fallo que no da síntomas. Comparación en tiempo constante y sin
   cortocircuito, porque el tiempo de respuesta filtraría cuántos caracteres eran
   correctos.

---

# PARTE 9 — CÓMO PEDIR TRABAJO SOBRE ESTA APP

Si vas a seguir desarrollándola, estas instrucciones son las que produjeron el resultado:

> - **Mide antes de cambiar.** Si propones sustituir algo, compáralo cara a cara fuera de
>   muestra y publica el número aunque pierda.
> - **Prueba cada comprobación inyectando su bug.** Si al romper el código el check no
>   falla, el check no sirve.
> - **Reporta los rechazos con números**, no los escondas.
> - **Nunca dejes que «sin medición» se pinte como «aprobado».**
> - **Escribe los comentarios explicando por qué, no qué.** El código ya dice qué hace; lo
>   que se pierde es el motivo, y sobre todo el motivo de lo que NO se hizo.
> - **Cuando algo parezca un bug, investígalo antes de arreglarlo.** Dos veces aquí lo que
>   parecía un fallo era el comportamiento correcto, y «arreglarlo» habría roto un modelo
>   que funcionaba.
