# Arreglos de la revisión del 8 de octubre de 2026 · Lote D (interfaz)

Mismo método: cada hallazgo se reproduce con un test que falla antes de tocar el código
(unitario del servidor o de la web, o e2e), después se arregla y se cierra con doctor, tests,
`verify:data`, `audit`, typecheck, lint, build y Playwright en verde. Copia en español como
fuente de verdad (`web/src/i18n/es.ts`) con su inglés al lado; tokens en `web/src/lib/theme.ts`.

Lo verificado leyendo el código antes de escribir este plan está en cada punto. Dos hallazgos
se recortan con la evidencia: en D14 el aviso del fútbol sin clave es correcto tal cual («has
apagado la demostración» solo sale cuando `DEMO_FIXTURES=off`, que es una decisión), y lo que
falla es que con `/meta` sin cargar el aviso culpa a la clave (`hasKey ?? false`); y en D4 no
hay claves `t('…')` sin traducir (comprobado con un barrido del catálogo): lo crudo son las
once claves de la política que Ajustes pinta sin etiqueta.

## D1 · La ficha de partido y Destacados no dicen el mismo número

**Verificado.** Los siete `describeRow` calculan la predicción de nuevo en cada petición y
`log*Prediction` escribe solo la PRIMERA (`ON CONFLICT DO NOTHING`). Destacados, ¿Acertó?, el
banco de papel y las estrategias leen el registro (`shown_*`, `prob1`); la ficha enseña el
cálculo de ahora, que cambia con las cuotas y con cada ingesta. El mismo partido con dos números.

- **Test (falla antes):** se sirve un partido (queda registrado), cambian las cuotas de la fila
  de próximos, se vuelve a pedir: la cabecera (`final` / `model`) sigue siendo la registrada y
  la respuesta trae `publicada: { en, actual }` con lo que diría el modelo ahora.
- **Arreglo:** `prediction/publicada.ts`: tras registrar, cada ruta sobreescribe la cabecera con
  lo publicado (`final` en fútbol, NFL, NHL y UFC; `model.probHome`/`model.home`/`model.prob1`
  en baloncesto, béisbol y tenis, que no mezclan) y deja el cálculo actual en
  `prediction.publicada.actual`. La ficha dice «publicada el …; el modelo hoy diría …» si
  difieren.

## D2 · Los horizontes futuros dicen «sin observación»

**Verificado.** `EventTrustPanel` pinta `fiarse.sinObservacion` para toda marca sin fila, también
para T-6h y T-1h de un partido al que faltan dos días; la API ya manda `marca` (la hora de cada
horizonte).

- **Test (falla antes, web):** `etiquetaHorizonte(h, ahora)` → «pendiente» si la marca es
  futura, «sin observación» si ya pasó.
- **Arreglo:** la función pura en `lib/trust.ts` y el panel la usa.

## D3 · «Cómo le fue al modelo» abierto y con todos los deportes

**Verificado.** `TodayPanel` nace abierto (`abierto` = true salvo preferencia guardada) y
`RecentResults` arranca sin filtro de deporte aunque se esté en la pestaña de uno.

- **Test (falla antes, web):** `estadoInicialPanel({ vista: 'resultados', guardado: null })` →
  cerrado; `deporteInicial('football')` → «Fútbol» (el nombre con el que llegan los resultados).
- **Arreglo:** la vista de resultados nace plegada (la preferencia guardada manda) y filtrada al
  deporte de la pestaña, con «todos» a un clic.

## D4 · Once claves de la política sin etiqueta en Ajustes

**Verificado.** `ETIQUETA_POLITICA` conoce 8 claves; la política tiene 19 numéricas
(`staking` 8, `abstencion` 3, `recortes` 6, `grupos` 2): `staking.maxExposurePerLeague`,
`abstencion.desapareceMax`, `abstencion.precioViejoHoras`, los seis `recortes.*` y los dos
`grupos.*` se pintan como `grupo.clave`.

- **Test (falla antes, web):** cada clave numérica de la política por defecto tiene etiqueta en
  `es` y en `en`.
- **Arreglo:** las etiquetas en `lib/politica.ts` (exportable y testeable) y en el catálogo.

## D5 · Números sin Intl

**Verificado.** `pct` (`lib/theme.ts`, 182 usos) hace `toFixed` con punto y sin espacio antes
del `%`; `PaperBankroll.tsx:61` escribe `n.toFixed(2) + ' $'`; los rangos («rango razonable
{bajo} – {alto}») llevan espacios normales que se parten de línea.

