# La interfaz

Cómo está hecha la pantalla desde la Fase 5: rutas, navegación, tema, idiomas, accesibilidad y
las páginas nuevas. Cada función tiene su interruptor en `config/features.json` (y se puede
anular desde Ajustes).

## Rutas y estado en la URL

Cada pestaña, liga, partido, equipo, jugador y página tiene su URL (`web/src/rutas.ts`):
`/destacados`, `/futbol/:liga`, `/baloncesto/:liga`, `/beisbol/:liga`, `/nfl/:liga`,
`/tenis/:tour`, `/apuestas`, `/confianza`, `/confianza/diagnostico`, `/ajustes`, `/glosario`,
`/partido/:deporte/:id`, `/equipo/:deporte/:liga/:id`, `/jugador/:tour/:id` y
`/liga/:deporte/:liga`. Los filtros van en la query (`?dia=`, `?torneo=`, `?horas=`, `?orden=`,
`?deportes=`, `?min=`, `?alta=`, `?cuota=`) y se restauran al abrir el enlace
(`web/src/lib/rutas.ts`). La raíz lleva a la última pestaña abierta. El servidor sirve
`index.html` en cualquier ruta. Cada pantalla es un trozo aparte (`React.lazy`): la primera
carga trae el armazón y la pestaña que se abre.

## Navegación

Desde 1024 px, barra lateral con la píldora de estado, la búsqueda, las pestañas (con flechas,
Inicio y Fin) y los enlaces a Ajustes, Diagnóstico y Glosario. Por debajo, la cabecera lleva la
marca, la búsqueda y la píldora, y una barra inferior da cuatro destinos: Destacados, Deportes
(abre una hoja con los siete), Apuestas y Confianza. Las teclas 1–9 y 0 (la décima) cambian de pestaña y
Ctrl/Cmd+K abre la búsqueda (`GET /api/buscar`: equipos, jugadores, partidos, ligas y páginas).

## Píldora de estado

Una sola, en lugar de un aviso de demo por pestaña (`GET /api/estado`): modo de cuotas (real o
demo), hasta cuándo llegan los datos de cada deporte y cuántos próximos hay, la última pasada
de resultados, la última copia del libro mayor, los errores del servidor en 24 h y los
trabajos con error. Su detalle enlaza a Diagnóstico.

## Diagnóstico y Ajustes

Diagnóstico (`/confianza/diagnostico`) junta la latencia del escáner, el estado de los
trabajos, las ingestas por fuente, los errores (`GET /api/errores`, sin pila ni agente), la
base y sus copias, y la cuota de The Odds API. Ajustes (`/ajustes`) cambia el tema, el idioma,
los deportes visibles, el banco personal, la política de apuestas (cada cambio es una versión
nueva, con «antes → después» y confirmación), la cadencia de cada trabajo
(`PATCH /api/scheduler/:nombre` con `cadenciaMin`, o `null` para la del código), los canales
de notificación y los interruptores (`PATCH /api/features/:nombre`; la anulación se guarda en
el libro mayor y manda sobre el fichero hasta que se quita). `GET/PUT /api/ajustes` solo
acepta claves conocidas y valores válidos.

## Tarjetas y confianza

A la vista, una línea por concepto: la probabilidad, la cuota contra la justa y la insignia de
confianza; el resto (goles o carreras esperados, números clave, desglose) detrás de «¿Por
qué?». La insignia distingue «Sin mercado» (gris) de «Confianza baja» (rojo): no tener cuotas
no es dudar del modelo, y en la capa de confianza la falta de cuotas cuenta como dato
DESCONOCIDO, no como malo. Ningún nombre se trunca: salta de línea. Cada tarjeta enlaza a su
partido.

## Páginas de partido, equipo, liga y jugador

La de partido es la que se comparte: la tarjeta del deporte, la deriva T-24h → final
(instantáneas pre-partido), las cuotas por casa (`GET /api/odds/casas/:id`, las ocho casas con
más observaciones) y, con resultado, «¿Acertó?» (`GET /api/resultado/:deporte/:clave`). Con
`?clave=` se abre aunque el partido ya no esté entre los próximos. La de equipo enseña el Elo
antes de cada partido (`GET /api/elo/historia/...`, la misma reproducción que la ficha,
cacheada por día), el balance, la forma, la rotación en béisbol, los próximos con su
probabilidad y lo que dice la simulación de temporada. La de liga pone la clasificación junto
al puesto por Elo y las probabilidades simuladas, con su evolución día a día
(`…/historial`). La de jugador, Elo general y por superficie, saque, últimos partidos y
próximos.

## Seguimiento, «Mi selección» y registro personal

