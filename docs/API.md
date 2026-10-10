# API

La API REST: la especificación viva en `/docs` (Swagger UI, detrás de la contraseña) y `/openapi.json`; las rutas operativas de la Fase 3; y la descripción original por deporte.

## Rutas operativas (Fase 3)

| Ruta | Qué |
|---|---|
| `GET /health`, `GET /healthz` | Vive (sin contraseña) |
| `GET /ready` | Listo: migraciones y trabajos (sin contraseña; 503 si no) |
| `GET /docs`, `GET /openapi.json` | Swagger UI y la especificación de todas las rutas |
| `GET /api/features` | Interruptores de `config/features.json` |
| `GET /api/metrics` | Métricas en texto de Prometheus |
| `GET /api/datos/estado` | Ficheros de la base, última copia, retención |
| `GET /api/ingestion-runs` | Última ingesta por fuente e historial |
| `GET /api/scheduler`, `PATCH /api/scheduler/:nombre`, `POST /api/scheduler/:nombre/ejecutar` | Trabajos programados |
| `GET /api/policy`, `POST /api/policy` | La política de apuestas versionada |
| `GET /api/notifications/canales`, `POST /api/notifications/test/:canal`, `GET/POST/DELETE /api/notifications/push/…` | Notificaciones |
| `GET /api/export/:dataset` | Exportación CSV/JSON con filtros |

Las rutas operativas llevan esquema de respuesta; `server/src/api/contract.test.ts` falla si una
respuesta deja de cumplirlo o si una ruta registrada no aparece en la especificación.

## Rutas de analítica (Fase 4)

Nada de aquí cambia una probabilidad publicada: se lee, se enseña y se guarda para graficar. Cada
una tiene interruptor en `config/features.json` (404 si está apagada) y esquema de respuesta.

| Ruta | Qué |
|---|---|
| `GET /api/evaluation/reliability?sport=` | Diagrama de fiabilidad: backtest (`experiments/reliability.json`) y vivo, sin mezclar |
| `GET /api/evaluation/segmentos?sport=` | Acierto, Brier, log loss y CLV por liga, favorito, resultado, banda, mes y día; solo celdas con ≥ 100 predicciones / ≥ 30 apuestas |
| `GET /api/monitoring?sport=` | Ventana móvil de 28 días, PSI contra el backtest y deriva |
| `GET /api/simulation/season/:sport/:league` | Monte Carlo de la temporada (10.000 corridas, semilla fija, cacheado por día); «simulación, no predicción publicada» |
| `GET /api/simulation/torneo` | Cuadro de tenis: no hay fuente, y lo dice; siguientes partidos con su probabilidad |
| `POST /api/picks/parlay` | Probabilidad conjunta de una selección descontando la correlación medida (cuerpo: `{ patas: [...] }`) |
| `GET /api/odds/intel` | Steam moves, surebets y referencia afilada, como aproximación |

## Rutas de la interfaz (Fase 5)

| Ruta | Qué |
|---|---|
| `GET /api/estado` | La píldora de estado: cuotas, frescura por deporte, resultados, copia, errores |
| `GET /api/errores` | Últimos errores del servidor, sin pila ni agente (Diagnóstico) |
| `PATCH /api/features/:nombre` | Anular un interruptor (`{"on": true\|false\|null}`) |
| `GET/PUT /api/ajustes` | Tema, idioma, deportes visibles, banco personal, recorrido visto |
| `PATCH /api/scheduler/:nombre` | Ahora también `cadenciaMin` (minutos, o `null` para la del código) |
| `GET/POST/DELETE /api/watchlist` | Seguimiento de equipos, jugadores y partidos |
| `GET /api/buscar?q=` | Búsqueda global |
| `GET /api/elo/historia/:sport/:league/:id` | Elo de un equipo antes de cada partido |
| `GET /api/simulation/season/:sport/:league/historial` | Evolución diaria de la simulación |
| `GET /api/resultado/:sport/:key` | «¿Acertó?» de un partido con predicción |
| `GET /api/odds/casas/:id` | Cuotas por casa de un evento |
| `POST /api/picks/tarjeta.svg` | La tarjeta de «Mi selección» en SVG |
| `POST /api/bets/import`, `GET /api/bets/sugerencia`, `GET /api/bets/:id/clv` | Registro personal: CSV, sugerencia Kelly, CLV propio |

