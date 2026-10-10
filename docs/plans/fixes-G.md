# Lote G · Lo que encontró la prueba en el navegador (9–10 de octubre de 2026)

Después de los lotes A–E, el agente `ui-tester` recorrió la app construida con la base real (no la
de demostración de los e2e), a 1280 y 390 px, en claro y oscuro, y con una copia de producción.
Todo lo automático estaba en verde y aun así encontró defectos: tres en cosas que los lotes D y E
daban por arregladas. Cada uno se reproduce aquí con un test que falla antes del arreglo. Mismo
cierre: doctor, tests, `verify:data`, `audit`, typecheck, lint, build y Playwright en verde.

| | Hallazgo | Causa verificada en el código |
|---|---|---|
| G1 | Los horizontes futuros (T-6h, T-1h, final) enseñan una probabilidad, nunca «pendiente» (D2 no servía con datos reales) | `horizontes()` rellena una marca futura con la última instantánea anterior (`aFecha`), así que `fila` nunca es nula; el test de D2 solo probaba filas nulas |
| G2 | `?torneo=` se pierde al recargar el tenis (D8 no cubrió el tenis) | El efecto «torneo válido» corre antes de que llegue la lista de torneos, la ve vacía y pone `null` |
| G3 | Fútbol: al cambiar de liga, la liga anterior se ve bajo la nueva mientras carga | Las filas viejas siguen en el estado hasta que llega la respuesta; nada filtra por liga |
| G4 | «Salir» desde la lista de sesiones no vacía la caché de la API (D6) | Esa vía llama a `revocar()` y a `onSalir`, nunca a `salir()` |
| G5 | Formatos numéricos mezclados (D5 incompleto): «cuota 2.29», «±4.7 pp», «41.6%» junto a «41,2 %» | `t()` escribe los números con `String(v)`; algunos componentes pintan el número crudo; el texto explicativo del servidor usa `toFixed` y «%» pegado; varias claves del catálogo llevan «{p}%» |
| G6 | Contraste insuficiente con datos reales (E2 pasaba porque la base de los e2e no tiene esos elementos): insignia de la campana, insignias de confianza baja y media en claro, filas pasadas de «Hoy», monogramas de equipo, contadores de las fichas, botón de entrar | Texto oscuro sobre el rojo de estado; tintes al 14 % sobre fondos ya tintados; `opacity` para atenuar texto; tinta del monograma por umbral de luminancia y no por contraste; azul de datos como fondo de botón |
| G7 | Con la puerta activa, a 1280×860, «Salir» queda fuera de la pantalla al abrir «Cuenta» | La barra lateral es `sticky` con la altura de la pantalla y sin scroll |
| G8 | A 390 px la lista de «Hoy» se corta por la derecha | La tabla es más ancha que su caja y no se adapta |
| G9 | Equipo y Liga de la NHL piden `/api/simulation/season/nhl/…` y dejan un 404 en consola | La web pide la simulación para todos los deportes; el servidor solo la tiene para fútbol, baloncesto, béisbol y NFL |
| G10 | La pantalla de entrada deja dos 401 en consola (`/api/features`, `/api/watchlist`) | El service worker y la lista de seguidos se piden antes de entrar |
| G11 | El buscador es `aria-modal` pero no atrapa el foco, no lo devuelve y no bloquea el fondo | No usa `useDialogo` (D10 no lo listaba) |
| G12 | `/api/auth/me` devuelve el usuario a quien no ha entrado | La respuesta lo incluye siempre |

Fuera de este lote, con su motivo: el texto de los experimentos registrados en `/confianza`
(«Δ logloss +0.0005 … p 0.000») viene tal cual de `experiments/registry.jsonl`, que no se
reescribe; las fichas de demostración pasadas que siguen como próximas son de la ventana de la
demostración (lote F, frescura de datos); la etiqueta del eje Y recortada en la deriva es cosmética
y queda anotada.

## Prueba y arreglo, uno por uno

Cada prueba se pasó primero contra el código de antes del arreglo, donde falla (la columna «antes»
es lo que dijo entonces). Excepción: G2 y G3 prueban dos funciones nuevas (`torneoValido`,
`filasDeLaLiga`) porque la lógica estaba enterrada en el componente; su «antes» es lo que vio la
prueba en el navegador, y la segunda pasada de `ui-tester` lo vuelve a mirar en la app.

