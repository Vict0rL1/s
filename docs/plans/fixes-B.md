# Arreglos de la revisión del 8 de octubre de 2026 · Lote B (seguridad de los datos)

Mismo método que el lote A: cada hallazgo se reproduce con un test que falla antes de tocar el
código; después se arregla y se cierra con doctor, tests, `verify:data`, `audit`, typecheck, lint,
build y Playwright en verde. Reglas de siempre: los holdouts no se tocan, las tablas inmutables
no se modifican, los parámetros de los modelos solo cambian por el registro de experimentos.

Lo que se verificó leyendo el código antes de escribir este plan está en cada punto. Ningún
hallazgo del lote resultó falso; en B3 se elige «conservar» en vez de «mover» y se dice por qué.

## B1 · `fetch-data --force` y `restore` no son seguros con WAL

**Verificado.** `restaurarCopia` (`db/backup.ts`) aparta el libro mayor actual con
`fs.copyFileSync` —que copia el fichero principal y NO las páginas que aún viven en
`ledger.db-wal`: la copia apartada está incompleta—, copia la copia de seguridad encima de un
fichero que otro proceso puede tener abierto (el servidor lo lleva adjunto; su conexión seguiría
escribiendo en el fichero viejo y el siguiente checkpoint aplicaría un WAL ajeno al restaurado), y
borra `-wal`/`-shm` DESPUÉS de copiar. Lo único que protege es un aviso impreso. `fetch-data
--force` hace lo mismo con `history.db`: copia de seguridad con `copyFileSync` (sin WAL), `rename`
encima con el servidor en marcha, y deja un `history.db-wal` viejo al lado del fichero nuevo, que
SQLite aplicaría como si fuera suyo. Además solo cuenta filas: no pasa `integrity_check`. Y el
servidor no cierra la base al recibir SIGINT/SIGTERM (`index.ts` no tiene manejadores): el WAL
queda sin checkpoint en cada parada.

Comprobado en este contenedor: una conexión con `locking_mode=EXCLUSIVE` y `busy_timeout=0` que
intenta `BEGIN IMMEDIATE` falla con «database is locked» mientras cualquier otra conexión tenga el
fichero abierto (aunque esté ociosa), y pasa en cuanto se cierra. Es una sonda fiable.

- **Tests (fallan antes):** (1) `otraConexionAbierta(fichero)` dice true con otra conexión
  abierta y false al cerrarla (`db/sqliteSeguro.ts` para el servidor y `scripts/datos-estado.mjs`
  para los scripts); (2) restauración REAL con WAL: un libro mayor vivo con filas escritas después
  de la copia (en el WAL), `restaurarCopia` se niega mientras la base está abierta; cerrada,
  restaura, la copia apartada conserva las filas posteriores, el destino pasa `integrity_check` y
  no quedan `-wal`/`-shm`; (3) `fetch-data --force` con una conexión abierta sale con 1 sin tocar
  nada; cerrada, la copia de la anterior conserva lo que estaba en el WAL, no queda
  `history.db-wal` y lo tuyo sobrevive; (4) el apagado cierra la base (el `-wal` desaparece) y
  `index.ts` lo instala para SIGINT y SIGTERM.
- **Arreglo:** `restaurarCopia`: se niega si hay otra conexión; aparta el actual con `VACUUM INTO`
  (completo aunque haya WAL); construye el nuevo con `VACUUM INTO` desde la copia a
  `ledger.db.restaurando`, lo comprueba con `integrity_check`, borra `-wal`/`-shm` y renombra.
  `fetch-data --force`: la misma sonda, copia de la anterior con `VACUUM INTO`, `integrity_check`
  de la descargada, y los `-wal`/`-shm` viejos fuera antes del `rename`. `server/src/apagado.ts`:
  SIGINT/SIGTERM paran los trabajos, cierran Fastify y la base, y salen.

## B2 · `odds_quote_state` vive en la historia

**Verificado.** La crea `ODDS_SNAPSHOT_SCHEMA` y no está en `TABLAS_LEDGER`, así que cae en
`history.db`. Su `snapshot_id` apunta a `ledger.odds_snapshots`, y `recordOddsResponse` la usa
para saber qué precio cambió o se retiró. Un `fetch-data --force` la vacía (cada cuota parece
nueva en el siguiente refresco) y la base publicada se la llevaría puesta.

- **Tests (fallan antes):** `TABLAS_LEDGER` la incluye y en la app de los tests vive en
  `ledger.sqlite_master`; una base con la tabla en `main` y filas, al migrar, las tiene en
  `ledger` y la copia de `main` desaparece.
- **Arreglo:** a `TABLAS_LEDGER`; migración 20 `quote-state-al-ledger` (destino `ledger`): crea
  la tabla en el libro mayor, copia lo que haya en `main` y la quita de ahí.

## B3 · Tablas de la historia que no se pueden reconstruir

**Verificado.** `fb_odds_history` (precios observados por el refresco de fútbol, append-only),
`fb_news` (noticias con su fecha de publicación y de lectura), `fb_lineups` (alineación esperada y
confirmada, con `recorded_at`), `latency_samples` (mediciones) y `player_ids` (los ids de tenis
que la ingesta asigna «y nunca se reinician») están en `history.db` y no en la lista `MINE` de
`fetch-data`: un `--force` las pierde, y la base publicada (construida en un runner limpio) no
las trae.

