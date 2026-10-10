# Arreglos de la revisión del 8 de octubre de 2026 · Lote E (los tests que lo habrían cazado)

Este lote no arregla defectos de la app: añade las pruebas que habrían cazado los de A–D, y cada
una se demuestra **fallando contra el código de antes del arreglo** que vigila (la web o el
servidor de antes, en un `git worktree` de ese commit) y pasando con el de ahora. Donde la prueba
nueva destapa un defecto que nadie había visto, se arregla aquí con su evidencia. Mismo cierre:
doctor, tests, `verify:data`, `audit`, typecheck, lint, build y Playwright en verde.

Tres de los nueve ya tienen su prueba desde el lote en que se arregló el defecto (se escribió
fallando antes del arreglo, como pide el método). No se duplican; queda la evidencia:

| | Pide | Ya cubierto por |
|---|---|---|
| E1 | e2e con la puerta activa y la web servida (A1) | `web/e2e/auth.spec.ts` (lote A): segundo servidor en el 7391 con `APP_AUTH=on`; la web abre sin credenciales, pide la contraseña, entra; la API sigue cerrada |
| E5 | el banco de papel respeta los topes por día y por liga (A6) | `server/src/paper/topes.test.ts` («A6: el banco de papel respeta los topes por día y por liga de la política») y su gemelo de estrategias |
| E6 | restaurar de verdad el libro mayor con WAL (B1) | `server/src/db/seguridadDatos.test.ts` («B1: restaurar de verdad con WAL…»): se niega con la base abierta; cerrada, aparta lo actual con lo que estaba en el WAL y deja el destino íntegro |

## E2 · axe: el filtro de contraste no filtraba nada

**Verificado.** `rutas.spec.ts` mide el contraste aparte y se queda con `impact === 'critical'`,
pero axe califica el contraste como `serious`: la comprobación pasaba siempre. Con `serious`
aparecen fallos reales: `--ink-faint` daba 3:1 en oscuro y 2,3:1 en claro; los colores de estado
(ámbar, verde, rojo) y los de beneficio/pérdida, escritos como texto con el mismo hex en los dos
temas, se quedan en 2–3,5:1 sobre el claro; el ámbar de «Mi selección», 1,8:1. Además, sin el
filtro, axe completo marca dos reglas serias más: regiones con scroll horizontal (tablas) que no
se alcanzan con el teclado y un `aria-label` en un `div` sin rol (la barra de probabilidad del
tenis).

- **Test:** axe (WCAG 2 A/AA) en las 19 rutas, en los dos temas, a 1280 y a 390 px, y con la
  hoja de deportes y la de filtros abiertas; contraste `serious` o `critical` = fallo.
- **Arreglo:** tokens por tema en `index.css` (`--ink-faint`, `--ink-muted`, `--status-*`,
  `--profit-text`, `--loss-text`, `--seleccion`); `STATUS` son variables y `PROFIT_TEXT` /
  `LOSS_TEXT` / `NEUTRAL_TEXT` para el texto (las marcas de los gráficos siguen con sus hex, que
  pasan 3:1); `tenido()` en vez de concatenar un alfa al hex; `tabIndex={0}` en las tablas con
  scroll; `role="img"` en los tramos de la barra.

## E3 · La consola de los e2e se tragaba los fallos de recursos

**Verificado.** El filtro descarta «Failed to load resource», así que un 500 de la API pasaba. Sin
el filtro, las 19 rutas siguen limpias (no había 404 escondidos).

- **Test:** el filtro fuera; y una prueba de la prueba: con `/api/top-picks` forzado a 500, el
  recogedor de errores de consola lo ve.

## E4 · Arranque en frío sin conexión

- **Test:** se abre la app (el service worker se instala y guarda), se corta la red y se abre
  una pestaña nueva: la app pinta las pestañas y el aviso «Sin conexión». Contra la web del
  lote C se queda en blanco (`estadoAuth()` lanzaba sin red: D6).

## E7 · La cabecera de la ficha es la probabilidad de Destacados

- **Test del servidor (integración por HTTP):** se sirve un partido de la NHL, una ingesta mueve
  el Elo, y la probabilidad del favorito en `/api/top-picks` es la misma que la cabecera de
  `/api/nhl/games/:id`. Contra el servidor del lote C, difieren (D1).

## E8 · Ninguna clave cruda en pantalla

- **Test e2e:** en las 19 rutas, ningún texto visible es una clave del catálogo (`es.ts`) ni una
  clave de la política (`grupo.clave`, de `/api/policy`). Contra la web del lote C falla en
  Ajustes (`recortes.oodLeve`…, D4).

## E9 · La ingesta de baloncesto nunca deja los ratings vacíos a otro proceso

El test de A5 mira la base desde la misma conexión mientras se descarga. Lo que pasa de verdad es
que `npm run update-data:basketball` corre en OTRO proceso mientras el servidor lanza el ciclo
pre-partido con su reloj.

- **Test:** un proceso hijo lee `bb_team_ratings` en bucle con su propia conexión mientras el
  padre ingiere (descarga lenta y simulada): el mínimo visto nunca es 0. Contra el código de antes
  de A5 ve 0 durante toda la descarga.

## Resultado

Las seis pruebas nuevas, pasadas contra el código del lote C (un `git worktree` de 7840a64,
servidor para E7 y web construida para E2, E4 y E8): fallan todas. E3 es una prueba de la propia
red de e2e (el filtro de antes descartaba «Failed to load resource» por expresión regular, que es
como sale el 500) y E9 lleva su control negativo dentro.

Lo que destapó E2 y se arregló aquí:

- **Contraste.** `--ink-faint` (3:1 en oscuro, 2,3:1 en claro) y `--ink-muted`; los colores de
  estado y de beneficio/pérdida como texto, iguales en los dos temas (2–3,5:1 sobre el claro);
  el ámbar de «Mi selección» (1,8:1); el gris de «sin cambios» del banco de papel (4,1:1); un
  rosa y un gris claro escritos a mano en la ficha de tenis y de baloncesto. Ahora son tokens por
  tema; los hex de los gráficos (marcas, que piden 3:1) no cambian.
- **Teclado.** Las 14 tablas con scroll horizontal no se alcanzaban con el teclado
  (`tabIndex={0}`); los tramos de la barra de probabilidad llevaban `aria-label` sin rol.

Lo que destapó E8: Ajustes enseña los nombres de los interruptores (`informes.diario`,
`analitica.fiabilidad`…), que son identificadores de configuración y coinciden con claves del
catálogo. Van ahora como código (`<code>`), igual que la lista de interruptores de arranque, y la
prueba ignora el texto en `<code>`.

| | Antes (lote D) | Después |
|---|---|---|
| Tests del servidor | 502 | 505 |
| Tests de la web | 51 | 51 |
| Playwright | 79 | 86 |
| axe | Destacados y Ajustes, 1280 px, contraste solo «critical» | 19 rutas × 2 temas × 2 anchos + 2 hojas, contraste desde «serious»: 0 fallos |
| `verify:data` | 528 | 528 |
| `audit` | 4688 | 4688 |
| Doctor (sin red) | 1 error y 3 avisos del entorno | los mismos |