## Rutas de producto (Fase 6)

| Ruta | Qué |
|---|---|
| `GET /api/estrategias` | Estrategias, comparación con el banco principal, históricos disponibles y la política de partida |
| `POST /api/estrategias` | Crear una estrategia (`nombre`, `deportes`, `staking`, `confianza`, `calibracion`); no se edita |
| `POST /api/estrategias/:id/archivar` | Archivar una vez: deja de apostar |
| `GET /api/estrategias/:id/apuestas` | Sus apuestas, las últimas primero |
| `GET /api/estrategias/historico?sport=&id=` | «¿Qué habría pasado?» con la política vigente (`id=principal`) o una estrategia |
| `POST /api/estrategias/historico` | Lo mismo con una configuración sin guardar (vista previa) |
| `GET /api/bandeja?leida=&tipo=&sport=&antesDe=&limite=` | La bandeja: avisos, no leídas y tipos presentes |
| `GET /api/bandeja/contador` | Las no leídas (la campana) |
| `POST /api/bandeja/marcar` | `{"ids": [..]}` o `{"todas": true}`, con `leida: true\|false` |
| `GET /api/informes?tipo=` | Informes archivados (diario, semanal) y la zona horaria |
| `GET /api/informes/:id` | Un informe: Markdown y cifras |
| `GET /api/informes/:id/pdf` | El mismo en PDF (`informes.pdf`) |
| `POST /api/informes/generar` | `{"tipo": "diario"\|"semanal"}`: el del periodo actual si falta; uno archivado no se rehace |
| `GET /api/odds/lineas?sport=&market=` | Comparador de líneas: mejor, peor, consenso, dispersión, margen y surebets (solo lectura) |
| `GET /api/archivo?q=&sport=&liga=&confianza=&banda=&resultado=&desde=&hasta=&pagina=` | Archivo de predicciones con resultado, confianza, CLV y política |

## Rendimiento (Fase 7)

| Ruta | Qué |
|---|---|
| `GET /api/rendimiento` | Caché de próximos (aciertos, fallos, entradas, TTL) y si la compresión está encendida |

Todo `GET /api/*` con respuesta 200 lleva `ETag` débil y `Cache-Control: no-cache`; con
`If-None-Match` igual responde 304 sin cuerpo. Las respuestas de texto de más de 1 KB van con
Brotli o gzip según `Accept-Encoding`.

## NHL (seguimiento: publicada)

Bajo `/api/nhl`, como los otros cinco deportes bajo el suyo. Una sola liga. Detalle en [NHL.md](NHL.md).

| Ruta | Qué |
|---|---|
| `GET /api/nhl/meta` | Última ingesta, calendario y cuotas; por qué no hay cuotas; bandas de acierto; recuentos; ventaja de campo |
| `GET /api/nhl/games/upcoming?limit=` | Próximos (24 por defecto, hasta 64) con predicción, confianza, resultado si ya se jugó y fichas de los equipos. Servirlos registra la predicción |
| `GET /api/nhl/games/:id` | Un partido (`nhl-<id de la NHL>` del calendario u `odds-<id>` de la casa) |
| `GET /api/nhl/teams`, `GET /api/nhl/teams/:id` | Equipos en activo; la ficha de uno (Elo, puesto, balance de la temporada, goles, forma) |
| `GET /api/nhl/power` | Clasificación por Elo |
| `POST /api/nhl/predict` | `{home, away, oddsHome?, oddsAway?, totalLine?}` con abreviaturas (TOR, BOS…) |
| `GET /api/nhl/track-record` | El historial en vivo: acierto, Brier, log loss, error del total, calibración y contra la casa |
| `GET /api/nhl/backtest` | La evaluación con la que se publicó (sin el holdout), referencias y parámetros |
| `POST /api/nhl/refresh` | Pide las cuotas ahora (manual: no lo frena el ritmo mensual) |

