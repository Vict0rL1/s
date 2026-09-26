// Qué tiene MAL escrito el fichero .env, mirando el texto crudo.
//
// ===========================================================================
// POR QUÉ HACE FALTA MIRAR EL TEXTO Y NO SOLO `env.oddsApiKey`
// ===========================================================================
// `env.oddsApiKey` solo sabe decir «hay clave» o «no hay clave». Y «no hay clave» tiene
// causas que se arreglan de formas muy distintas, la más común de todas:
//
//     64674c4093d25c793bcebc2fa28ea339          ← el .env dice esto
//     ODDS_API_KEY=64674c4093d25c793bcebc2fa28ea339   ← y tiene que decir esto
//
// Un .env no es una lista de valores, es una lista de `NOMBRE=valor`. Una línea suelta
// sin `NOMBRE=` no es nada: dotenv la ignora en silencio y la app arranca en modo
// demostración diciendo «falta ODDS_API_KEY» mientras la clave está AHÍ, en el fichero,
// delante de quien lo ha abierto. Ese mensaje es verdad y es inútil, porque manda a
// poner algo que ya está puesto.
//
// Pasó exactamente así, y pasó siguiendo una instrucción mía: `echo TU-CLAVE > .env`
// escribe la clave sin el nombre, Y ADEMÁS pisa lo que hubiera antes, porque `>` es
// sobrescribir y `>>` es añadir. Un fichero que ya tenía la línea correcta se quedó con
// una línea suelta. Así que esto reconoce ese estado exacto y sabe volver atrás.
//
// ===========================================================================
// LO QUE ESTO NO HACE: TOCAR EL FICHERO
// ===========================================================================
// Solo lee y describe. El arreglo se PROPONE como un comando que la persona corre si
// quiere. Un diagnóstico que además reescribe tu .env sin preguntar es un diagnóstico en
// el que no se puede confiar para correrlo cuando algo va mal.

import fs from 'node:fs';

export interface EnvProblem {
  /** Una línea, para el aviso de arranque. */
  titulo: string;
  /** Qué pasa y por qué, para el diagnóstico. */
  detalle: string;
  /** El comando que lo arregla, o null si hace falta editar a mano. */
  arreglo: string | null;
}

/**
 * ¿Esta línea parece una credencial suelta?
 *
 * El listón es deliberadamente alto —16 caracteres o más, solo los de una clave, y NADA
 * de `=`— porque un falso positivo aquí es peor que un falso negativo: diría «tienes la
 * clave suelta» a alguien que tiene un comentario raro, y mandaría a «arreglar» una
 * línea que estaba bien. La clave de The Odds API son 32 hex, así que 16 deja margen de
 * sobra para otros proveedores sin llegar a cualquier palabra.
 */
function pareceClaveSuelta(linea: string): boolean {
  const l = linea.trim();
  if (l === '' || l.startsWith('#')) return false;
  if (l.includes('=')) return false;
  return /^[A-Za-z0-9_-]{16,}$/.test(l);
}

const ES_CLAVE = /^\s*(export\s+)?ODDS_API_KEY\s*=/;

/**
 * Revisa el .env y devuelve lo que esté mal. Lista vacía = nada que decir.
 *
 * No comprueba si la clave FUNCIONA —eso es hablar con el proveedor, y es lo que hace
 * `npm run doctor` en su paso 3—, solo si el fichero está escrito de forma que la app
 * pueda leerla.
 */
export function inspectEnvFile(envPath: string): EnvProblem[] {
  let raw: string;
  try {
    if (!fs.existsSync(envPath)) return [];
    raw = fs.readFileSync(envPath, 'utf8');
  } catch {
    // Un .env que no se puede leer no es un problema que este módulo sepa describir
    // mejor que el error que dará quien intente usarlo.
    return [];
  }

  const problemas: EnvProblem[] = [];
  const lineas = raw.split(/\r?\n/);
  const conNombre = lineas.filter((l) => ES_CLAVE.test(l));
  const sueltas = lineas.filter(pareceClaveSuelta);

  if (conNombre.length === 0 && sueltas.length > 0) {
    problemas.push({
      titulo: 'Tu clave está en el .env pero le falta el nombre delante.',
      detalle:
        'Hay una línea que parece una clave, suelta, sin `ODDS_API_KEY=` delante. Un .env\n' +
        'es una lista de NOMBRE=valor: una línea sin nombre se ignora entera, así que la\n' +
        'app dice que falta la clave mientras la clave está ahí.',
      // El arreglo NO imprime la clave por ningún lado: la lee del propio fichero y le
      // pone el nombre delante. Así se puede pegar en cualquier sitio sin filtrarla.
      //
      // El patrón va SIN `{16,}` a propósito, aunque la detección de arriba sí lo use.
      // El awk de macOS (BSD) no admite intervalos en su ERE por defecto: la primera
      // versión de este comando no casaba con nada, dejaba el fichero igual y no decía
      // ni pío — o sea, un comando «de arreglo» que no arregla y no falla, que es la
      // peor de las dos cosas. Comprobado corriéndolo: antes, una línea suelta; después,
      // la misma línea suelta. `length($0) >= 16` hace lo mismo y funciona en los dos.
      arreglo:
        `awk 'length($0) >= 16 && $0 !~ /=/ && $0 ~ /^[A-Za-z0-9_-]+$/ ` +
        `{ print "ODDS_API_KEY=" $0; next } { print }' ` +
        `"${envPath}" > "${envPath}.tmp" && mv "${envPath}.tmp" "${envPath}"`,
    });
  }

  if (conNombre.length > 1) {
    const valores = new Set(conNombre.map((l) => l.slice(l.indexOf('=') + 1).trim()));
    problemas.push({
      titulo: `Hay ${conNombre.length} líneas ODDS_API_KEY en el .env.`,
      detalle:
        valores.size > 1
          // ÚLTIMA, no primera. La primera versión de este texto decía «la primera» y la
          // prueba lo desmintió en el acto: con dos líneas distintas, la app leyó la de
          // abajo. dotenv vuelca línea a línea sobre el mismo objeto, así que la de más
          // abajo pisa a la de arriba. Un diagnóstico que apunta a la línea equivocada
          // manda a corregir la que sí estaba bien.
          ? 'Y NO dicen lo mismo. dotenv se queda con la ÚLTIMA, así que la que manda es la\n' +
            'de más abajo y las de arriba no se usan.'
          : 'Dicen todas lo mismo, así que no rompe nada — pero sobra, y el día que cambies\n' +
            'la clave vas a cambiar una y dejar la otra.',
      arreglo: null,
    });
  }

  return problemas;
}
