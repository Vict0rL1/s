# Arreglos de la revisión del 8 de octubre de 2026 · Lote A (bloqueantes)

Método: cada hallazgo se reproduce con un test que falla ANTES de tocar el código; después se
arregla y se cierra con doctor, tests, `verify:data`, `audit`, typecheck, lint, build y
Playwright en verde. Las reglas de siempre: los holdouts no se tocan, las tablas inmutables no se
modifican, los parámetros de los modelos solo cambian por el registro de experimentos.

Lo que se verificó leyendo el código antes de escribir este plan está en cada punto. Ningún
hallazgo del lote resultó falso.

## A1 · En producción la web queda detrás de la puerta

**Verificado.** `registerAuth` (`server/src/auth.ts`) exime solo `RUTAS_EXENTAS` (`/healthz`,
`/health`, `/ready`, `/api/auth/login`, `/api/auth/me`). `@fastify/static` registra la ruta
comodín `/*` (`req.routeOptions.url === '/*'`) para los ficheros y para el respaldo de la SPA, y
el hook `onRequest` corre antes: `GET /` y `GET /assets/*.js` devuelven `401 {"error":"Contraseña
requerida"}`. Sin `WWW-Authenticate` para navegadores (a propósito, para no ver el diálogo gris),
así que no hay forma de llegar a `Login.tsx`. Los e2e corren con `APP_AUTH=off`, por eso no se vio.

Sonda hecha con Fastify: `/`, `/assets/a.js` y `/apuestas` llegan al hook con
`routeOptions.url === '/*'` e `is404 === false` (la SPA se sirve desde el `/*` de static vía
`callNotFound`); `/api/typo` también pasa por `/*` y acaba en el 404 JSON.

- **Test (falla antes):** `buildApp` con una web construida de mentira (opción nueva `webDist`)
  y auth encendida: `GET /` con `Accept: text/html` → 200 HTML; `GET /assets/x.js` → 200;
  `GET /apuestas` → 200 HTML; `GET /api/health` → 401; `GET /api/typo` → nunca la página.
  Al reproducirlo se afinó esto último: sin credenciales un endpoint desconocido devuelve **401**
  (no se dice qué rutas existen) y con ellas el **404 JSON** de siempre. Lo que importaba era
  que no saliera el HTML, y no sale.
- **Arreglo:** exentar en el hook las peticiones `GET`/`HEAD` cuya ruta es la comodín de static
  (`/*`) y cuya URL no empieza por `/api/`. Ningún dato viaja por ahí: solo `index.html`, los
  assets, `sw.js`, el manifiesto e iconos. `/openapi.json`, `/docs` y todo lo registrado con
  ruta propia siguen detrás.
- **e2e con auth encendida:** `scripts/e2e-server.mjs` arranca un segundo servidor en el 7391 con
  `APP_AUTH=on` y `APP_PASSWORD`; `web/e2e/auth.spec.ts` abre `/`, ve la pantalla de entrada,
  entra y llega a `/destacados`. (E1 del lote E queda cubierto aquí.)

## A2 · El límite de intentos se salta con `X-Forwarded-For`

**Verificado.** `direccionDe` toma la primera entrada de `X-Forwarded-For` tal cual, con
`trustProxy: true` en producción; y el bloqueo se comprueba ANTES de la sesión, así que una
dirección bloqueada —aunque sea la del dueño, suplantada— no entra ni con cookie válida. El `Map`
de `LimiteDeIntentos` solo borra con `acierto()`.

- **Tests (fallan antes):** (1) fuera de producción, doce logins malos rotando `X-Forwarded-For`
  bloquean a la quinta igual (se cuenta la dirección del socket); (2) en producción, la clave es
  `Fly-Client-IP` (lo pone Fly, no el cliente) y rotar `X-Forwarded-For` no cambia nada; (3) una
  sesión válida sigue entrando aunque su dirección esté bloqueada; (4) el `Map` no crece sin tope:
  las entradas caducadas se podan y hay un máximo de direcciones.
- **Arreglo:** `direccionDe` usa `fly-client-ip` en producción y `req.socket.remoteAddress` en el
  resto (nunca `X-Forwarded-For`); el hook mira la sesión antes del bloqueo; el limitador poda y
  acota (10.000 direcciones, se desalojan las más antiguas). Detrás de otro proxy sin esa
  cabecera todas las peticiones comparten dirección: alguien puede bloquear a todos durante
  quince minutos, pero ya no saltarse el límite, y el dueño entra con su sesión.

## A3 · Basic Auth se salta el TOTP y la API puede apagar el segundo factor

**Verificado.** `basicAuthValido` solo compara usuario y contraseña; `PATCH /api/features/auth.totp
{on:false}` guarda la anulación y `featureEncendida('auth.totp')` la respeta. `auth.sesiones` en
`false` deja el login en 404 (y Ajustes no avisa).

- **Tests (fallan antes):** con `TOTP_SECRET`, Basic Auth sin código → 401; con el código en la
  cabecera `X-TOTP-Code` → 200. `PATCH /api/features/auth.totp` y `seguridad.*` → 403; una
  anulación guardada en la base para esos interruptores se ignora; `/api/features` los marca
  `soloArranque: true`.
- **Arreglo:** con TOTP activo, Basic Auth exige además `X-TOTP-Code` válido (curl sigue
  funcionando: `-H 'X-TOTP-Code: 123456'`). Los interruptores `auth.*` y `seguridad.*` son de
  arranque: la API los rechaza, `estadoFeatures` los marca y Ajustes no los enseña.

