// La contraseña, y por qué el servidor se niega a arrancar sin ella.
//
// ===========================================================================
// LO QUE QUEDA EXPUESTO SI ESTO NO ESTÁ
// ===========================================================================
// En el portátil, «sin autenticación» significa «sin autenticación en localhost», que no
// es un problema. En una URL pública significa otra cosa:
//
//   · La tabla `bets` guarda importe, beneficio y notas de cada apuesta. Es el registro
//     de tu dinero, y `/api/bets` lo devuelve entero a quien lo pida.
//   · `/api/refresh` dispara una llamada a The Odds API. Cualquiera que lo pulse gasta TU
//     cuota, y el plan gratuito son 500 peticiones al mes: un script tonto la funde en un
//     minuto.
//   · El resto de la app es el trabajo de meses de alguien, servido a quien acierte la
//     URL.
//
// ===========================================================================
// POR QUÉ FALLA EN VEZ DE AVISAR
// ===========================================================================
// Un aviso en el log de arranque —«ojo, sin contraseña»— se lee una vez, en un despliegue
// que salió bien, y a partir de ahí no lo ve nadie. La app queda pública durante meses y
// funcionando perfectamente, que es exactamente el fallo que no da síntomas.
//
// Así que en producción, sin `APP_PASSWORD`, el proceso NO arranca. Es molesto en el
// minuto del primer despliegue y es lo correcto: un despliegue que falla se arregla; uno
// que queda abierto no se entera nadie.
//
// En local no cambia nada: sin `NODE_ENV=production` no se pide contraseña, porque
// obligar a teclearla en cada `npm run dev` acabaría con un `APP_PASSWORD=1234` en el
// `.env` de todo el mundo y con la costumbre de no leer lo que pone.

import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** ¿Está el proceso sirviendo a internet? Lo marca el Dockerfile. */
export const isProduction = process.env.NODE_ENV === 'production';

const PASSWORD = process.env.APP_PASSWORD?.trim() ?? '';
/** El usuario no aporta seguridad; existe porque Basic Auth pide un par. */
const USER = process.env.APP_USER?.trim() || 'victor';

/**
 * Comprueba la configuración ANTES de escuchar, y revienta si no cuadra.
 *
 * Se llama aparte del registro del hook para que el fallo ocurra en el arranque y no en
 * la primera petición: un servidor que acepta conexiones y las rechaza todas parece un
 * problema de red, y se depura buscando donde no es.
 */
export function assertAuthConfigured(): void {
  if (!isProduction) return;
  if (PASSWORD.length === 0) {
    throw new Error(
      'APP_PASSWORD está vacía y NODE_ENV=production.\n\n' +
        'Este proceso sirve a internet, y sin contraseña quedarían públicos tu registro\n' +
        'de apuestas (importes y beneficios) y el endpoint que gasta tu cuota de The Odds\n' +
        'API. En Fly.io:\n\n' +
        '    fly secrets set APP_PASSWORD="algo-largo-y-tuyo"\n\n' +
        'No arranco sin ella.',
    );
  }
  if (PASSWORD.length < 8) {
    throw new Error(
      `APP_PASSWORD tiene ${PASSWORD.length} caracteres. Ocho es el mínimo aquí, y no ` +
        'por ceremonia: esta URL es pública y adivinable a fuerza bruta sin límite de\n' +
        'intentos. Usa una frase larga.',
    );
  }
}

/**
 * Compara sin filtrar por tiempo.
 *
 * `a === b` sale antes en cuanto encuentra una letra distinta, así que el tiempo de
 * respuesta dice cuántos caracteres del principio eran correctos. Contra un servidor en
 * internet eso es explotable, y la comparación constante cuesta lo mismo de escribir.
 *
 * Las longitudes se igualan antes porque `timingSafeEqual` LANZA si difieren, y ese
 * throw sería, otra vez, una filtración por el mismo canal.
 */
function igual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) {
    // Se compara igualmente contra sí mismo para gastar un tiempo parecido.
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/**
 * Exige la contraseña en todo, con UNA excepción: `/healthz`.
 *
 * La excepción no es un descuido. Fly comprueba que la máquina está viva pidiendo esa
 * ruta, y si respondiera 401 la daría por muerta y la reiniciaría en bucle para siempre.
 * No expone nada: devuelve `{ ok: true }` y ni toca la base.
 */
export function registerAuth(app: FastifyInstance): void {
  if (!isProduction || PASSWORD.length === 0) return;

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.url === '/healthz') return;

    const header = req.headers.authorization ?? '';
    const [esquema, valor] = header.split(' ');
    if (esquema?.toLowerCase() === 'basic' && valor) {
      const texto = Buffer.from(valor, 'base64').toString('utf8');
      const corte = texto.indexOf(':');
      if (corte > 0) {
        const usuario = texto.slice(0, corte);
        const clave = texto.slice(corte + 1);
        // Las dos comparaciones SIEMPRE, sin cortocircuito: con `&&`, un usuario
        // equivocado se rechazaría sin llegar a comparar la clave, y la diferencia de
        // tiempo diría si el usuario existe.
        const okUsuario = igual(usuario, USER);
        const okClave = igual(clave, PASSWORD);
        if (okUsuario && okClave) return;
      }
    }

    // `WWW-Authenticate` es lo que hace que el navegador enseñe el diálogo de usuario y
    // contraseña en vez de una página de error.
    reply
      .code(401)
      .header('WWW-Authenticate', 'Basic realm="Sports Predictor", charset="UTF-8"')
      .send({ error: 'Contraseña requerida' });
  });
}