`GET /api/simulation/season/nhl/:league` responde 404: la NHL no tiene simulación de temporada.

## UFC (publicada)

Bajo `/api/ufc`. Sin ligas; `home_*` es el luchador A y `away_*` el B (A, el de id de ufcstats menor:
no hay local). Detalle en [UFC.md](UFC.md).

| Ruta | Qué |
|---|---|
| `GET /api/ufc/meta` | Última ingesta y cuotas; por qué no hay cuotas; bandas de acierto; recuentos; peleas de otras organizaciones descartadas y sin identificar; el modelo y sus rasgos |
| `GET /api/ufc/fights/upcoming?limit=` | Las peleas que vienen (40 por defecto, hasta 80) con predicción, confianza, resultado si ya se peleó y fichas de los dos; las que no tienen número traen `sinPrediccion` con el motivo. Servirlas registra la predicción |
| `GET /api/ufc/fights/:id` | Una pelea (`odds-<id de la casa>`) |
| `GET /api/ufc/fighters/:id` | La ficha de un luchador (id de ufcstats): Elo, puesto, récord, edad, alcance, altura, guardia, categoría, últimas diez peleas |
| `GET /api/ufc/power?limit=` | Clasificación por Elo de los luchadores en activo |
| `POST /api/ufc/predict` | `{a, b, oddsA?, oddsB?}` con ids de ufcstats |
| `GET /api/ufc/track-record` | El historial en vivo: acierto, Brier, log loss, calibración, contra la casa; empates y «sin resultado» aparte |
| `GET /api/ufc/backtest` | La evaluación con la que se publicó (walk-forward, sin el holdout): referencias, Elo solo, elección entre candidatos, la prueba en los dos tramos y los pesos vigentes |
| `POST /api/ufc/refresh` | Pide las cuotas ahora (manual) |

`GET /api/simulation/season/ufc/:league` responde 404: la UFC no tiene temporada.
`GET /api/elo/historia/ufc/ufc/:id` da el Elo de un luchador antes de cada pelea.

## Ampliaciones (Fase 8, apagadas por defecto)

| Ruta | Qué |
|---|---|
| `POST /api/live/avanzar` | `{"state": {sets, games, points, server, bestOf, inTiebreak}, "winner": 1\|2}`: el marcador tras un punto, con la regla del motor en vivo; `{terminado, ganador, state}` (`tenis.enVivo`) |

Con el interruptor apagado, responden 404 con el motivo.

## API REST (puerto 7374)

Los tres deportes viven en espacios de nombres distintos: ningún endpoint puede devolver dos.

| Endpoint | Descripción |
|----------|-------------|
| `GET /api/meta` | Fuente de datos y conteos |
| `GET /api/track-record?tour=` | Acierto medido de la app en partidos ya jugados (+ mercado) |
| `GET /api/tours` | Circuitos ATP/WTA con conteos |
| `GET /api/points?tour=&p1=&p2=&surface=&bestOf=&tourney=` | **Los cuatro mercados del modelo de puntos**: partido, set, hándicap de juegos y total de juegos, todos de la misma distribución |
| `POST /api/live` | **Probabilidad en vivo** desde el marcador exacto: `{state, tour, p1, p2, tally?, odds?}` |
| `GET /api/power?tour=&limit=&minMatches=&activeDays=` | **Clasificación por Elo del circuito**, con Elo por superficie, ranking oficial y filtro de actividad (`activeDays=0` para la lista histórica) |
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
| `GET /api/latency?hours=` | Latencia por etapa, objetivo, si es alcanzable, transporte y reparto adaptativo |
| `GET /api/latency/stream` | **SSE**: el servidor empuja los cambios de precio. Reemplaza al refresco manual |
| `POST /api/latency/client` | El navegador reporta la última etapa `{ms, sport?, fixtureId?}` |
| `GET /api/latency/stages` | Los cuatro tramos y sus etiquetas |
| `GET /api/staking/book?bankroll=` | La cartera de hoy: tamaño de cartera contra tamaño en solitario, exposición agregada real contra la ingenua, topes que recortaron y correlaciones medidas |
