/**
 * Códigos de país → bandera, sin inventar.
 *
 * ===========================================================================
 * POR QUÉ ESTE FICHERO EXISTE, Y POR QUÉ NO HAY NINGÚN `slice(0, 2)`
 * ===========================================================================
 * La versión anterior tenía 28 países a mano y, para todo lo demás, cortaba las dos
 * primeras letras del código del COI y lo trataba como ISO-3166. Eso funciona para
 * ESP→ES y falla en silencio para una cuarta parte del circuito:
 *
 *     RSA → RS   un sudafricano con la bandera de SERBIA
 *     CHI → CH   un chileno con la de SUIZA
 *     SLO → SL   un eslovaco con la de SIERRA LEONA
 *     EST → ES   un estonio con la de ESPAÑA
 *     ESA → ES   un salvadoreño, también con la de España
 *     UAE → UA   un emiratí con la de UCRANIA
 *     PAK → PA   un pakistaní con la de PANAMÁ
 *     PAR → PA   un paraguayo, también con la de Panamá
 *
 * Eran 318 jugadores de 1.272, y ni uno salía en blanco: todos salían con una bandera
 * equivocada y segura de sí misma. Eso es peor que no poner bandera, porque un hueco se
 * lee como «no lo sé» y una bandera se lee como «es de aquí».
 *
 * De ahí la regla de este módulo: UN CÓDIGO QUE NO ESTÁ EN LA TABLA NO TIENE BANDERA.
 * `iso2()` devuelve null y quien pinta muestra las tres letras en una pastilla neutra.
 * No hay heurística de respaldo, porque una heurística de respaldo es exactamente lo que
 * produjo los 318.
 *
 * ===========================================================================
 * LA TABLA ES EL JUEGO COMPLETO DEL COI, NO LOS 103 QUE HAY HOY EN LA BASE
 * ===========================================================================
 * Cuesta lo mismo y evita el caso molesto: un jugador de un país nuevo entra en el
 * circuito y aparece sin bandera hasta que alguien lo note. `verify:data` comprueba que
 * todos los códigos de la base resuelven, así que si algún día entra uno que no está,
 * lo dice un check en vez de un hueco que nadie mira.
 */

import countriesJson from '../../../config/countries.json';

/** Un país: su ISO-3166 alpha-2 (el que nombra el fichero de la bandera) y su nombre. */
export interface Country {
  iso2: string;
  /** En español, para el `title` de la bandera. «GBR» no le dice nada a nadie. */
  name: string;
}

/**
 * Códigos que significan «no se sabe», y no son un país que falte en la tabla.
 *
 * El archivo de Sackmann escribe `N/A` para el jugador sin nacionalidad conocida. Sin
 * esta lista, `verify:data` lo denunciaría como país sin mapear y la respuesta sería
 * añadir un país inventado a la tabla para callar el check.
 */
export const UNKNOWN_COUNTRY = new Set(['N/A', 'UNK', 'XXX', '']);

/**
 * Código del COI (o ISO-3166 alpha-3) → país.
 *
 * La tabla vive en `config/countries.json`, el mismo directorio raíz desde el que los
 * cinco deportes leen sus ligas y torneos. No está aquí por un motivo concreto: el
 * `verify:data` del servidor tiene que comprobar que TODOS los países de la base
 * resuelven y que su bandera está en disco, y un check que lee una copia distinta de la
 * tabla que la que pinta la pantalla no comprueba nada. Con el JSON compartido hay una
 * sola tabla y los dos lados leen esa.
 *
 * Incluye el juego completo del COI más los alias ISO-3166 alpha-3 que cambiarían de
 * país con la norma equivocada (`PRY` Paraguay, `SVN` Eslovenia, `DEU` Alemania…),
 * porque el archivo mezcla las dos normas: Paraguay sale 6 veces como `PAR` y 2 como
 * `PRY`.
 */
const COUNTRIES = countriesJson as Record<string, Country>;

/** ISO-3166 alpha-2 en minúscula, o null si el código no está en la tabla. */
export function iso2(code: string | null | undefined): string | null {
  if (!code) return null;
  const key = code.trim().toUpperCase();
  if (UNKNOWN_COUNTRY.has(key)) return null;
  return COUNTRIES[key]?.iso2 ?? null;
}

/** El nombre en español, o el propio código si no se conoce. Para el `title`. */
export function countryName(code: string | null | undefined): string {
  if (!code) return '';
  const key = code.trim().toUpperCase();
  if (UNKNOWN_COUNTRY.has(key)) return 'país desconocido';
  return COUNTRIES[key]?.name ?? key;
}

