# Cambios

Por fases de la hoja de ruta (ver `docs/plans/`). Cada fase termina con doctor, tests,
`verify:data`, typecheck, lint y build en verde; las cifras de antes y después van aquí cuando
cambian.

## Revisión del 8 de octubre · lote G, lo que encontró la prueba en el navegador (2026-10-10)

Doce defectos que el agente `ui-tester` encontró en la app construida con la base real, tres en
cosas que los lotes D y E daban por arregladas (D2, D5, D8). Cada uno con su prueba, que falla
antes del arreglo (`docs/plans/fixes-G.md`). Ningún parámetro de modelo cambia y no hay
migraciones. Tests: 642 → 671 (512 del servidor + 64 de la web + 95 de punta a punta).

- **G1 · Horizontes pendientes, de verdad.** Un T-6h, T-1h o final que aún no ha llegado dice
  «pendiente»; antes se rellenaba con la última instantánea (D2 solo probaba filas vacías). Cada
  horizonte lleva su `estado` decidido por el servidor, y la ficha y el panel de confianza ya no
  dan por hecho que hay fila (G1b, de la revisión de `quant-reviewer`).
- **G2 · `?torneo=` sobrevive a la recarga** en el tenis. **G3 · Cambiar de liga** en el fútbol
  ya no enseña los partidos de la anterior mientras carga.
- **G4 · Salir desde la lista de sesiones** también vacía la caché de la API.
- **G5 · Un solo formato de número.** `t()` escribe los números en el idioma, el catálogo español
  lleva «41,6 %» y el texto del servidor («Lectura completa», titulares, motivos de confianza)
  sale de `server/src/numeros.ts`: coma, «−» y espacio duro.
- **G6 · Contraste con datos reales.** Campana, filas empezadas de «Hoy» (sin `opacity`),
  contadores, insignias de confianza, escudos de club, botón y error de la pantalla de entrada,
  errores de Ajustes. Los estados de cada tema, retocados para pasar de 4,5:1 sobre su tinte.
  `contrastes()` en los e2e mide lo que axe deja como incompleto.
- **G7 · «Salir» se alcanza** con muchas sesiones (la barra lateral se desplaza). **G8 · «Hoy» a
  390 px** cabe entero.
- **G9 · Sin 404 de simulación** en Equipo y Liga de la NHL. **G10 · Sin 401** en la pantalla de
  entrada. **G11 · El buscador** atrapa y devuelve el foco. **G12 · `/api/auth/me`** no dice el
  usuario a quien no ha entrado.

## Mantenimiento: agentes del proyecto y CI de secretos (2026-10-09)

- **Agentes del proyecto.** `CLAUDE.md` con las reglas comunes, `.claude/settings.json` con reglas
  `deny` para los comandos que no se ejecutan sin pedirlo y seis agentes en `.claude/agents/`
  (test-runner, security-reviewer, data-guardian, quant-reviewer, ui-tester, fixer). La revisión
  del 8 de octubre, entera, en `docs/plans/fixes-review.md`.
- **gitleaks en la PR.** El job «Secretos» de la PR marcaba como `generic-api-key` la contraseña
  de pruebas del servidor de e2e con la puerta activa (`scripts/e2e-server.mjs`, lote A). Es
  pública a propósito: va a la lista de permitidos de `.gitleaks.toml`, como `clave-de-test-…`.

## Revisión del 8 de octubre · lote E, las pruebas que lo habrían cazado (2026-10-09)

Las pruebas que habrían cazado los defectos de A–D (`docs/plans/fixes-E.md`), cada una pasada
contra el código de antes de su arreglo, donde falla. E1, E5 y E6 ya las tenían los lotes A y B.
Tests: 632 → 642 (505 del servidor + 51 de la web + 86 de punta a punta). Doctor,
`verify:data`, `audit`, typecheck, lint, build y Playwright en verde.

- **E2 · axe de verdad.** Las 19 rutas, los dos temas, 1280 y 390 px y las dos hojas abiertas;
  el contraste cuenta desde `serious` (antes solo `critical`, que el contraste nunca es).
  Destapó contraste insuficiente en tinta tenue, estados, beneficio/pérdida y el ámbar de la
  selección (ahora tokens por tema) y tablas con scroll que el teclado no alcanzaba.
- **E3 · Un 500 de la API ya no pasa** por los e2e: fuera el filtro de «Failed to load resource».
- **E4 · Arranque en frío sin conexión**: la app pinta con lo guardado y lo dice.
- **E7 · Ficha = Destacados**, por HTTP y tras una ingesta.
- **E8 · Ninguna clave cruda** del catálogo ni de la política en ninguna ruta; los nombres de
  los interruptores van como código.
- **E9 · La ingesta de baloncesto y otro proceso**: un lector con su propia conexión nunca ve los
  ratings vacíos (y el control con el patrón de antes, sí).

## Revisión del 8 de octubre · lote D, interfaz (2026-10-09)

Los diecisiete hallazgos de la interfaz, reproducidos con un test que fallaba antes y arreglados
(`docs/plans/fixes-D.md`); ningún parámetro de modelo cambia y no hay migraciones. Tests: 585 →
632 (502 del servidor + 51 de la web + 79 de punta a punta). Doctor, `verify:data`, `audit`,
typecheck, lint, build y Playwright en verde.

- **D1 · Un partido, un número.** La ficha y las pestañas enseñan lo publicado (lo que leen
  Destacados, «¿Acertó?» y el banco de papel) y, aparte, lo que diría el modelo hoy si difiere
  (`prediction/publicada.ts`). La tarjeta de la NFL enseña la final, no la cruda.
- **D2 · Horizontes pendientes.** T-6h o T-1h que aún no han llegado dicen «pendiente».
- **D3 · «Cómo le fue al modelo»** nace plegado y filtrado al deporte de la pestaña.
- **D4 · Política con etiquetas.** Las 19 claves numéricas, en español e inglés.
- **D5 · Números con Intl** (`lib/formato.ts`): coma decimal y espacio duro en español, el banco de
  papel sin una moneda inventada, rangos que no se parten.
- **D6 · Service worker.** El canal en vivo no pasa por él; solo una página HTML buena es el
  armazón; apuestas y búsqueda no se guardan; al salir se vacía la caché de la API; con el
  interruptor apagado se desregistra; lo servido de la caché enciende el banner; sin red en
  frío, la app arranca con lo guardado.
- **D7 · Un asset viejo es un 404**, y un `ErrorBoundary` recarga una vez ante un trozo que falta.
- **D8 · Enlaces profundos.** `?dia=` sobrevive a la carga; una liga que contesta tarde no pisa a
  la elegida; la ficha de partido empieza de cero al cambiar de partido.
- **D9 · CSP con `blob:` en `img-src`** (Mi selección → PNG).
- **D10 · Diálogos accesibles** (`useDialogo`): Escape, foco atrapado y devuelto, fondo quieto;
  los atajos 1–9/0 no actúan con un diálogo abierto.
- **D11 · Ajustes.** El campo de cadencia no se vacía al aplicar, los errores del servidor se
  ven, la cadencia se valida (1 min – 7 días) y el banco personal se puede vaciar.