| | Prueba (falla antes) | Antes | Arreglo |
|---|---|---|---|
| G1 | `server/src/prematch/pendiente.test.ts` | el T-1h de un partido de mañana traía la probabilidad de hoy | `horizontes()` recibe `ahora` y solo rellena una marca que ya llegó; la evaluación de los partidos jugados pasa el saque inicial, así que puntúa las mismas filas que antes |
| G2 | `web/src/lib/carga.test.ts` (`torneoValido`) | con la lista aún vacía, el torneo pasaba a `null` | el tenis solo corrige el torneo cuando ya tiene la lista del circuito que pidió |
| G3 | `web/src/lib/carga.test.ts` (`filasDeLaLiga`) | las filas de la liga anterior seguían en pantalla | las filas se filtran por la liga elegida mientras llega la respuesta |
| G4 | `web/src/lib/auth.test.ts` | revocar la sesión actual no vaciaba la caché de la API | `vaciarCacheApi()`, también desde la lista de sesiones |
| G5 | `e2e/interfaz.spec.ts` (G5), `web/src/i18n/numeros.test.ts`, `server/src/prediction/formatoTexto.test.ts`, `server/src/numeros.test.ts` | 43 líneas en pantalla con «2.29», «41.6%», «±3.6 pp»; 28 frases del servidor | `t()` escribe los números en el idioma; el catálogo español lleva «{p} %» con espacio duro y coma; el servidor escribe sus frases con `server/src/numeros.ts`; los márgenes «±x pp» y los porcentajes grandes pasan por `lib/formato.ts` |
| G6 | `e2e/interfaz.spec.ts` (G6, dos temas), `e2e/auth.spec.ts` (G6, dos temas), `web/src/lib/tokens.test.ts`, `web/src/lib/teamColors.test.ts` | campana 3,45; filas empezadas de «Hoy» 2,07–2,88 (claro) y 2,40–3,96 (oscuro); contadores 2,83; botón de entrar 3,55; error de entrada 3,23; estados teñidos 3,86–4,49; decenas de escudos por debajo de 4,5 | la campana usa `--ink-on-fill`; las filas empezadas, tinta tenue en vez de `opacity`; los contadores, `--ink-soft`; el botón, tinta oscura sobre el azul; los errores y el veredicto, los tokens de estado; los estados del tema claro un 6–12 % más oscuros y los del oscuro un 6–10 % más claros; la tinta del escudo se elige por contraste y el relleno se sombrea lo justo si ninguna llega |
| G7 | `e2e/auth.spec.ts` (G7) | «Salir» fuera de la pantalla con 12 sesiones | la barra lateral se desplaza (`overflow-y-auto`) |
| G8 | `e2e/interfaz.spec.ts` (G8) | tabla de 421 px en una caja de 356 | el favorito puede partirse en dos líneas; el porcentaje no |
| G9 | `server/src/simulation/simulables.test.ts` | Equipo y Liga de la NHL pedían una simulación que no existe | `DEPORTES_SIMULABLES` en el servidor y `lib/simulacion.ts` en la web |
| G10 | `e2e/auth.spec.ts` (G10) | dos 401 en la pantalla de entrada | el service worker se registra y los seguidos se piden solo dentro |
| G11 | `e2e/interfaz.spec.ts` (G11) | el foco salía del buscador y no volvía | el buscador usa `useDialogo` |
| G12 | `server/src/auth/puerta.test.ts` | `/api/auth/me` decía el usuario sin sesión | el usuario solo va con una sesión válida |

Encontrado por el camino y arreglado en G6, porque es la misma causa (un rojo del tema oscuro usado
como texto en el claro, 3,2:1 sobre blanco): el error de la pantalla de entrada, los tres errores de
Ajustes y el veredicto «acertó / falló» con su icono.

Por qué E2 no lo vio: axe deja como «incompleto» (no como fallo) el texto con `opacity` o sobre un
fondo `color-mix`, y la base de los e2e no tiene partidos empezados, avisos sin leer ni escudos de
clubes reales. `e2e/util.ts` gana `contrastes()`, que mide el contraste que se ve contando la
opacidad y la pila de fondos, y las pruebas de G6 simulan `/api/today` y `/api/bandeja/contador`
con las formas reales de la API.
