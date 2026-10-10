# Base de datos: dos ficheros, migraciones, copias y retención

Desde la Fase 2 la app guarda sus datos en **dos ficheros SQLite** dentro de `data/`:

| Fichero | Qué contiene | Si se pierde |
|---|---|---|
| `history.db` | Historia de los siete deportes: resultados, equipos, jugadores, ratings, próximos partidos, medidas derivadas. | Se vuelve a bajar (`npm run fetch-data`) o a reconstruir (`npm run update-all`). |
| `ledger.db` | **El libro mayor**: lo que el modelo dijo antes de cada partido (`*_prediction_log`), las apuestas de papel y las tuyas (`paper_bets`, `bets`), cada precio observado (`odds_snapshots`), las evaluaciones de confianza, las alertas, las sesiones, `settings`, `ingestion_runs`. | **No se puede volver a conseguir.** Por eso tiene copias y por eso nunca se publica. |

El servidor abre `history.db` como base principal y adjunta `ledger.db` como esquema `ledger`.
Las consultas de la app no cambian: SQLite busca un nombre primero en la principal y después
en la adjunta. Qué tabla vive en qué fichero está en **una** lista, `server/src/db/tables.ts`,
y de ahí beben la migración, la publicación nocturna, `verify:data` y el doctor.

`DB_LAYOUT=single` mantiene el fichero único de antes (`tennis.db`) por compatibilidad; en esa
disposición no hay copias del libro mayor por separado.

## La primera vez: partir la base antigua

Si tienes un `data/tennis.db` de antes de la Fase 2, **el servidor lo parte al arrancar** (o
`npm run db:migrate` a mano). No hay ningún `INSERT … SELECT`: se hacen dos copias físicas con
`VACUUM INTO` y en cada una se quitan las tablas que no le corresponden. Ninguna fila se
transforma, los triggers de inmutabilidad viajan con sus tablas y el original queda al lado
como `tennis.db.pre-split-<fecha>` hasta que lo borres tú. Las claves de **estado** de `meta`
(banco de papel, latido del ciclo) pasan a `ledger.settings`; las de procedencia
(`fb_updated_at`…) se quedan en `meta`, que es historia.

`npm run fetch-data` se niega a descargar nada si encuentra un `tennis.db` sin partir: antes
hay que pasar `npm run db:migrate`.

## Migraciones numeradas

`server/src/db.ts` → `MIGRACIONES`: una lista ordenada de `{ version, nombre, destino, up }`.
Cada fichero tiene su tabla `schema_version` con `(version, nombre, applied_at, estado, error)`.
Una migración corre dentro de una transacción; si falla, se deshace entera, queda registrada
como `failed` y **el servidor no arranca** hasta que se mire el error y se vuelva a intentar
con `npm run db:migrate -- --reintentar` (o se restaure la última copia). `npm run db:migrate`
sin argumentos enseña el estado de cada versión en cada fichero.

Las últimas, del seguimiento «NHL y UFC»:

| Versión | Destino | Qué |
|---|---|---|
| 14 `nhl-segunda-fuente` | historia | `nhl_games`: `final_period` admite NULL (la fuente no dice si hubo prórroga) y se añade `fuente`; la tabla se rehace copiando las filas |
| 15 `ufc-sombra` | historia | `ufc_events`, `ufc_fighters`, `ufc_fights` (la UFC en sombra) |
| 16 `nhl-publicada` | historia | `nhl_teams`, `nhl_upcoming` y los índices por equipo de `nhl_games` |
| 17 `nhl-registro` | libro mayor | `nhl_prediction_log` con los mismos triggers que los otros cinco registros (no se borra; lo que dijo no se reescribe; el resultado y la probabilidad enseñada se anotan una vez) |
| 18 `ufc-publicada` | historia | `ufc_upcoming` (las peleas que vienen, de la casa; `home_*` = luchador A, sin local) y los índices por luchador de `ufc_fights` |
| 19 `ufc-registro` | libro mayor | `ufc_prediction_log` con los mismos triggers (congelados también sus cinco rasgos); el resultado es 1-0 / 0-1 y 0-0 para el empate o el «sin resultado», con `outcome` y el método |