- **D12 · Una sola píldora, campana y buscador** (la de la disposición que se ve).
- **D13 · Tarjetas de Destacados** con el porqué plegado y «Seguir» como campana.
- **D14 · Pequeños.** Sin estado de cuotas no se culpa a la clave; la tabla de Elo solo con
  equipos activos; errores con `role="alert"`; el anillo de foco sigue la forma; plurales de
  verdad (`{n|uno|varios}`).
- **D15 · Desarrollo en 127.0.0.1** salvo `APP_AUTH=on`, producción o `DEV_LAN=on`.
- **D16 · `secret-scan --staged` lee el índice**, no el disco.
- **D17 · SMTP exige TLS** fuera del 465 (`SMTP_TLS=off` solo para un relé local).

## Revisión del 8 de octubre · lote C, dinero y modelo (2026-10-08)

Los diez hallazgos de dinero y medición, reproducidos con un test que fallaba antes y arreglados
(`docs/plans/fixes-C.md`); ningún parámetro de modelo cambia. Tests: 573 → 585 (492 del servidor
+ 20 + 73); migraciones 20 → 21. Doctor, `verify:data`, `audit`, typecheck, lint, build y
Playwright en verde.

- **C1 · La combinada no se infla.** Entre partidos distintos la ρ de «misma liga y día» pasa a 0
  (la medida es indistinguible de cero; la 0,0047 del libro manual es el extremo prudente para
  dimensionar, no para multiplicar probabilidades) y la corrección nunca sube la conjunta. Dos
  patas del mismo partido siguen siendo incompatibles (solo se combina el ganador).
- **C2 · Nada mezcla líneas.** El consenso por instante (`marketAt`) describe la línea más
  cotizada; las surebets exigen líneas complementarias (misma |línea|) y dicen cuál; el steam
  solo mide dentro de la misma línea.
- **C3 · La ventana del steam se aplica.** Sin ningún punto anterior dentro de los 60 minutos no
  hay steam (antes se medía contra el punto de hace horas).
- **C4 · La deriva compara lo mismo.** `predicciones()` trae `pModelo` (lo que dijo el modelo) y la
  monitorización mide PSI y log loss con ello, que es lo que midió el backtest; `p` sigue siendo
  lo publicado para segmentos y diagramas en vivo.
- **C5 · Estrategias congeladas del todo.** La configuración guarda también los topes de grupo;
  el tope de equipo/jugador nunca baja del tope por partido del banco (la primera apuesta de una
  estrategia con el 4 % ya no se recortaba al 3 %); `strategy_bets.policy_version_id`
  (migración 21).
- **C6 · Simulación de temporada.** Pendiente es «sin resultado emparejado» (mismo par y fecha
  ±1 día), no «fecha futura»: ni se simula lo ya jugado ni se olvida lo aplazado.
- **C7 · Un solo ROI.** `evaluation/roi.ts` (beneficio / arriesgado) para los siete sitios que lo
  calculaban; las dos fórmulas daban hoy lo mismo (una unidad por apuesta) y ya no pueden
  separarse.
- **C8 · CLV honesto.** El cierre exige una observación POSTERIOR a la apuesta; sin ella se queda a
  NULL (banco y estrategias).
- **C9 · Segmentos sin desenlace.** La dimensión «ganó el visitante» (lo que pasó) se sustituye
  por `lado` (el que favoreció el modelo), que se sabe antes del partido.
- **C10 · Tenis por id.** La apuesta resuelve su lado contra los nombres del registro y se liquida
  por `winner_id`; una selección que no es ninguno de los dos se anula, no se pierde.

## Revisión del 8 de octubre · lote B, seguridad de los datos (2026-10-08)

Los seis hallazgos de datos de la revisión, reproducidos con un test que fallaba antes y
arreglados (`docs/plans/fixes-B.md`). Tests: 557 → 573 (480 del servidor + 20 + 73); migraciones
19 → 20. Doctor, `verify:data`, `audit`, typecheck, lint, build y Playwright en verde (el doctor
sigue con sus avisos de entorno).

- **B1 · `restore` y `fetch-data --force`, de verdad con WAL.** Se niegan si otro proceso tiene la
  base abierta (sonda con `locking_mode=EXCLUSIVE`, medida en el test); lo que se aparta se copia
  con `VACUUM INTO` (completo, con lo que estuviera en el WAL); lo nuevo se reconstruye con
  `VACUUM INTO`, pasa `integrity_check`, y los `-wal`/`-shm` del fichero viejo se quitan antes del
  `rename`. El servidor cierra la base al recibir SIGINT/SIGTERM (`apagado.ts`).
- **B2 · `odds_quote_state` al libro mayor.** Apunta a `odds_snapshots` y un `--force` la vaciaba;
  migración 20 la mueve con sus filas.
- **B3 · Lo medido en tu instalación sobrevive al `--force`.** `fb_odds_history`, `fb_news`,
  `fb_lineups`, `latency_samples` y `player_ids` se conservan (como `bets` y los registros); se
  eligió conservar y no mover, y el plan dice por qué.
- **B4 · Sin `ledger.db` no se arranca uno vacío.** La marca `ledger.db.existe` (la escribe la app
  al crearlo y la partición) hace que el servidor se niegue y diga cómo restaurar;
  `LEDGER_NUEVO=si` para empezar de cero a sabiendas.
- **B5 · Pequeños.** El libro mayor abre con `synchronous=FULL`; `BACKUP_HOURS` y
  `RESULTS_REFRESH_HOURS` se acotan a 7 días (por encima de 24,8 días un `setTimeout` dispara en el
  acto); cambiar una cadencia desde Ajustes mientras el trabajo corre ya no deja dos
  temporizadores; la retención de cuotas ancla T-24h/T-6h/T-1h y el cierre en la ÚLTIMA hora de
  inicio del partido; `check-publishable` importa la lista de tablas del libro mayor del servidor
  (le faltaban ocho) y el workflow comprueba el fichero que de verdad exporta; la semilla de la
  imagen es una exportación consistente (`VACUUM INTO` en la etapa de construcción, con el WAL en
  el contexto) y `ledger.db` ya no viaja al contexto.
- **B6 · Métricas y cookie.** Las etiquetas de `/api/metrics` salen del patrón de la ruta
  (`estatico`, `sin-ruta`), no de la URL cruda; una cookie `sp_session` indescifrable ya no es un
  500; `error_log` se acota a 5.000 filas.

## Revisión del 8 de octubre · lote A, bloqueantes (2026-10-08)

Los siete hallazgos bloqueantes de la revisión, reproducidos con un test que fallaba antes de
tocar nada y arreglados (`docs/plans/fixes-A.md`). Tests: 540 → 557 (464 del servidor + 20 + 73).
Doctor, `verify:data`, `audit`, typecheck, lint, build y Playwright en verde (el doctor sigue
avisando de lo que es del entorno: sin clave de cuotas, tenis y béisbol atrasados —lote F—, backend
parado).

- **A1 · La web detrás de la puerta.** En producción `GET /` y los assets devolvían 401 y no había
  forma de llegar a la pantalla de entrada. La ruta comodín de `@fastify/static` (`/*`, solo GET y
  HEAD, nunca `/api/`) queda exenta; la API sigue cerrada (un endpoint desconocido es 401 sin
  credenciales y 404 JSON con ellas, nunca la página). Los e2e corren ahora también con la puerta
  activa: `scripts/e2e-server.mjs` arranca un segundo servidor en el 7391 con `APP_AUTH=on` y
  `web/e2e/auth.spec.ts` entra con la contraseña.