- **Tests (fallan antes, web):** `pct(0.523)` en español → «52,3 %» (espacio duro) y en inglés
  «52.3%»; `dinero(-12.5, 'es')` → «−12,50 €» con `Intl`; los rangos del catálogo usan el
  espacio duro.
- **Arreglo:** `pct`/`num` leen el idioma activo (lo fija el proveedor de i18n) y usan
  `Intl.NumberFormat`; `dinero` en `lib/formato.ts`; los rangos con U+00A0.

## D6 · Service worker

**Verificado** en `web/public/sw.js`: (1) `/api/latency/stream` (SSE) no está en `NO_GUARDAR`
(`/api/stream` sí, que no existe): se clona un flujo infinito a la caché; (2) la navegación
guarda cualquier respuesta como armazón, también un 401 o un 404 JSON; (3) nada vacía la caché
de la API al salir: lo de la sesión anterior se sirve sin conexión al siguiente; (4) con el
interruptor apagado no se registra, pero el que ya estaba sigue; (5) `/api/bets*` y
`/api/buscar` se guardan; (6) `estadoAuth()` no captura un fallo de red (la pantalla se queda en
blanco sin conexión en arranque frío).

- **Tests (fallan antes):** sobre el fuente de `sw.js` (lista de exclusiones, `Accept:
  text/event-stream`, `res.ok && text/html` en navegación); `salir()` borra la caché de la API
  (caches simulado); `registrarServiceWorker` con el interruptor apagado llama a `unregister()`;
  `estadoAuth()` con `fetch` que lanza devuelve el estado «sin puerta». e2e en frío
  (sin conexión) queda para el lote E.
- **Arreglo:** lo de arriba, y el banner «Sin conexión: datos de …» sale también cuando la
  respuesta vino de la caché (cabecera `X-Desde-Cache` que pone el worker).

## D7 · Un asset que ya no existe devuelve la página

**Verificado.** `setNotFoundHandler` sirve `index.html` para todo lo que no sea `/api/`, también
`/assets/index-abc.js` tras un despliegue: el navegador recibe HTML como módulo, la carga
diferida falla y no hay `ErrorBoundary` que lo recoja (no existe ninguno).

- **Tests (fallan antes):** `GET /assets/no-existe.js` → 404; `esErrorDeChunk(new TypeError('Failed
  to fetch dynamically imported module'))` → true.
- **Arreglo:** 404 para `/assets/*` y `/flags/*`; `ErrorBoundary` en la raíz que, ante un error
  de chunk, recarga una vez (marca en `sessionStorage`) y si no, enseña «ha fallado la
  pantalla» con botón de recarga.

## D8 · Enlaces profundos

**Verificado.** (1) `FootballDashboard:167` (y tenis) borra `?dia=` en cuanto `dayGroups` está
vacío, es decir, mientras cargan los partidos: un enlace con `?dia=` llega sin día; (2) el
efecto de carga por liga no descarta respuestas viejas: cambiar dos veces de liga deja los
partidos de la que contestó última; (3) `Partido` reinicia `item` al cambiar de id pero no
`pre`, `res`, `casas` ni `seleccion`: la ficha nueva enseña un rato la deriva y el resultado de
la anterior.

- **Tests (fallan antes, web):** `conservarDia(day, grupos, cargando)`; una carga que resuelve
  tarde no pisa a la liga actual (`ultimaPeticion`); e2e: `/futbol/epl?dia=…` conserva el
  parámetro.
- **Arreglo:** no se toca `dia` mientras carga; cada carga lleva un número y solo la última
  escribe; `Partido` reinicia todo su estado al cambiar de partido.

## D9 · CSP sin `blob:` en `img-src`

**Verificado.** `imagenPng` (Mi selección → PNG) carga el SVG en un `<img>` por
`URL.createObjectURL`; `img-src 'self' data: https:` no permite `blob:`: en producción la
descarga falla con «no se pudo dibujar».

- **Test (falla antes):** la CSP incluye `blob:` en `img-src` y en ningún otro sitio.

## D10 · Diálogos

**Verificado.** Seis `role="dialog"`: `StatusPill` y `MobileNav` sin `aria-modal`, sin Escape,
sin foco; `Recorrido` y `Confirmar` (Ajustes) sin Escape ni foco; ninguno bloquea el scroll de
fondo salvo `FiltrosMovil` y el buscador; los atajos 1–9/0 de `App` cambian de pestaña con un
diálogo abierto.