La estrella sigue un equipo, un jugador o un partido (`/api/watchlist`, libro mayor). En
Destacados lo seguido sale primero, y la notificación de línea movida solo se manda para lo
seguido. «Mi selección» calcula la conjunta con la correlación medida y se puede enviar a
Apuestas como borrador, copiar como texto, descargar en JSON o en `.ics` (con la probabilidad
en la descripción) y guardar como imagen (`POST /api/picks/tarjeta.svg`, que el navegador pasa
a PNG). En el registro personal: importación CSV (`POST /api/bets/import`), etiquetas, el CLV
de cada apuesta propia cuando hay snapshot que casar (`GET /api/bets/:id/clv`), «¿la habría
apostado el modelo?» con la ventaja mínima de la política, la curva de capital y la sugerencia
de stake con la misma política Kelly (`GET /api/bets/sugerencia`; nunca coloca nada).

## Tema, tipografía y colores

La tinta, las superficies y las líneas son variables CSS (`web/src/index.css`): el tema oscuro
de siempre y uno claro con los mismos nombres, que sigue a `prefers-color-scheme` salvo que se
fije en Ajustes. Los colores de datos (`web/src/lib/theme.ts`) no cambian con el tema. Los
colores de estado pálidos de Tailwind pasan a su tono oscuro en claro. La fuente es IBM Plex
Sans servida desde el propio bundle (`@fontsource`), con cifras tabulares. Los colores de club
cubren la Premier, LaLiga, Serie A, Bundesliga, Ligue 1, NFL, MLB y las 30 franquicias de la
NBA; lo demás sale en gris neutro.

## Gráficos

Un solo juego de gráficos SVG propio (`web/src/components/charts`): líneas, sparkline, barras,
diagrama de fiabilidad e histograma, con los colores de datos y un resumen en texto para
lectores de pantalla. Se usan para la fiabilidad por deporte, la ventana móvil de Brier y log
loss con el PSI y el acierto por segmento (Confianza › Analítica del modelo), la deriva y las
cuotas por casa (partido), la historia del Elo y la distribución de la posición final (equipo),
la evolución de la simulación (liga) y la curva de capital (banco de papel y registro propio).

## Idiomas

El texto vive en `web/src/i18n/es.ts`, la fuente de verdad, y `en.ts` lo traduce; una clave
sin traducción cae al español. Toda la interfaz pasa por el catálogo (~1.800 claves): armazón,
páginas, las cinco pestañas de deporte, sus tarjetas y paneles. El idioma sale de Ajustes, si no
del navegador. Números, fechas y moneda se formatean con `Intl` según el idioma; las cifras con
decimales llevan coma en español y punto en inglés. Un test comprueba que el inglés no inventa
claves, que las tiene todas y que las variables coinciden, y `web/e2e/idioma.spec.ts` recorre la
app en inglés.

- `t(clave, vars)` para texto; `conNodos(texto, nodos)` para una frase con negritas o enlaces
  dentro, en el orden de cada lengua; `codigo(t, c)` para los códigos del servidor (ALTA, NO BET…).
- `en.ts` va en su propio trozo de JS: se pide al arrancar solo si la visita es en inglés, la
  primera pintada lo espera y, si no llega, la app sale en español. El paquete principal no lo
  lleva.
- Queda en español a propósito lo que escribe el servidor (razones, notas, veredictos): traducirlo
  exigiría que la API hablara dos idiomas. Y los ejemplos de «Preguntar a los datos», porque el
  analizador entiende español.

## Accesibilidad, sin conexión y primer uso

Pestañas con sus roles y flechas, anillos de foco visibles, movimiento reducido, `aria-live`
en avisos y alertas, y etiquetas unificadas («Baloncesto» en todas partes). Playwright pasa axe
en los dos temas. El service worker guarda el armazón y la última respuesta de cada GET de la
API; sin conexión aparece «Sin conexión: datos de HH:MM». El recorrido de primer uso explica la
píldora, la insignia y el modo demo; se ve una vez y se recuerda.

## Pruebas de la interfaz

`npm run e2e` (Playwright): cada ruta a 1280 y 390 px sin scroll horizontal ni errores de
consola, la barra inferior con sus cuatro destinos, los enlaces profundos, el recorrido, la
búsqueda, sin conexión, axe en claro y oscuro, y capturas de la píldora, de las insignias y de
la tarjeta de partido. Las capturas usan la galería `/_muestras` (interruptor
`interfaz.muestras`, apagado por defecto), con datos de ejemplo fijos y rotulados como tales.
`npm test` corre además las pruebas unitarias de la web (colores de club, exportaciones de la
selección, forma común de los partidos, catálogo de idiomas, glosario).