- **A2 · El límite de intentos.** Contaba la primera `X-Forwarded-For` tal cual, que escribe quien
  ataca: rotándola no se bloqueaba nunca. Ahora cuenta `Fly-Client-IP` en producción (la pone
  Fly) y la dirección del socket en el resto; la sesión válida se mira ANTES del bloqueo (el dueño
  entra aunque su dirección esté bloqueada); el Map del limitador poda lo caducado y no pasa de
  10.000 direcciones.
- **A3 · Basic Auth y el segundo factor.** Basic Auth abría con la contraseña sola aunque hubiera
  TOTP; ahora exige el código en `X-TOTP-Code` (`curl -u victor -H 'X-TOTP-Code: 123456'`). Y la API
  podía apagar `auth.totp` y `auth.sesiones`: los interruptores `auth.*` y `seguridad.*` son de
  arranque (`PATCH /api/features/...` → 403, una anulación guardada se ignora, `/api/features` los
  marca `soloArranque` y Ajustes no los enseña).
- **A4 · La imagen.** `tsx` pasa a dependencia del servidor fijada a `4.23.1` (estaba en
  devDependencies con `--omit=dev`, y `npx tsx` la descargaba sin fijar en cada arranque frío, como
  root). El arranque ejecuta `node_modules/.bin/tsx`, cede `/data` a `node` y suelta los
  privilegios con `setpriv` (o `runuser`); el volumen de Fly se monta de root, por eso no basta
  con `USER node`.
- **A5 · La ingesta de baloncesto.** Borraba `bb_games`, `bb_teams` y `bb_team_ratings` ANTES de
  descargar (minutos), y el ciclo pre-partido registraba mientras tanto predicciones con Elo
  inicial en tablas inmutables. `basketball/scripts/actualizar.ts`: todo a memoria primero y, por
  liga, borrar + insertar + recalcular en UNA transacción; si la descarga falla, la base queda como
  estaba. Las tres fuentes (ESPN, hoopR, FiveThirtyEight) se parten en cargar/guardar.
- **A6 · Topes por día y por liga.** El banco de papel y las estrategias los ignoraban (solo
  vivían en el libro manual): seis partidos de la misma liga y tarde se colocaban al 2 % cada uno.
  `staking/cubos.ts`, compartido: cada candidata se recorta contra lo que queda en su día (UTC del
  inicio) y en su liga, contando lo abierto y lo de la misma pasada; los rechazos se cuentan como
  «tope por día» / «tope por liga». La nota de Ajustes dice qué aplica a quién.
- **A7 · La instalación nueva acababa vacía.** `setup` migraba antes de bajar los datos, eso dejaba
  un `history.db` solo con esquema, y `fetch-data` lo tomaba por una base. `scripts/datos-estado.mjs`
  (`hayHistoria`, por filas); `fetch-data` respeta `DATA_DIR`, aparta una base sin filas como
  `history.db.sin-filas-<fecha>` y descarga; `setup` decide por filas y, si la descarga falla, dice
  por qué y pregunta antes de construir con `update-all --skip-odds`. La release `data-latest`
  sigue sin existir (la crea el cron de `main`); queda por comprobar tras su primera ejecución.

## UFC publicada (2026-10-08)

La UFC no pasó la prueba en la etapa A (el Elo de luchador no ganaba a «el de mejor récord»). Un
segundo intento, **escrito y subido antes de calcular** (`docs/plans/ufc-combinado.md`), sí la pasa,
y la UFC es el séptimo deporte. Tests: 524 → 540 (449 del servidor + 20 + 71); migraciones: 17 → 19;
`verify:data` 521 → 528 comprobaciones; auditoría 4.659 → 4.952; bundle principal 442 → 449 kB,
inglés 109 → 115 kB.

- **El modelo**: una logística simétrica, walk-forward por año, con el Elo, el récord, la edad, el
  alcance y la experiencia en la UFC; elegida entre dos candidatos fijados de antemano solo con el
  entrenamiento. Todo lo puntuable (7.799 peleas): 0,6802 → **0,6662**, gana a las cuatro
  referencias con el intervalo bajo cero (a «mejor récord», −0,0168 [−0,0211, −0,0124]); 2025:
  **0,6454**, −0,0271 [−0,0435, −0,0110]. Barajar las fichas entre luchadores devuelve 0,6804: la
  ganancia es de la ficha. Dos experimentos en el registro.
- **Publicada como los demás**: pestaña `/ufc`, tarjeta de pelea con lo que aporta cada rasgo, ficha
  de luchador (`/luchador/:id`) con la historia de su Elo, registro de escritura única
  (`ufc_prediction_log`), banco de papel y estrategias (el empate devuelve, el «sin resultado»
  anula), Hoy, ¿Acertó? con reconstrucción, Destacados, archivo, búsqueda, confianza, doctor y
  auditoría (que comprueba la simetría sobre peleas reales).
- **Sin adivinar**: la cartelera llega con las cuotas (`mma_mixed_martial_arts`) y de ahí solo se
  guardan las peleas de una cartelera de la UFC; los nombres se resuelven por coincidencia exacta;
  el debutante se enseña sin número; A es siempre el de id menor aunque la casa dé la vuelta.
- **Arreglos de paso**: en un deporte de dos resultados, un empate (NFL; UFC) ya no se cuenta como
  acierto ni fallo en la ficha de partido; la tecla 0 lleva a la décima pestaña.

## Puesta en marcha: la clave y la otra copia (2026-10-08)

Lo que falló al instalar la versión con la NHL en otro ordenador, arreglado en la app y no solo
explicado. Tests: 514 → 524 (436 del servidor + 20 + 68).

- **`npm run clave`**: pide la clave de The Odds API sin enseñarla, la limpia (comillas, `export`,
  la línea entera pegada, `\r`), deja **una** línea `ODDS_API_KEY=` en el `.env` de la raíz
  (creándolo desde `.env.example`), la comprueba contra el listado gratuito (no gasta créditos) y
  avisa si la terminal tiene una `ODDS_API_KEY` —distinta o vacía— que gana sobre el `.env`. No
  la acepta como argumento (se quedaría en el historial). `npm run setup`, el doctor, `npm run
  odds`, el arranque del servidor y los avisos de la app apuntan a él.
- **`npm run dev` se para si ya hay otra copia de la app abierta** en su puerto (la reconoce por
  el título de la página o por `/ready`), en vez de irse al 7377 y dejar que la dirección de
  siempre abra la vieja. Da el comando para cerrarla con `-sTCP:LISTEN`: sin ese filtro, `lsof`
  lista también al navegador conectado y `xargs kill` lo cerraba. `-- --junto` arranca las dos.
- El título, la descripción y el manifiesto de la web nombran la NHL; el glosario dice «seis
  deportes».

## NHL y UFC (2026-10-08)

Petición: añadir la NHL y la UFC. Con la regla de la Fase 8 por delante —un deporte no se publica
sin la misma evidencia que los demás—. Plan y resultados en `docs/plans/nhl-ufc.md`. Tests: 488 →
514 (426 del servidor + 20 + 68); migraciones: 13 → 17; bundle principal 437 → 442 kB, inglés 105
→ 109 kB.