- **Tests (fallan antes):** `useDialogo` (hook) → Escape cierra, el foco vuelve al botón que
  abrió, `document.body.style.overflow` mientras está abierto; `atajoPermitido(evento)` → false
  si hay un `[role="dialog"][aria-modal="true"]` abierto. e2e: Escape cierra la píldora de
  estado.
- **Arreglo:** el hook en los seis y los atajos lo consultan.

## D11 · Formularios de Ajustes

**Verificado.** (1) Cadencias: tras aplicar, `setBorrador(…: '')` deja el campo VACÍO (`'' ??` no
es nulo); (2) un `PATCH` que falla (cadencia fuera de rango, interruptor de arranque) se traga
en silencio: el diálogo se cierra y la lista vuelve a lo de antes sin decir por qué; (3) el
campo del banco personal (`banco || valorGuardado`) no se puede vaciar y confirma con el texto
crudo; (4) la cadencia no se valida en el cliente (1 min – 7 días).

- **Tests (fallan antes, web):** `borradorTrasAplicar` deja de pisar con `''`;
  `validarCadencia('20000')` → mensaje; `respuestaDeAjuste(r)` devuelve el error del servidor.
- **Arreglo:** borrador que se olvida (undefined) en vez de `''`; errores en pantalla; banco con
  borrador propio inicializado al cargar; validación de cadencia con el tope de 7 días.

## D12 · Píldora y campana montadas dos veces

**Verificado.** `App.tsx` monta `<StatusPill>` y `<Campana>` en la barra lateral (`lg:block`) y
en la cabecera móvil (`lg:hidden`): las dos instancias viven a la vez (CSS las esconde) y cada
una pide `/api/estado` (cada 5 min) y `/api/bandeja/contador` (cada minuto): el doble de
peticiones y dos relojes.

- **Test (falla antes, e2e):** al cargar, `/api/estado` y `/api/bandeja/contador` se piden una
  vez cada uno.
- **Arreglo:** `useMediaQuery('(min-width: 1024px)')` decide una sola instancia.

## D13 · Tarjetas de Destacados densas

**Verificado.** Cada tarjeta lleva dos controles con estrella (`Añadir a Mi selección` y
`Seguir`) que se confunden, y el bloque «por qué esta confianza» (datos, estabilidad,
desacuerdo, apostaría o no) siempre abierto.

- **Test (falla antes, e2e):** en Destacados, el bloque «por qué» va dentro de un
  `<details>` cerrado y el control de seguir no es una estrella.
- **Arreglo:** `Disclosure` para el porqué; «Seguir» con el icono de seguimiento (campana
  tachada/activa), no con la estrella de la selección.

## D14 · Pequeños

- **Fútbol sin clave**: con `/meta` sin cargar, el aviso de pestaña vacía dice «falta la clave»
  (`hasKey ?? false`). Ahora, sin `meta`, dice que no se pudo leer el estado de las cuotas.
- **Tabla de Elo de la liga**: `getPowerRanking` lista TODOS los equipos con rating (los que
  bajaron hace años incluidos). Solo los de la última temporada en la base. Test del servidor.
- **`role="alert"`**: los mensajes de error de Ajustes, Login, Laboratorio e importación lo
  llevan; el resto de `error &&` no. Se añade donde falta (test sobre el fuente).
- **`:focus-visible { border-radius: 4px }`** redondea el anillo de foco de todo, también de los
  botones redondos y las fichas cuadradas: fuera (el anillo sigue la forma del elemento).
- **Plurales «(s)»**: seis claves (`pap.apuntados`, `estado.trabajosError`, `fiarse.avisos`,
  `csv.resultado`, `csv.rechazadas`, `acerto.esperan`) pasan a dos formas con `plural()`.

## D15 · El servidor de desarrollo escucha en todas las interfaces

**Verificado.** Vite (`host: true`), la API (`0.0.0.0`) y la sonda de puertos de `dev.mjs` se
atan a todas las interfaces; con `APP_AUTH` apagado (lo normal en desarrollo) la app entera, con
el registro de apuestas, es alcanzable desde la red local.

- **Test (falla antes):** `hostDeEscucha({ NODE_ENV: 'test' })` → `127.0.0.1`; con
  `APP_AUTH=on` o `NODE_ENV=production` → `0.0.0.0`.
- **Arreglo:** `auth/mode.ts` lo decide y lo usan `index.ts`, `vite.config.ts` y `dev.mjs`
  (`DEV_LAN=on` para abrirlo a sabiendas sin contraseña).

## D16 · `secret-scan --staged` lee el disco