## A4 · La imagen ejecuta `npx tsx`, pero tsx es devDependency

**Verificado.** `server/package.json` tiene `tsx` en `devDependencies`; el Dockerfile instala con
`--omit=dev` y `docker-start.sh` hace `exec npx tsx …`: npx lo descarga (sin fijar) en cada arranque
frío, como root.

- **Test (falla antes):** `tsx` está en `dependencies` del servidor con versión exacta;
  `docker-start.sh` no llama a `npx`; el arranque suelta privilegios a `node`.
- **Arreglo:** `tsx` fijado a `4.23.1` en `dependencies`; el script ejecuta
  `node_modules/.bin/tsx`. Sobre `USER node`: el volumen de Fly se monta propiedad de root, así
  que la imagen no puede fijar `USER node` sin dejar `/data` ilegible; el arranque corre como
  root lo justo para copiar la semilla y hacer `chown`, y suelta los privilegios con `setpriv`
  (util-linux, presente en `node:22-slim`) antes de ejecutar el servidor.

## A5 · La ingesta de baloncesto vacía las tablas antes de descargar

**Verificado.** `basketball/scripts/updateData.ts` borra `bb_games`, `bb_teams` y
`bb_team_ratings` de cada liga y DESPUÉS descarga (minutos). El trabajo `resultados` lo corre cada
6 h y el ciclo pre-partido (cada 15 min) escribe en `bb_prediction_log` y `prediction_snapshots`,
que son inmutables: una predicción hecha con Elo inicial (1500 contra 1500) queda registrada para
siempre. Béisbol borra solo con `--fresh` (opcional). El `resetData` del tenis lo usa solo la
semilla de demostración, no una ingesta: no es el mismo caso.

- **Test (falla antes):** con partidos y ratings en la base, una ingesta cuya descarga falla deja
  las tablas como estaban; y DURANTE la descarga (dentro del `fetch` simulado) los partidos y los
  ratings siguen ahí.
- **Arreglo:** la lógica del script pasa a `basketball/scripts/actualizar.ts` (exportable y
  testeable, con el `fetch` inyectable): primero se descarga todo a memoria y después, por liga y
  en UNA transacción, se borra, se inserta y se recalculan los ratings de esa liga. Para eso
  las tres fuentes se parten en «cargar» (a memoria) y «guardar» (sin transacción propia):
  `descargarEspn`/`guardarEspn`, `cargarHoopr`/`guardarHoopr`,
  `cargarFiveThirtyEight`/`guardarFiveThirtyEight`; `recomputeBasketballRatings` acepta
  `{ leagues, enTransaccion }`. Los `ingest*` de antes quedan como envoltorios.

## A6 · El banco de papel y las estrategias ignoran los topes por día y por liga

**Verificado.** `paper/bankroll.ts` y `estrategias/index.ts` llaman a `decideEvent` (puertas 1–6,
tope total, por partido y de grupo). `maxExposurePerDay` (6 %) y `maxExposurePerLeague` (5 %) solo
viven en `decideBook` (`staking/book.ts`), que usa únicamente `routes/staking.ts`. Ajustes los
enseña como si aplicaran.

- **Test (falla antes):** seis partidos de la misma liga y el mismo día, cada uno con ventaja, en
  un banco de 1.000: el banco de papel coloca 6 × 20 = 100 (10 %) donde la política permite 50.
  Lo mismo para una estrategia.
- **Arreglo:** `staking/cubos.ts`, compartido por los dos bancos: antes de los topes de
  confianza y de grupo, cada candidata se recorta contra lo que queda en su cubo de día (día UTC
  del inicio) y de liga, contando lo abierto en la base y lo colocado en la misma pasada (las
  candidatas van ordenadas por ventaja, así que si el tope corta, corta las peores). Los rechazos
  se cuentan como «tope por día» / «tope por liga». El Kelly de cartera sigue siendo solo del
  libro manual, y así se dice en la nota de Ajustes.

## A7 · Una instalación nueva acaba con la base vacía

**Verificado.** La release `data-latest` no existe (comprobado con la API: 404, lista de releases
vacía); `data.yml` solo corre su cron desde `main`, donde ya está. Aparte, `scripts/setup.mjs`
corre `db:migrate` (paso 3) antes de los datos (paso 4): eso crea un `history.db` solo con esquema,
`fetch-data` ve que el fichero existe y no descarga, y setup dice «Listo».

- **Test (falla antes):** con un `history.db` solo con esquema en `DATA_DIR`, `fetch-data` descarga
  igual (contra un servidor local, como permite `DATA_BASE_URL`); `hayHistoria()` dice false con
  esquema y true con filas.
- **Arreglo:** `scripts/datos-estado.mjs` con `hayHistoria(fichero)` (alguna de las tablas
  principales de los siete deportes con filas); `fetch-data` respeta `DATA_DIR` y trata una base
  sin filas como ausente (la aparta como `history.db.sin-filas-<fecha>`, con sus `-wal`/`-shm`
  si los hay; nunca borra); `setup.mjs` decide por filas, no por tamaño, y si la descarga falla o
  deja la base vacía dice por qué (la release no existe o no hay red) y pregunta antes de
  construir con `update-all --skip-odds`. La release la creará el cron de `main` a las 05:30 UTC;
  queda por comprobar tras esa ejecución.