- **NHL, publicada (sexto deporte).** Historia real desde sportsdataverse en GitHub (21.960 partidos
  desde la 2009-10; nueve temporadas con marcadores de relleno arregladas con las «team box», solo
  si cruzan todos los partidos). Sobre 20.214 partidos puntuables gana a «siempre el local» (log
  loss 0,6731 frente a 0,6896, Δ −0,0165 [−0,0193, −0,0135]) y a un Elo básico (0,6805, Δ −0,0073
  [−0,0090, −0,0057]). El ajuste de K, campo y vuelta a la media, y los goles de la liga móviles, no
  mejoraron de forma demostrable: registrados como no concluyentes, se quedan los de partida.
  Pestaña propia con próximos del calendario (sin clave) o de The Odds API (`icehockey_nhl`, ganador
  y total), registro de escritura única (`nhl_prediction_log`), Hoy, ¿Acertó? (también
  reconstruido), Destacados, banco de papel y estrategias, confianza, archivo, búsqueda, doctor,
  auditoría, `update-results` y `update-all`. Sin post-proceso ni mezcla con el mercado (no hay
  cuotas históricas), sin simulación de temporada. Ver `docs/NHL.md`.
- **UFC, en sombra.** Ingesta de ufcstats vía Greco1899/scrape_ufc_stats (8.923 peleas), Elo de
  luchador simétrico (el orden de la fuente pone al ganador primero hasta ~2009 y no se usa) y
  backtest contra cuatro referencias con holdout desde 2026. **No pasa**: gana a la moneda, a «más
  peleas» y al Elo básico, pero no queda demostrado que gane a «el de mejor récord» (Δ −0,0028
  [−0,0056, +0,0000]; en 2025, +0,0038). Detrás de `deportes.ufc`, con sus cifras en Diagnóstico. Ver
  `docs/UFC.md`.
- Destacados: la cabecera de la tarjeta ya no se aplasta cuando lleva dos insignias.

## Seguimiento tras la hoja de ruta (2026-10-07)

Lo que las fases dejaron anotado y se arregla sin decisiones nuevas de política. Plan en
`docs/plans/seguimiento.md`. Tests: 467 → 488 (403 del servidor + 20 + 65); migraciones: 12 → 13.

- **El banco de papel mira sus propias pérdidas.** Su corte por pérdida diaria (5 %) y semanal
  (10 %) leía el registro personal (`bets`), vacío en la práctica: el banco de papel no tenía
  límite de pérdida. Ahora sale de sus apuestas liquidadas hoy y desde el lunes, con la misma regla
  que las estrategias (`perdidasRealizadas`). Los umbrales no cambian; solo puede hacer que deje de
  apostar antes.
- **Topes por grupo de correlación en las estrategias.** Aplicaban el tope por partido y el total,
  pero no los de equipo y jugador. Migración 13: `strategy_bets.correlation_groups`, congelada desde
  el alta (el trigger se rehace; las filas existentes quedan intactas, con NULL, y cuentan solo con
  su partido). Límites: el tope por partido de la estrategia y los de equipo y jugador de la
  política vigente, sobre su banco.
- **`npm run audit` en verde (4.453 de 4.453).** La comprobación de la ventana de partidos daba
  un falso positivo desde la línea base: comparaba con la ventana de ahora un refresco hecho con la
  de su hora. La regla exacta (`sobrevivioARefresco` en `freshness.ts`, con test) sigue cazando un
  pruning roto.
- **Toda la interfaz en el catálogo de idiomas.** La Fase 5 había pasado el armazón y las páginas
  nuevas; el resto (las cinco pestañas de deporte, apuestas, confianza, Destacados, ajustes,
  gráficos, avisos del modelo) llega ahora en ocho lotes, con el español idéntico y un recorrido en
  inglés en Playwright. El inglés se carga aparte para no engordar el paquete principal
  (435 kB; 520 kB si fuera dentro). Lo que escribe el servidor sigue en español.
- **CI fijada a `ubuntu-24.04`** en los tres workflows: `ubuntu-latest` pasa a Ubuntu 26 el 19 de
  octubre de 2026. Las acciones siguen en su versión (GitHub ya las corre con Node 24).

## Resumen de la hoja de ruta: antes y después

Línea base: `docs/plans/00-baseline.md` (commit `e40abbf`, 7 de octubre de 2026). Cada fase tiene
su plan en `docs/plans/phase-N.md` y su entrada abajo.

| | Antes | Después |
|---|---|---|
| Tests | 202 (todos del servidor) | **467**: 393 del servidor, 17 unitarios de la web, 57 de Playwright, más la prueba de carga en CI |
| `verify:data` | 494 comprobaciones | 514 |
| Secciones del doctor | 7 | 12 (DATOS Y COPIAS, OPERACIÓN, ANALÍTICA E INTERFAZ, PRODUCTO, SEGURIDAD) |
| Interruptores (`config/features.json`) | no existía | 50 (45 encendidos; las 4 ampliaciones de la Fase 8, apagadas) |
| Migraciones versionadas | ninguna (`CREATE IF NOT EXISTS`) | 12, con `schema_version` y estado por fichero |
| Próximos de fútbol, p95 (base completa, 6 a la vez) | 8.570 ms | 129 ms |
| Lighthouse móvil, Destacados / Fútbol | 59 / 63 | 96 / 94 |
| Desplazamiento de diseño (CLS) | 0,28 | ≤ 0,03 |

**Los modelos no cambian.** Ninguna probabilidad publicada ni ningún parámetro se ha tocado fuera
del registro de experimentos, y ningún experimento ha ganado en el holdout (que sigue cerrado):
`experiments/backtest_metrics.json` es el mismo fichero que en la línea base.

| Backtest | n | Log loss | Brier | ECE | Antes → después |
|---|---|---|---|---|---|
| Tenis | 22.062 | 0,6133 | 0,2132 | 0,64 pp | sin cambios |
| Fútbol | 20.824 | 1,0143 | 0,3037 | 0,78 pp | sin cambios |
| Baloncesto | 85.562 | 0,5919 | 0,2033 | 0,12 pp | sin cambios |
| Béisbol | 14.428 | 0,6756 | 0,2414 | 0,58 pp | sin cambios |
| NFL | 3.781 | 0,6284 | 0,2194 | 0,46 pp | sin cambios |

- **Contra el mercado**: solo la NFL se puede medir con esta base. Sobre 3.780 partidos, el
  mercado de cierre da log loss 0,6114 y el modelo 0,6285: **el mercado es mejor**, y por eso el
  freno de calibración deja la NFL sin apostar. Fútbol y tenis no tienen ninguna cuota histórica
  guardada (sus dos fuentes, football-data.co.uk y tennis-data.co.uk, están bloqueadas por la red
  de este entorno): no hay comparación, y no se inventa.
- **Tenis tras el cambio de fuente**: no hubo cambio. Sackmann sigue en 404, TML congelado desde el
  17 de enero de 2026 y la alternativa bloqueada aquí; el doctor lo avisa ahora en OPERACIÓN.
- **Lo pendiente, para la máquina del propietario** (con red): bajar fútbol y tenis con cuotas y
  medirlos contra el mercado; la temporada 2026 de la MLB; la NHL en sombra; probar el asistente
  de Telegram. `npm run doctor -- --fuentes` dice qué fuentes contestan.

