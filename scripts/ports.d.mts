// Tipos de ports.mjs, para que `npm run build` no se caiga.
//
// ===========================================================================
// POR QUÉ HACE FALTA ESTE FICHERO
// ===========================================================================
// `web/vite.config.ts` importa las constantes de puerto de `scripts/ports.mjs`, que
// es JavaScript suelto. `web/tsconfig.node.json` compila vite.config.ts con `strict`
// y sin `allowJs`, así que un import sin declaraciones es un error:
//
//     vite.config.ts(6,59): error TS7016: Could not find a declaration file for
//     module '../scripts/ports.mjs'
//
// Y eso ROMPÍA `npm run build`, que es `tsc -b && vite build`. Pasó desapercibido
// mucho tiempo porque el chequeo que se usaba a diario es
// `tsc -p web/tsconfig.app.json`, y esa configuración NO incluye vite.config.ts: el
// fichero roto era justo el único que el chequeo rápido no mira.
//
// ===========================================================================
// POR QUÉ UN .d.mts Y NO allowJs
// ===========================================================================
// Poner `allowJs: true` también lo callaría, pero apagando la comprobación para todo
// lo que entre por ahí en el futuro. Esto declara los tres valores y nada más: si
// alguien renombra una constante en ports.mjs, el build vuelve a fallar, que es
// exactamente lo que tiene que pasar.
//
// Los nombres y el significado están en ports.mjs; aquí solo van los tipos.

/** El puerto del frontend — la dirección que se abre y se guarda en favoritos. */
export const DEFAULT_WEB: number;

/** El puerto de la API REST. Uno por encima del web, a propósito. */
export const DEFAULT_API: number;

/** Donde `npm run preview --workspace web` sirve el bundle ya construido. */
export const DEFAULT_PREVIEW: number;