- **Decisión: conservar, no mover.** Moverlas al libro mayor son cinco migraciones con datos en
  movimiento (y sus índices) para tablas que la ingesta de fútbol escribe junto a las de la
  historia; conservarlas en `--force` las protege en la máquina de quien las tiene, que es el
  único sitio donde existen. La base publicada nunca las tuvo.
- **Test (falla antes):** en el `--force` de B1, filas de `fb_news`, `fb_lineups`,
  `fb_odds_history`, `latency_samples` y `player_ids` sobreviven.
- **Arreglo:** las cinco a `MINE` en `scripts/fetch-data.mjs`.

## B4 · Arrancar sin `ledger.db` habiendo historia

**Verificado.** `abrirBase` hace `ATTACH ledger.db` (SQLite crea el fichero vacío si no está) y
migra: un libro mayor perdido o renombrado se convierte en silencio en uno nuevo y vacío, y
nada dice que las apuestas y el registro ya no están.

- **Tests (fallan antes):** con `history.db` con filas y la marca `ledger.db.existe` pero sin
  `ledger.db`, `abrirBase()` se niega y nombra `npm run restore`; sin la marca (instalación nueva)
  abre, crea el libro mayor y escribe la marca; `partirBase` también la escribe.
- **Arreglo:** la marca `data/ledger.db.existe` se escribe cuando la app crea el libro mayor por
  primera vez y al partir; si está y el fichero no, el servidor no arranca (`LEDGER_NUEVO=si`
  para empezar uno nuevo a sabiendas).

## B5 · Pequeños

- **`synchronous` del libro mayor.** Verificado: los dos ficheros abren con `NORMAL`; con WAL es
  seguro ante un fallo del proceso, pero no ante un corte de luz (puede perder los últimos
  commits). El libro mayor pasa a `FULL`; la historia se queda en `NORMAL`. Test: `PRAGMA
  ledger.synchronous` = 2.
- **`BACKUP_HOURS` y `RESULTS_REFRESH_HOURS` sin tope.** Verificado: `Number(...)` sin máximo. Un
  `setTimeout` por encima de 2³¹−1 ms (24,8 días) dispara en el acto (Node avisa con
  `TimeoutOverflowWarning`): `BACKUP_HOURS=1000` haría la copia en bucle. Tope de 7 días (168 h)
  en un parser compartido. Test.
- **Carrera de cadencias en el registro de trabajos.** Verificado: el tic borra su entrada de
  `temporizadores` ANTES de ejecutar; si durante la ejecución (minutos) `configurar()` cambia la
  cadencia, programa un temporizador nuevo, y al acabar el tic viejo programa otro: dos
  temporizadores vivos para el mismo trabajo, uno sin registrar. Arreglo: `programarTic` quita
  el que haya, y el tic solo reprograma si nadie lo hizo mientras corría. Test con los
  temporizadores simulados de `node:test`.
- **Ancla de la retención.** Verificado: `decidir()` toma `commence_time` de la PRIMERA
  observación del grupo; un partido aplazado tiene la hora nueva en las últimas, y T-24h, T-6h,
  T-1h y el cierre se calculan contra la hora vieja. Ancla en la última `commence_time` no nula
  del grupo. Test.
- **`check-publishable` con su propia lista.** Verificado: una copia a mano de `TABLAS_LEDGER` a
  la que le faltan ocho tablas (`strategies`, `strategy_bets`, `inbox`, `reports`,
  `scheduler_jobs`, `notification_log`, `push_subscriptions`, `watchlist`), y `data.yml` la pasa
  sobre `data/history.db` ANTES de exportar: lo que se sube no es lo que se comprobó. Arreglo:
  importa `server/src/db/tables.ts` (corre con tsx) y el workflow comprueba el fichero exportado.
  Test sobre el fuente del script y del workflow.
- **La semilla de la imagen.** Verificado: `.dockerignore` excluye `data/*.db-wal` y el
  Dockerfile copia `data/history.db` tal cual: la semilla pierde lo que estuviera en el WAL (y
  `data/ledger.db` viaja al contexto de construcción sin necesidad). Arreglo: la etapa de
  construcción exporta con `db:export-history` (`VACUUM INTO` + `integrity_check`) a
  `/seed/history.db` y la final la copia de ahí; `.dockerignore` deja pasar `history.db-wal`/`-shm`
  y excluye `ledger.db*`. Test sobre los dos ficheros.

## B6 · Métricas y cookie

- **Etiquetas de métricas desde la URL cruda.** Verificado: `grupoDeRuta(req.url)`; fuera de
  `/api/` la etiqueta es la ruta tal cual (`/apuestas`, `/wp-admin`, cada sondeo): cardinalidad
  sin tope en memoria y en `/api/metrics`. Arreglo: `grupoDeRuta(req.routeOptions.url, req.url)`:
  sin ruta → `sin-ruta`; `/*` → `estatico`; el resto por su patrón. Test.
- **Cookie `sp_session` malformada → 500.** Verificado: `leerCookies` hace `decodeURIComponent`
  sin proteger; `sp_session=%E0%A4%A` lanza `URIError` dentro del hook `onRequest` → 500 y una
  fila en `error_log` por petición (una forma gratis de llenar el libro mayor). Arreglo: la
  cookie indescifrable se ignora; `error_log` se acota a 5.000 filas (se podan las más viejas;
  no es una tabla inmutable: no tiene triggers). Tests: cookie rota → 401, no 500; 5.100 errores →
  ≤ 5.000 filas.