## Fase 9 — Cierre (2026-10-07)

Tests: 464 → 467 (393 del servidor + 17 + 57). Plan en `docs/plans/phase-9.md`.

- **Doctor, sección OPERACIÓN**: trabajos programados (fallo en la última pasada o colgados más
  de 6 h), canales de notificación y envíos fallidos en 24 h, interruptores (inactivos por falta de
  variable y anulaciones huérfanas), frescura de los resultados por deporte según su temporada
  (aviso tras 21 días sin resultados en plena temporada) y `npm run doctor -- --fuentes`, que pide
  algo ligero a cada fuente de datos. La tabla de secciones de `docs/OPERACION.md`, completa.
- En este entorno el doctor pasa a **1 error y 4 avisos**: los dos nuevos son reales (tenis y
  béisbol, meses atrasados en plena temporada).
- **CI de Playwright en verde otra vez**: fallaba desde las capturas de la Fase 5 porque CI baja
  otro build de Chromium que pinta las fuentes un píxel distinto (3 de 57 tests). Las capturas se
  comparan ahora solo con el build con el que se hicieron (`chromium.txt` junto a ellas); con otro,
  el resto del test corre y la comparación se anota como omitida.

## Fase 8 — Ampliaciones, apagadas por defecto (2026-10-07)

Línea base: 442 tests. Después: 464 (390 del servidor + 17 unitarios de la web + 57 de
Playwright). Las cuatro piezas van detrás de interruptores **apagados**; con los valores por
defecto nada cambia (doctor, carga y pantallas iguales). Plan y límites en
`docs/plans/phase-8.md`.

- **NHL en sombra** (`deportes.nhl`): Elo con margen de goles y Poisson ligada al Elo (moneyline con
  prórroga, empate a 60 minutos y total), ingesta de partidos terminados de la API web de la NHL a
  `nhl_games` (migración v12), backtest contra «siempre el local» y un Elo básico con el holdout
  final reservado desde la 2025-26, `GET /api/nhl/sombra` y bloque en Diagnóstico. No entra en
  `SPORT_IDS`: nada se publica. **Sin cifras**: la red de este entorno no alcanza
  `api-web.nhle.com`. Ver `docs/NHL.md`.
- **Props de jugador de la NBA** (`apuestas.propsNba`): evaluados y no construidos; no hay box
  scores gratuitos, legítimos y alcanzables.
- **Asistente por Telegram** (`asistente.telegram`): el asistente determinista por el bot de las
  notificaciones, solo para `TELEGRAM_CHAT_ID` y `TELEGRAM_ASISTENTE_CHATS`, cada minuto.
- **Tenis en vivo punto a punto** (`tenis.enVivo`): «Punto para…» y «Deshacer» con la regla del
  motor (`POST /api/live/avanzar`), y el recuento al saque y el último juego hacia el motor en vivo.
- **Doctor**: líneas para las cuatro (apagadas, encendidas sin lo que necesitan, o en marcha).

## Fase 7 — Rendimiento y experiencia de desarrollo (2026-10-07)

Línea base: 426 tests. Después: 442 (373 del servidor + 14 unitarios de la web + 55 de Playwright)
y la prueba de carga con presupuestos en CI. Ninguna respuesta cambia de contenido. Detalle en
`docs/RENDIMIENTO.md`.

- **Caché de próximos con invalidación por datos** (firma de la tabla de próximos y
  `PRAGMA data_version`, dos minutos como mucho, calentada por el ciclo pre-partido). Base
  completa, p50 / p95 con seis peticiones a la vez: fútbol 3.808 / 8.570 → 64 / 129 ms, baloncesto
  2.347 / 5.216 → 12 / 24, tenis 1.235 / 2.769 → 20 / 37, NFL 1.202 / 2.737 → 21 / 42, béisbol
  613 / 1.370 → 13 / 27.
- **Compresión y ETag**: Brotli/gzip en las respuestas de texto (la lista de fútbol, 1,4 MB →
  147 KB), ETag con 304 en todo `GET /api/*`, assets precomprimidos en la build (bundle principal
  354 → 98 KB).
- **Prueba de carga** (`npm run carga`, `npm run carga:ci`): p95 por endpoint y 50 conexiones SSE,
  con presupuestos en `config/presupuestos.json` que la CI hace cumplir.
- **Lighthouse** (móvil, primera medida): Destacados 59 → 96 y Fútbol 63 → 94; primer pintado 4,0 →
  1,6 s; CLS 0,28 → ≤ 0,03; accesibilidad 92 → 96 (gris apagado del tema claro con contraste ≥ 4,5
  y dos roles ARIA corregidos).
- **Pruebas de propiedades** (fast-check) para quitar el margen, Kelly, `decideStake`, topes por grupo,
  exposición agregada y adelgazamiento de snapshots; **pruebas de mutación** de las reglas de
  abstención: 35 mutantes de código y 14 de umbral, todos detectados.
- **Experiencia de desarrollo**: `web/src/lib/picks.ts`, `teamColors.ts` y `api.ts` partidos por
  debajo de 400 líneas sin cambiar importaciones; `content-visibility` en los días de los
  calendarios; `CONTRIBUTING.md` con el flujo por fases, el protocolo de experimentos y la regla de
  no inventar datos; `GET /api/rendimiento` y bloque de rendimiento en Diagnóstico.

## Fase 6 — Funciones de producto (2026-10-07)

Línea base antes de la fase: 369 tests (319 del servidor + 9 unitarios de la web + 41 de
Playwright). Después: 426 (357 + 14 + 55). Ninguna probabilidad publicada ni parámetro del modelo
cambia; nada toca una fila de las tablas inmutables. Detalle en `docs/PRODUCTO.md`.

- **Laboratorio de estrategias** (Apuestas › Laboratorio): bancos de papel con nombre y su
  configuración (deportes, ventaja mínima, Kelly, topes, cortes por pérdida, capa de confianza,
  freno de calibración), en paralelo sobre las mismas candidatas con cuotas reales que el banco
  principal. `strategies` y `strategy_bets` en el libro mayor con los triggers de `paper_bets`;
  una estrategia no se edita, se archiva. Comparación en banco, ROI, CLV, caída máxima y acierto
  sin comparar filas por debajo de 30 apuestas liquidadas.
- **«¿Qué habría pasado?»**: los backtests de tenis, fútbol y NFL guardan los partidos con cuota
  fuera del holdout (`experiments/estrategias/`) y una estrategia se reproduce día a día con la
  misma `decideEvent`. NFL guardado: 3.780 partidos de 2010 a 2023. Con la política vigente no
  apuesta ninguno (el freno de calibración, medido: el modelo pierde contra el cierre); sin el
  freno, 2.114 apuestas con ROI −4,8 % y el banco en 51,76. CLV DESCONOCIDO con solo cuota de
  cierre. Tenis y fútbol, sin cuotas históricas en la base de este entorno: el fichero se
  escribirá cuando la corrida de referencia las tenga.
- **Bandeja** (`/bandeja`, campana): cada notificación y cada alerta, con o sin canales, con
  leída/no leída, filtros y enlace al partido o al informe.