## PRAGMAs e índices

Los dos ficheros abren con `journal_mode=WAL` (`synchronous=FULL` el libro mayor —un corte de luz no
puede llevarse una apuesta— y `NORMAL` la historia, que se reconstruye), `foreign_keys=ON`,
`busy_timeout=5000` y `temp_store=MEMORY`. Los índices de la Fase 2 (migración v2) cubren las
consultas más calientes —el registro de predicciones pendientes, los snapshots por evento y
casa, las sesiones por token— y `server/src/db/hot.ts` las lista con su `EXPLAIN QUERY PLAN`:
el test `db/hot.test.ts` y `verify:data` fallan si alguna vuelve a recorrer su tabla entera.
`npm run db:explain` las enseña.

## Copias de seguridad del libro mayor

- **Qué**: solo `ledger.db`. Un `VACUUM ledger INTO` produce un fichero nuevo y consistente
  aunque haya WAL; se comprueba con `integrity_check` antes de darlo por bueno.
- **Dónde**: `BACKUP_DIR` (por defecto `data/backups/`), las últimas 14. Si están
  `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY` y `BACKUP_S3_SECRET_KEY` (y opcionalmente
  `BACKUP_S3_REGION`, `BACKUP_S3_ENDPOINT` para R2, B2 o MinIO), cada copia se sube también
  con firma SigV4 escrita con `node:crypto` (sin SDK). Una subida fallida no invalida la
  copia local: se dice y ya.
- **Cuándo**: el servidor la hace cada `BACKUP_HOURS` horas (24 por defecto; `0` la apaga;
  interruptor `datos.backupProgramado` en `config/features.json`). La primera, dos minutos
  después de arrancar si la última es más vieja que el intervalo, para que reiniciar no
  dispare copias. A mano: `npm run backup`.
- **Restaurar**: `npm run restore` lista las copias; `npm run restore -- <fichero>`, **con el
  servidor parado** (y se niega si no lo está: comprueba que nadie tiene `ledger.db` abierto),
  comprueba la integridad y que el fichero es un libro mayor, aparta el actual como
  `ledger.db.antes-de-restaurar-<fecha>` con `VACUUM INTO` (completo, con lo que hubiera en su
  WAL), reconstruye el nuevo también con `VACUUM INTO`, lo comprueba, quita los `-wal`/`-shm`
  viejos y renombra. `npm run fetch-data -- --force` hace lo mismo con `history.db` (y conserva,
  además de tus registros, lo medido en tu instalación: `fb_odds_history`, `fb_news`,
  `fb_lineups`, `latency_samples`, `player_ids`).
- **La marca `ledger.db.existe`**: la escribe la app al crear el libro mayor y la partición al
  partir. Si está y `ledger.db` no, el servidor **no arranca** con uno vacío: dice que falta y
  cómo restaurarlo (`LEDGER_NUEVO=si` para empezar uno nuevo a sabiendas).
- **Parar bien**: SIGINT/SIGTERM paran los trabajos, cierran Fastify y la conexión, que vuelca el
  WAL y quita `-wal`/`-shm`.
- **Doctor**: sección DATOS Y COPIAS. Aviso si la última copia tiene más de 36 h; error si
  nunca se ha hecho una y hay apuestas de papel registradas.
- En Fly, además, el volumen tiene instantáneas diarias (`fly.toml` → `snapshot_retention`;
  `fly volumes snapshots list datos`).

## Retención de snapshots de cuotas

`odds_snapshots` es append-only y tiene un trigger que impide borrar. La regla del proyecto
es no borrar filas de las tablas inmutables; pero cada refresco añade miles de filas que casi
siempre repiten el mismo precio. La resolución, deliberada:

- **Nunca automática.** Ni el servidor ni ningún ciclo la llaman. Solo
  `npm run odds:retention -- --dias N --confirmar`, a mano, con N ≥ 7.
- Sin `--confirmar` solo se enseña el plan.
- Antes de borrar, **cada fila que va a quitarse se exporta** a
  `data/archive/odds_snapshots-<fecha>.jsonl.gz` y se relee para comprobar que está entera.
  No se pierde información: se mueve.
- Se conservan, por evento + mercado + selección + casa: la apertura, la última observación
  anterior a T-24h, a T-6h y a T-1h, el cierre (la última antes del inicio) y la última
  observación. Y todo lo que tenga menos de N días.
- El trigger se quita y se vuelve a crear dentro de la misma transacción.

## `ingestion_runs`

Cada trabajo de datos deja fila: fuente, inicio, fin, estado (`running | ok | error`), filas
añadidas/actualizadas, error y detalle. Se registran los refrescos de cuotas por deporte
(`odds:tenis`, `odds:futbol`…), los cinco `update-data`, `update-results`, las copias
(`backup`) y la retención (`odds:retention`). Una ejecución que lleva `running` más de 3 h
(el proceso cayó) se marca como error al arrancar el servidor o al pasar el doctor.

- `GET /api/ingestion-runs?source=&limite=` → la última por fuente y el historial.
- `GET /api/datos/estado` → disposición, tamaño de cada fichero, última copia, retención.
- Doctor: última ejecución y estado por fuente.

## Publicación y despliegue

- El workflow nocturno (`.github/workflows/data.yml`) exporta `history.db` con
  `npm run db:export-history` (un `VACUUM INTO` comprobado y sin tablas del libro mayor) y
  publica `history.db.gz`. `npm run check-publishable` falla si la base a publicar contiene
  alguna tabla del libro mayor.
- La imagen Docker lleva `history.db` como semilla; `ledger.db` nace vacío en el disco
  persistente y a partir de ahí es tuyo. Un disco con el `tennis.db` antiguo se parte al
  arrancar.

## Fuentes nuevas (Fase 2C)

Todas detrás de un interruptor en `config/features.json` y todas con fila en `ingestion_runs`:

| Interruptor | Qué | Dónde | Comando |
|---|---|---|---|
| `fuentes.cuotasHistoricas` | Pinnacle temprano y de cierre de football-data.co.uk (`ps_*`, `psc_*`, `odds_source` en `fb_matches`); «vs mercado» con Shin y CLV histórico en el backtest | historia | `npm run update-data:fb`, `npm run backtest:fb` |
| `fuentes.clima` | Previsión (T-24h, T-6h, T-1h) y observación de Open-Meteo para NFL y MLB; coordenadas en `config/stadiums.json` | `weather_observations` (libro mayor, inmutable) | el servidor, cada 30 min |
| `fuentes.bullpen` | Carga del bullpen MLB (boxscores de los últimos 3 días) | `bsb_bullpen` (historia) | `npm run bullpen`; el servidor, cada 12 h |
| `fuentes.clubElo` | Elo de clubelo.com como baseline externo del walk-forward de fútbol | `fb_external_elo` (historia) | `npm run clubelo -- --desde 2019-08-01` |

Ninguna de ellas cambia una probabilidad publicada: clima y bullpen son información de la ficha
(`DESCONOCIDO` cuando falta), ClubElo es un baseline y las cuotas Pinnacle alimentan medidas del
backtest. Lo que de aquí pase al modelo pasará por el registro de experimentos (Fase 4).

**Lesiones**: se evaluaron las fuentes gratuitas (ESPN sin clave, informes oficiales de la NFL en
PDF, el *injury report* de la NBA en PDF). Ninguna es estable y parseable sin una clave o sin
leer PDF con formato cambiante, así que la señal se queda en `DESCONOCIDO` con ese motivo.
