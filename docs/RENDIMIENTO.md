# Rendimiento

Cómo se mide, qué se hizo en la Fase 7 y qué presupuestos vigila la CI. Plan en
[plans/phase-7.md](plans/phase-7.md).

## Medir

```sh
npm run carga                                 # contra el servidor en marcha (localhost:7374)
node scripts/carga.mjs --url http://host:puerto
npm run carga:ci                              # arranca el servidor de e2e (base de demostración) y falla fuera de presupuesto
```

`scripts/carga.mjs` pide cada endpoint de `config/presupuestos.json` 60 veces con 6 peticiones a
la vez, por HTTP y aceptando compresión como un navegador, y calcula p50, p95 y máximo. Después
abre 50 conexiones SSE a `/api/latency/stream` a la vez, mide el primer byte y comprueba que un
endpoint normal sigue respondiendo con ellas abiertas. Sin dependencias.

## Antes y después (Fase 7)

Base completa de este entorno, p50 / p95 en ms con 6 peticiones a la vez:

| Endpoint | Antes | Después |
|---|---|---|
| `/api/football/fixtures/upcoming` | 3.808 / 8.570 | 64 / 129 |
| `/api/basketball/games/upcoming` | 2.347 / 5.216 | 12 / 24 |
| `/api/matches/upcoming?tour=atp` | 1.235 / 2.769 | 20 / 37 |
| `/api/nfl/games/upcoming` | 1.202 / 2.737 | 21 / 42 |
| `/api/baseball/games/upcoming` | 613 / 1.370 | 13 / 27 |
| SSE, 50 conexiones: primer byte p95 | 50 | 40 |

Tamaño de la lista de próximos de fútbol: 1,4 MB sin comprimir → 147 KB con Brotli (197 KB con
gzip). El bundle principal de la web: 354 KB → 98 KB con Brotli (435 KB tras pasar todo el texto al
catálogo de idiomas en el seguimiento, 442 KB con la NHL; el inglés va aparte, en un trozo de 109 KB
que solo se pide en inglés); los 133 ficheros de texto de
`web/dist`, de 2,2 MB a 613 KB.

## Qué se hizo

- **Caché de próximos con invalidación por datos** (`server/src/cache/respuestas.ts`, interruptor
  `rendimiento.cacheProximos`). Cada lista de próximos se guarda en memoria con una firma de sus
  datos: `PRAGMA data_version` (cambia cuando otro proceso escribe la base: `update-data`,
  `update-results`), un hash de las filas de la tabla de próximos (cambia con cada cuota, abridor,
  QB o partido) y, en fútbol, alineaciones y noticias. Dura como mucho dos minutos por lo que
  depende de la hora. El ciclo pre-partido la calienta cada 15 minutos. La primera petición de
  cada versión calcula y registra como siempre; ninguna probabilidad cambia. Aciertos y fallos en
  `/api/metrics` (`cache_respuestas_total`) y en Diagnóstico (`GET /api/rendimiento`).
- **Compresión y ETag** (`server/src/http/compresion.ts`, `rendimiento.compresion`): Brotli o gzip
  para lo que sea texto de más de 1 KB, con los últimos cuerpos comprimidos guardados por ETag;
  ETag débil y `Cache-Control: no-cache` en todo `GET /api/*`, con 304 sin cuerpo si no ha
  cambiado. La build deja `.br` y `.gz` junto a cada asset (`scripts/comprimir-dist.mjs`) y el
  servidor los sirve tal cual; el `index.html` sigue sin caché.
- **Presupuestos en CI**: `config/presupuestos.json` fija un p95 por endpoint de unas cinco veces lo
  medido con la base de demostración (mínimo 150 ms; 400 ms para `/api/system-trust`; SSE: primer
  byte 250 ms). Una máquina de CI más lenta no da falsos fallos y una vuelta atrás como la de
  antes de la caché —decenas de veces más lenta— sí falla.

## La web: Lighthouse

Medido por primera vez en esta fase, con Lighthouse 12 (móvil, red y CPU simuladas) sobre la base
de demostración. «Antes» es la misma app con la compresión apagada y la web sin precomprimir:

| Página | Rendimiento | Primer pintado | Mayor pintado | Desplazamiento (CLS) | Peso |
|---|---|---|---|---|---|
| Destacados, antes | 59 | 4,0 s | 4,6 s | 0,284 | 563 KB |
| Destacados, después | 96 | 1,6 s | 2,7 s | 0,026 | 213 KB |
| Fútbol, antes | 63 | 3,6 s | 4,4 s | 0,258 | 649 KB |
| Fútbol, después | 94 | 1,8 s | 2,9 s | 0,001 | 240 KB |

Accesibilidad 92 → 96 y buenas prácticas 100 en las dos. Además de la compresión, dos arreglos de
desplazamiento que Lighthouse señaló: el `main` ocupa al menos la pantalla (el pie ya no salta cuando
llega la página, que se carga aparte) y el panel «Hoy» reserva su alto mientras carga (el de la
última visita, o el habitual). Y dos de accesibilidad: el gris apagado del tema claro baja a
`#626875` (contraste ≥ 4,5 en todas las superficies claras) y dos roles ARIA mal puestos. Los días
de los calendarios llevan `content-visibility: auto`: los que están fuera de pantalla no se pintan
hasta acercarse. Lighthouse falla a veces en este contenedor con `NO_NAVSTART` (un fallo de su
trazado, no de la página); se repite la medida.

## Pruebas de propiedades y de mutación

- `server/src/test/propiedades.test.ts` (fast-check, 500 casos generados por propiedad): los tres
  métodos de quitar el margen suman 1, dejan cada probabilidad en (0, 1) y conservan el orden, y el
  multiplicativo recupera exactamente las probabilidades de partida; Kelly nunca apuesta sin ventaja
  y crece con p; `decideStake` da céntimos hacia abajo, nunca pasa el tope por partido ni la
  exposición libre y corta sin ventaja o por pérdidas; los topes por grupo de correlación nunca
  dejan pasar un grupo; la exposición efectiva nunca pasa de la ingenua; y adelgazar snapshots
  conserva apertura, última, cada marca y el cierre, y es idempotente.
- `server/src/trust/mutantes.test.ts`: 26 casos frontera de la regla de abstención (exactos en
  binario: ventaja mínima 0,25, p 0,625, cuota 2,0) que tienen que matar 35 mutantes de código de
  `decidir` (cada comparación de las condiciones cambiada, cada `grave` negado, cada regla y cada
  recorte quitados) y 14 mutantes de umbral (cada número de la política desplazado con una versión
  nueva). Un mutante vivo es una regla que ningún caso vigila, y el test lo nombra. Se comprobó que
  el arnés detecta los vivos: quitando dos casos frontera sobreviven exactamente sus dos mutantes.