- **Resumen diario e informe semanal** (`/informes`): a partir de las 7:00 de `APP_TIMEZONE`, y el
  lunes la semana anterior; archivados sin reescritura (`reports`), enviados como `digest_listo` e
  `informe_semanal`, con PDF de texto generado en el servidor sin dependencias.
- **Comparador de líneas** (Apuestas › Líneas): mejor y peor cuota por selección y casa, consenso,
  dispersión, margen y surebets, comparando solo dentro de la línea más cotizada. Solo lectura.
- **Archivo de predicciones** (Confianza › Archivo): los cinco registros con resultado, confianza
  de la última evaluación antes del inicio, CLV de la apuesta o la señal y versión de política;
  búsqueda y filtros en la URL.
- **Operación**: migraciones 10 y 11; ocho interruptores nuevos; trabajos `resumen-diario` e
  `informe-semanal` (también con `npm run jobs -- ejecutar`); sección PRODUCTO en el doctor;
  `decideStake` admite pérdidas explícitas por banco; enlaces de las notificaciones a las rutas
  reales.
- **Hallazgos que no se cambian aquí** (son política, no producto): el banco de papel apuesta al
  consenso, no a la mejor línea como suponía la hoja de ruta; y su corte por pérdida lee el
  registro personal (`bets`) en lugar de sus propias apuestas.

## Fase 5 — Rediseño de la interfaz y sistema visual (2026-10-07)

Línea base antes de la fase: 309 tests (307 + 2 de Playwright). Ninguna probabilidad publicada
cambia. Detalle en `docs/INTERFAZ.md`.

- **Estructura**: `components/ui/index.tsx` (1.924 líneas) partido en ocho ficheros; Destacados,
  las tarjetas y los paneles grandes, en piezas (ningún componente pasa de ~430 líneas). Rutas
  reales con React Router para cada pestaña, liga, partido, equipo, jugador, Ajustes,
  Diagnóstico y Glosario, con los filtros en la query; cada pantalla en su trozo (el bundle
  principal baja de 687 kB a 333 kB). Barra inferior en el móvil (Destacados, Deportes en hoja,
  Apuestas, Confianza). Píldora de estado única (`GET /api/estado`) en lugar de los avisos de
  demo por pestaña. «Cómo le fue al modelo» solo en los deportes y Destacados; el modelo en
  vivo pasa a Confianza; la latencia, a Diagnóstico (con ingestas, `GET /api/errores`,
  trabajos, copias y cuota). Ajustes: política con «antes → después», interruptores
  (`PATCH /api/features/:nombre`), deportes visibles, cadencias (`cadenciaMin`), notificaciones,
  tema, idioma y banco personal (`GET/PUT /api/ajustes`).
- **Tarjetas y páginas**: lo secundario detrás de «¿Por qué?»; insignia de confianza con «Sin
  mercado» neutro aparte (y en la capa de confianza la falta de cuotas es DESCONOCIDO, no
  rebaja la confianza); sin truncados; chips de liga en una fila. Página de partido (deriva
  T-24h → final, cuotas por casa `GET /api/odds/casas/:id`, «¿Acertó?» `GET /api/resultado`),
  de equipo (historia del Elo `GET /api/elo/historia`, balance, forma, rotación, próximos,
  simulación), de liga (clasificación, Elo, simulación y su evolución) y de jugador.
- **Producto**: seguimiento (`/api/watchlist`, sección en Destacados, notificación de línea
  movida solo para lo seguido); «Mi selección» → borrador en Apuestas, texto, JSON, `.ics` y
  PNG (SVG del servidor `POST /api/picks/tarjeta.svg`); registro personal con importación CSV,
  etiquetas, CLV propio, «¿la habría apostado el modelo?», curva de capital y sugerencia Kelly
  (solo sugerencia); búsqueda Ctrl/Cmd+K (`GET /api/buscar`); glosario con tooltips; recorrido
  de primer uso; filtros del móvil en hoja.
- **Visual**: IBM Plex Sans autoalojada; tinta, superficies y rellenos como variables con tema
  claro (sigue al sistema o se fija en Ajustes) y los colores de estado de Tailwind en su tono
  oscuro en claro; gráficos SVG propios con resumen accesible (fiabilidad, ventana de 4 semanas
  con PSI, segmentos, deriva, cuotas por casa, Elo, simulación, curvas de capital); colores de
  club de LaLiga, Serie A, Bundesliga y Ligue 1 y las 30 franquicias NBA; foco visible,
  movimiento reducido, `aria-live`, «Baloncesto» en todas partes; catálogo i18n (español fuente,
  inglés al lado) para el armazón y las páginas nuevas, con `Intl`; sin conexión (service worker
  y aviso «Sin conexión: datos de HH:MM»).
- **Doctor**: sección ANALÍTICA E INTERFAZ (monitorización y deriva, fiabilidad, simulación,
  calendario pendiente, interruptores anulados, seguimiento). `npm run jobs -- ejecutar
  monitorizacion | simulacion-temporada` sin servidor.
- Migración v9 (`interfaz-fase-5`: `watchlist`, `scheduler_jobs.cadence_override`,
  `bets.tags`). Interruptores nuevos: `interfaz.estado`, `interfaz.diagnostico`,
  `interfaz.ajustes`, `interfaz.seguimiento`, `interfaz.busqueda`, `interfaz.temaClaro`,
  `interfaz.idiomas`, `interfaz.sinConexion`, `interfaz.recorrido`, `interfaz.glosario`,
  `apuestas.importacion`, `interfaz.muestras` (galería de capturas, apagada).
- Tests: 309 → **369** (319 del servidor + 9 unitarios de la web + 41 de Playwright: cada ruta a
  1280 y 390 px sin desbordes ni errores, barra inferior, enlaces profundos, búsqueda, recorrido,
  sin conexión, axe en claro y oscuro, capturas de la píldora, insignias y tarjeta).
  `verify:data`, doctor, typecheck, lint y build en verde. Lighthouse no está en el contenedor:
  sin medir (queda para la Fase 7).

## Fase 4 — Modelos y analítica, vía registro de experimentos (2026-10-07)

Línea base antes de la fase: 278 tests, 514 comprobaciones de `verify:data`. Ninguna probabilidad
publicada cambia en esta fase; el holdout final sigue cerrado y cada experimento lo dice.

- **Recalibración como experimento** (`experiments/recalibracion.ts`): el walk-forward devuelve las
  pérdidas por partido (modelo y recalibrado; no van al JSON) y los cinco backtests las registran
  con bootstrap emparejado y `accepted: false` (rechazado si mejora en validación, porque la
  promoción exige el holdout; no concluyente si no). Mínimo 1.000 pares.
- **Ensembles sombra en NBA, MLB y NFL**: los backtests añaden al flujo los mismos componentes que
  la ficha (NBA «Modelo completo (crudo)» y «Modelo sin descanso», nuevos también en vivo; MLB con y
  sin abridores; NFL con y sin QB) y entrenan, guardan y registran su ensemble como el tenis y el
  fútbol. El motivo de cada ensemble cita el holdout cerrado.
- **Diagramas de fiabilidad** (`evaluation/reliability.ts`, `experiments/reliability.json`, escrito
  por `informeComun`): cubetas con recuento, backtest y vivo sin mezclar.
  `GET /api/evaluation/reliability`.