/** La ruta de la bandera en `public/`, o null. `fetch-flags` deja los ficheros ahí. */
export function flagSrc(code: string | null | undefined): string | null {
  const two = iso2(code);
  return two ? `/flags/${two}.svg` : null;
}

/** Todos los ISO-2 de la tabla, sin repetir. Lo usa el script que baja las banderas. */
export function allIso2(): string[] {
  return [...new Set(Object.values(COUNTRIES).map((c) => c.iso2))].sort();
}

/** ¿Está este código en la tabla? Lo pregunta `verify:data`. Distinto de «desconocido». */
export function isMapped(code: string | null | undefined): boolean {
  if (!code) return true;
  const key = code.trim().toUpperCase();
  return UNKNOWN_COUNTRY.has(key) || key in COUNTRIES;
}

// ---------------------------------------------------------------------------
// BANDERAS QUE NO SON PAÍSES DEL COI
// ---------------------------------------------------------------------------
// Las cabeceras de liga necesitan dos que la tabla de arriba no tiene y no debe tener:
// la Unión Europea (la Euroliga de baloncesto y la Champions juegan bajo ella, no bajo
// un país) e Inglaterra, que en el COI no existe como tal — compite como GBR — pero es
// el «país» de la Premier y tiene su propia bandera.
//
// `fetch-flags.mjs` las baja junto con las demás; Escocia y Gales están puestas porque
// añadir su liga es lo próximo más probable y bajarlas cuesta cero.
export const EXTRA_FLAGS: Record<string, string> = {
  EU: 'eu',
  ENG: 'gb-eng',
  SCO: 'gb-sct',
  WAL: 'gb-wls',
};

/**
 * La bandera de la sede de una liga, que NO llega en el mismo formato en los cinco
 * deportes.
 *
 * Baloncesto, béisbol y NFL guardan un ISO-2 a secas (`"US"`, `"JP"`, `"EU"`). El fútbol
 * guarda una etiqueta ya montada con su emoji delante (`"🇪🇸 España"`,
 * `"🏴󠁧󠁢󠁥󠁮󠁧󠁿 Inglaterra"`), porque ahí el nombre del país también se enseña.
 *
 * Se aceptan los dos en vez de migrar cuatro ficheros de configuración por una
 * decoración. Del emoji se sacan los indicadores regionales a la inversa: cada uno es
 * `0x1F1E6 + (letra - 'A')`, así que restando se recupera el ISO-2. La bandera de
 * Inglaterra no es un par de indicadores sino una secuencia de etiquetas, y esa se
 * reconoce por su primer punto de código.
 */
export function leagueFlagSrc(country: string | null | undefined): string | null {
  if (!country) return null;
  const trimmed = country.trim();
  if (!trimmed) return null;

  const first = [...trimmed][0];
  const cp = first?.codePointAt(0) ?? 0;

  // --- Etiqueta con emoji delante (fútbol) ---
  if (cp === 0x1f3f4) {
    // Bandera negra + etiquetas. Las etiquetas son U+E0060 + ASCII, así que el
    // subdivision code sale de restar. `gbeng` → `gb-eng`, que es como lo nombra
    // flag-icons.
    const tags = [...trimmed]
      .map((ch) => ch.codePointAt(0)!)
      .filter((c) => c >= 0xe0061 && c <= 0xe007a)
      .map((c) => String.fromCharCode(c - 0xe0000));
    if (tags.length >= 5) return `/flags/${tags[0]}${tags[1]}-${tags.slice(2).join('')}.svg`;
    return null;
  }
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) {
    const two = [...trimmed]
      .slice(0, 2)
      .map((ch) => String.fromCharCode(ch.codePointAt(0)! - 0x1f1e6 + 65))
      .join('');
    if (!/^[A-Z]{2}$/.test(two)) return null;
    return `/flags/${two.toLowerCase()}.svg`;
  }

  // --- Código a secas (los otros cuatro deportes) ---
  const key = trimmed.toUpperCase();
  if (EXTRA_FLAGS[key]) return `/flags/${EXTRA_FLAGS[key]}.svg`;
  if (/^[A-Z]{2}$/.test(key)) return `/flags/${key.toLowerCase()}.svg`;
  return iso2(key) ? `/flags/${iso2(key)}.svg` : null;
}

/** El nombre de la sede tal como se enseña: sin el emoji, que ahora lo pinta el SVG. */
export function leagueCountryLabel(country: string | null | undefined): string {
  if (!country) return '';
  const trimmed = country.trim();
  const first = [...trimmed][0];
  const cp = first?.codePointAt(0) ?? 0;
  if (cp >= 0x1f1e6 || cp === 0x1f3f4) {
    const space = trimmed.indexOf(' ');
    return space > 0 ? trimmed.slice(space + 1) : '';
  }
  return countryName(trimmed) || trimmed;
}