**Verificado.** En modo `--staged` lista lo preparado con `git diff --cached` pero lee el
contenido con `fs.readFileSync`: lo que se comprueba es el fichero de trabajo, no lo que va al
commit (un `git add -p` parcial, o un secreto quitado del disco pero no del índice, pasan).

- **Test (falla antes):** un repositorio temporal con un secreto en el índice y limpio en disco
  → el escáner lo encuentra.
- **Arreglo:** `git show :<ruta>` en modo `--staged`.

## D17 · SMTP sin TLS obligatorio en el 587

**Verificado.** `createTransport({ secure: port === 465 })` sin `requireTLS`: en el 587
STARTTLS es opcional y, si el servidor no lo ofrece (o alguien en medio lo quita), usuario y
contraseña viajan en claro.

- **Test (falla antes):** `opcionesSmtp({ SMTP_PORT: '587' })` lleva `requireTLS: true`; en el
  465, `secure: true`.

## Resultado

Los diecisiete, reproducidos con un test que fallaba antes y arreglados. Lo que la reproducción
cambió respecto a lo escrito arriba:

- **D1.** Además de la cabecera recalculada, la tarjeta de la NFL enseñaba `model` (la cruda, con
  empate) mientras el registro y Destacados guardan `final` (`shown_home`): el mismo partido con
  dos números incluso el día que se publicó. La tarjeta y el adaptador común leen ya `final`. Test
  del servidor con la NHL (una ingesta mueve el Elo entre dos peticiones) y de la web
  (`partidos.test.ts`).
- **D4.** El test vive en el servidor (necesita `politicaPorDefecto`) e importa el catálogo de la
  web por una ruta en variable, para que el typecheck del servidor no compile la web.
- **D5.** `dinero(-12.5, 'es')` es «−12,50», **sin** «€»: el proyecto no inventa moneda
  (`lib/bets.ts`), y el «$» del banco de papel era justo ese defecto. Unos 150 `toFixed` de
  pantalla pasan por `lib/formato.ts` (quedan los de rutas SVG, colores y el CSV, que son datos);
  14 «{x} %» del catálogo llevan espacio duro. El texto y el `.ics` de «Mi selección» formatean
  en su idioma (sus dos tests se actualizan: esperaban «50,0 %» con espacio normal y «@ 2.10»).
- **D6.** Los tests ejecutan `public/sw.js` de verdad en una caja (`node:vm`) con caché y red
  simuladas, en vez de leer el fuente. El arranque en frío sin red, de punta a punta, va en el
  lote E.
- **D8.** El borrado del `?dia=` estaba también en baloncesto, béisbol y NFL (NHL y UFC ya lo
  guardaban). El e2e usa el tenis, que es el deporte con datos en la semilla de los e2e.
- **D10.** El hook va en la píldora (anclada: sin bloquear el scroll), la hoja de deportes del
  móvil, los filtros del móvil, el recorrido y la confirmación de Ajustes; el buscador ya lo hacía.
- **D12.** El buscador también estaba montado dos veces (dos atajos ⌘K); mismo arreglo.
- **D13.** «Seguir» es una campana en toda la app, no solo en Destacados.
- **D14.** «(s)» había en 18 claves, no en 6: el traductor entiende `{n|uno|varios}` y el catálogo
  lo usa (sin tocar las llamadas). Sin `role="alert"` había 8 párrafos de error (Ajustes tampoco lo
  llevaba). La nota de la NFL sin línea tenía el mismo `?? false` que el aviso del fútbol. La tabla
  de Elo incluye también a quien tiene partido próximo (un recién ascendido).
- **D15.** `HOST` fija la dirección a mano; `npm run phone` explica cómo abrirla al móvil.
- **D16.** El contenido del índice se lee con `execFileSync('git', ['show', ':ruta'])`, sin shell.
- **D17.** `SMTP_TLS=off` es la salida explícita para un relé local sin TLS.

Los seis e2e nuevos (`e2e/interfaz.spec.ts`) se pasaron también contra la web del lote C: fallan
los seis.

| | Antes (lote C) | Después |
|---|---|---|
| Tests del servidor | 492 | 502 |
| Tests de la web | 20 | 51 |
| Playwright | 73 | 79 |
| `verify:data` | 528 | 528 |
| `audit` | 4952 | 4688 (\*) |
| Doctor (sin red) | 1 error y 3 avisos del entorno | los mismos |

(\*) La ventana de partidos de la auditoría es «desde hoy»: con el código del lote C y la base de
hoy también salen 4688. No es una comprobación perdida.