- **Acierto por segmento**: cuatro segmentos genéricos en el walk-forward (favorito, banda, mes, día)
  y, en vivo, `evaluation/segmentos.ts` con acierto/Brier/log loss y CLV/ROI de papel por liga,
  favorito, resultado o lado, banda, mes y día; celdas publicadas solo con ≥ 100 predicciones o
  ≥ 30 apuestas. `GET /api/evaluation/segmentos`.
- **Monitorización** (`monitoring/series.ts`, tabla `monitoring_series`): log loss y Brier en ventana
  de 28 días, PSI contra el backtest, alerta `deriva` (PSI > 0,25 o > 2 errores típicos, nunca con
  < 100 predicciones); trabajo diario `monitorizacion`. `GET /api/monitoring`.
- **Simulación de temporada** (`simulation/`): calendario pendiente en `remaining_fixtures` desde
  openfootball (lo no jugado), nflverse (temporada entera; conferencia y división de `teams.csv` a
  `naf_teams`) y MLB Stats API (`Preview`), con reconstrucción de la doble vuelta en fútbol
  («calendario reconstruido»); Monte Carlo de 10.000 corridas con semilla fija (`rng.ts`) y las
  probabilidades del núcleo de cada deporte; reglas por liga en `config/simulation.json`; caché por
  día en `simulation_runs`; trabajo diario `simulacion-temporada`. Etiquetado «simulación, no
  predicción publicada». `GET /api/simulation/season/:sport/:league`. Test con liga sintética < 5 s.
- **Cuadro de tenis** (`simulation/torneo.ts`): `simularCuadro` probado con un cuadro sintético; sin
  fuente de cuadros la API devuelve `cuadroDisponible: false` con el motivo y los siguientes
  partidos. `GET /api/simulation/torneo`.
- **Combinadas con correlación** (`picks/parlay.ts`): conjunta de «Mi selección» con la corrección
  por pares sobre los grupos medidos; mismo partido = incompatible. `POST /api/picks/parlay`;
  Destacados enseña conjunta, independiente y vínculos.
- **Inteligencia de mercado** (`odds/intel.ts`): steam moves, surebets y referencia Pinnacle sobre
  los snapshots, etiquetado como aproximación. `GET /api/odds/intel`; panel en Destacados.
- **Qué pasaría si**: `queSi` en la evaluación servida y deslizadores en la ficha (misma curva
  logística que la capa de confianza; nunca se registra). La decisión BET/NO BET lee `minEdge` de
  la política versionada.
- Migración v8 (`analitica-fase-4`: `monitoring_series`, `remaining_fixtures`, `simulation_runs`,
  `naf_teams.conference/division`). Interruptores nuevos: `analitica.fiabilidad`,
  `analitica.segmentos`, `analitica.monitorizacion`, `simulacion.temporada`, `simulacion.torneo`,
  `picks.combinadasCorrelacion`, `mercado.inteligencia`, `confianza.queSi`.
- Docs: `docs/EXPERIMENTOS.md` (sección Fase 4), `docs/API.md` (rutas de analítica),
  `docs/plans/phase-4.md`.
- Tests: 278 → **309** (307 de node:test + 2 de Playwright). `verify:data` 514/514, doctor, typecheck, lint y
  build en verde.

## Fase 3 — Backend, API y observabilidad (2026-10-07)

Línea base antes de la fase: 260 tests, 514 comprobaciones de `verify:data`.

- **Un solo camino para predecir en una repetición** (`evaluation/replay.ts`): el backtest de fútbol
  y la reconstrucción de «¿Acertó?» usan la misma función; test de equivalencia (fútbol y NFL).
- **Salud y preparación**: `GET /health` (alias de `/healthz`) y `GET /ready` (migraciones al día y
  registro de trabajos en marcha; 503 si no), sin contraseña. Logs pino con `reqId`, `LOG_LEVEL` y
  redacción de autorización y cookies. `GET /api/metrics` en texto de Prometheus
  (`observability/metrics.ts`).
- **OpenAPI y contrato**: `@fastify/swagger` genera la especificación de todas las rutas;
  Swagger UI en `/docs` (detrás de la contraseña) y `/openapi.json`. Esquemas de respuesta en las
  rutas operativas y `api/contract.test.ts` (toda ruta en la especificación; toda respuesta cumple
  su esquema). El test cazó un fallo real: `/api/datos/estado` e `/api/ingestion-runs` estaban
  registradas bajo `/api/api/…` desde la Fase 2; corregido.
- **Exportaciones**: `GET /api/export/:dataset` y `npm run export` (predicciones, apuestas, papel,
  snapshots, benchmark) en CSV (RFC 4180) o JSON con filtros de fecha y deporte.
- **Política versionada** (`policy_versions`, append-only): la v1 son las constantes del código;
  `nuevaVersion` valida y encadena; `paper_bets` y `edge_signals` ganan `policy_version_id`
  (congelada); el banco, la capa de confianza y los topes leen la vigente. `GET/POST /api/policy`,
  `npm run policy -- show|set`.
- **Notificaciones** (`notifications/`): Telegram, webhook (Discord/Slack), correo SMTP y Web Push
  (VAPID, service worker, suscripción desde Cuenta → Notificaciones, «probar» por canal).
  Eventos: valor, línea movida, papel apostada/liquidada, trabajo fallido, deriva. Cada intento en
  `notification_log`. `npm run vapid:generar`.
- **Registro de trabajos** (`scheduler/registry.ts`, `scheduler_jobs`): puntuar en vivo,
  pre-partido, copia, resultados, clima, bullpen y cierre pasan por el registro con cadencia,
  última ejecución, duración, estado e interruptor; `GET /api/scheduler`, `PATCH …/:nombre`,
  `POST …/:nombre/ejecutar`, `npm run jobs`. Sin temporizadores sueltos en `index.ts`.
- **Estudios, ayuda y puesta en marcha**: `npm run study -- <nombre>` (`--list`; los `study:*`
  siguen como alias), `scripts/registry.mjs` + `npm run help` (test: cada script tiene línea),
  `npm run setup` (asistente), `docker-compose.yml`.
- **Documentación partida**: README de 4.011 líneas → 117 (qué es, empezar, diez comandos,
  índice) y `docs/` por tema: ARQUITECTURA (con el árbol generado por `scripts/estructura.mjs`),
  FUENTES, CUOTAS, DINERO_Y_RIESGO, EXPERIMENTOS, OPERACION, NOTIFICACIONES, API. Nada se borró.
- **CI**: `ci.yml` (secretos, lint, tipos, tests, build, `verify:data` sobre la release si
  existe, Playwright) y `nightly.yml` (backtests + `scripts/regresion-backtests.mjs` con
  `experiments/tolerancias.json`). Humo de Playwright (`web/e2e/smoke.spec.ts`,
  `scripts/e2e-server.mjs`): abre, cinco pestañas, API.
- Migración v7 (`operacion-fase-3`). Interruptores nuevos: `observabilidad.metricas`, `api.docs`,
  `operacion.registroTrabajos`, `notificaciones.canales`, `politica.versionada`.
- Tests: 260 → **278** (+2 de Playwright). `verify:data` 514/514, typecheck, lint y build en verde.

## Fase 2 — Base de datos y pipeline de datos (2026-10-07)

Línea base antes de la fase: 222 tests, 494 comprobaciones de `verify:data`.

**2A Almacenamiento**

- **Dos ficheros**: `history.db` (principal) + `ledger.db` (adjunto como `ledger`). Qué tabla va a
  cuál está en una sola lista (`server/src/db/tables.ts`); `ledgerize()` pone el prefijo a los
  `CREATE` del libro mayor sin tocar los esquemas. La base antigua se **parte al arrancar** con
  dos `VACUUM INTO` y `DROP` (ninguna fila se transforma; el original queda como
  `tennis.db.pre-split-<fecha>`). `DB_LAYOUT=single` mantiene el fichero único.
- **Migraciones numeradas** (`MIGRACIONES`, v1–v5) con `schema_version` en cada fichero; una
  fallida se deshace entera y el servidor no arranca hasta `npm run db:migrate -- --reintentar`.
- **PRAGMAs** (WAL, `synchronous=NORMAL`, `foreign_keys`, `busy_timeout`) e **índices** para las
  consultas calientes, con `EXPLAIN QUERY PLAN` en test y en `verify:data` (`npm run db:explain`).
- **Copias del libro mayor**: `npm run backup` / `npm run restore`, programadas en el servidor
  (`BACKUP_HOURS`, 24 por defecto), rotación de 14, subida S3 compatible con SigV4 propio (sin
  SDK), `integrity_check` antes de dar la copia por buena. `fly.toml`: instantáneas del volumen.
- **Retención de snapshots** (`npm run odds:retention -- --dias N [--confirmar]`): manual,
  exporta a `data/archive/*.jsonl.gz` antes de borrar, conserva apertura/T-24h/T-6h/T-1h/cierre
  por casa y selección, trigger recreado en la misma transacción.
- **`ingestion_runs`** (`conRegistro`): refrescos de cuotas por deporte, los cinco `update-data`,
  `update-results`, copias y retención. `GET /api/ingestion-runs`, `GET /api/datos/estado`.
- **Publicación**: el workflow nocturno publica `history.db.gz` desde `npm run db:export-history`;
  `check-publishable` falla si hay tablas del libro mayor; `fetch-data` exige partir antes;
  Docker lleva `history.db` como semilla y nunca `ledger.db`.
- **Doctor**: sección DATOS Y COPIAS (ficheros, migraciones, frescura de la copia, retención,
  última ingesta por fuente, ejecuciones muertas).

**2B Ingesta**

- `update-data:fb` es **incremental**: fuera el `DELETE` por liga (las fuentes ya hacían upsert en
  transacción); `--rebuild` recupera el borrado explícito. Una fuente caída ya no deja la liga vacía.
- **Resultados programados** en el servidor (`ingest/scheduler.ts`): cada `RESULTS_REFRESH_HOURS`
  (6), primera pasada a los 5 min, deporte a deporte en procesos hijo con `--skip-odds`, sin
  solaparse, con `ingestion_runs`.

**2C Fuentes nuevas** (todas con `ingestion_runs`, ninguna toca una probabilidad publicada)

- **Tenis**: `preflightTennisData`; `update-data` comprueba GitHub y tennis-data.co.uk **antes**
  de borrar la base; con ninguna disponible se para con la base intacta y el error registrado.
- **Cuotas de cierre históricas**: `fb_matches` gana `odds_source`, `ps_*` (Pinnacle temprano) y
  `psc_*` (cierre). `backtest:fb` enseña «vs mercado» etiquetado por fuente, la comparación
  contra Pinnacle al cierre con Shin y el **CLV histórico** (`football/clv.ts`). Tenis y NFL
  etiquetan su mercado; `backtest_metrics.json` gana `mercadoFuente`.
- **Clima**: `config/stadiums.json` (32 estadios NFL, 31 parques MLB), `weather/openMeteo.ts`,
  `weather_observations` (libro mayor, inmutable), ciclo cada 30 min en el servidor, en la ficha
  de NFL y MLB. Deliberadamente **no** entra en la predicción (va contra la regla; Fase 4).
- **Bullpen MLB**: `baseball/ingest/bullpen.ts`, `bsb_bullpen`, `npm run bullpen`, cada 12 h en
  el servidor; badge «bullpen cargado» en la ficha.
- **ClubElo**: `football/ingest/clubelo.ts`, `fb_external_elo`, `npm run clubelo`, baseline
  «ClubElo» en el walk-forward de fútbol. Tennis Abstract descartado (solo Elo actual).
- **Lesiones**: evaluadas; sin fuente estable → `DESCONOCIDO` con motivo (docs/BASE_DE_DATOS.md).
- Migración v6 (`fuentes-2c`), `verify:data` audita columnas Pinnacle, tablas nuevas, triggers
  del clima y que cada equipo NFL/MLB tenga estadio.

Interruptores nuevos en `config/features.json`: `datos.backupProgramado`, `datos.resultadosProgramados`,
`fuentes.cuotasHistoricas`, `fuentes.clima`, `fuentes.bullpen`, `fuentes.clubElo`.
Tests: 222 → **260**. `verify:data` 494 → **514**/514, typecheck, lint y build en verde.

## Fase 1 — Seguridad e higiene (2026-10-07)

Línea base antes de la fase: 202 tests, 494 comprobaciones de `verify:data`, Node ≥ 22.5.

- **Secretos**: `.env.example` con todas las variables; `scripts/secret-scan.mjs` (hook de
  pre-commit, CI y doctor); `.gitleaks.toml`; `.github/workflows/ci.yml` con gitleaks.
  Hallazgo: un valor con la forma de la clave de The Odds API en un comentario de
  `server/src/envFile.ts` desde `c670743`; sustituido por un marcador. **La clave hay que
  rotarla** (ver `docs/SEGURIDAD.md`).
- **Autenticación**: sesiones por cookie (`HttpOnly; SameSite=Strict; Secure` en producción),
  `POST /api/auth/login|logout`, lista y revocación de sesiones, límite de intentos (5 en 15 min,
  429 con `Retry-After`), TOTP opcional (`TOTP_SECRET`, `npm run totp:secreto`), `APP_AUTH=auto|on|off`.
  Basic Auth se mantiene. Pantalla de entrada y panel «Cuenta» en la web.
- **Asistente**: `ask/validate.ts`, lista cerrada de herramientas con argumentos acotados; test con
  entradas adversarias y test estático de que el SQL no interpola argumentos.
- **Cabeceras y límites**: CSP, nosniff, frame-ancestors, referrer, permissions, HSTS en
  producción; CORS cerrado por defecto (`CORS_ORIGINS`); cuerpo máximo 256 KB
  (`BODY_LIMIT_BYTES`); `error_log` con id de petición y respuestas de error sin pila.
- **Arranque**: `server/src/app.ts` (`buildApp`) separa la construcción de Fastify del `listen`,
  lo que permite probar rutas con `inject`. `config/features.json` y `/api/features`.
- **Node**: `engines.node >= 22.13.0` (desde donde `node:sqlite` no necesita flag).
- **Doctor**: sección SEGURIDAD (puerta, TOTP, sesiones, cabeceras, CORS, `.env` ignorado,
  escáner de secretos, hook, errores en 24 h).
- Tests: 202 → **222** (auth, validación del asistente, cabeceras/CORS/413/error_log, doctor). `verify:data` 494/494, typecheck, lint y build en verde.
