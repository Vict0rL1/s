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
// Así que en producción, sin `APP_PASSWORD`, el proceso NO arranca (ver auth/mode.ts).
//
// ===========================================================================
// DOS FORMAS DE ENTRAR, UNA PUERTA
// ===========================================================================
//   · Cookie de sesión (`sp_session`): la que usa la pantalla. Se consigue en
//     POST /api/auth/login con la contraseña (y el código TOTP si está configurado), y se
//     puede revocar desde la propia pantalla. Ver auth/sessions.ts y auth/cookies.ts.
//   · Basic Auth: para `curl` y para quien ya la usaba. La misma contraseña.
//
// Los intentos fallidos, por cualquiera de las dos, cuentan para el límite por dirección
// (auth/rateLimit.ts): cinco en quince minutos y la dirección espera.
//
// Exentos: `/healthz` (Fly comprueba que la máquina vive pidiéndolo; con 401 la reiniciaría
// en bucle), `/ready`, y las rutas de la propia entrada (`/api/auth/login`, `/api/auth/me`).
//
// Y la web construida (lote A, A1): `index.html`, los assets, el service worker, el manifiesto.
// Sin eso, en producción `GET /` devolvía 401 y no había forma de llegar a la pantalla de
// entrada. Ningún dato viaja por ahí: lo que se exime es la ruta comodín de @fastify/static
// (`/*`) para GET y HEAD, y nunca nada bajo `/api/`.
//
// Basic Auth con TOTP configurado (A3): la contraseña sola ya no abre; el código va en la
// cabecera `X-TOTP-Code` (`curl -u victor -H 'X-TOTP-Code: 123456' …`).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { configAuth, type ConfigAuth } from './auth/mode.ts';
import { igual } from './auth/compare.ts';
import { LimiteDeIntentos } from './auth/rateLimit.ts';
import { sesionDe } from './auth/sessions.ts';
import { tokenDeSesion } from './auth/cookies.ts';
import { verificarTotp } from './auth/totp.ts';
import { featureEncendida } from './features.ts';

export { isProduction } from './auth/mode.ts';
export { assertAuthConfigured } from './auth/mode.ts';

/** Rutas que se sirven sin credenciales. Solo lo imprescindible para entrar y para el monitor. */
export const RUTAS_EXENTAS = new Set(['/healthz', '/health', '/ready', '/api/auth/login', '/api/auth/me']);

export function rutaExenta(url: string): boolean {
  const sinQuery = url.split('?')[0];
  return RUTAS_EXENTAS.has(sinQuery);
}

/**
 * La dirección que cuenta para el límite de intentos.
 *
 * NUNCA `X-Forwarded-For`: la escribe quien manda la petición, así que con ella cada intento
 * podía venir «de otra dirección» y el límite no frenaba nada (A2). En producción (Fly) cuenta
 * `Fly-Client-IP`, que la pone el proxy de Fly y el cliente no puede fijar; fuera de Fly, o sin
 * esa cabecera, cuenta la dirección del socket. Detrás de otro proxy sin esa cabecera todas las
 * peticiones comparten dirección —un atacante puede bloquear a todos—, pero ya no puede
 * saltarse el límite; y la sesión válida se mira ANTES del bloqueo, así que el dueño entra.
 */
export function direccionDe(req: FastifyRequest, produccion = false): string {
  if (produccion) {
    const fly = req.headers['fly-client-ip'];
    const valor = (Array.isArray(fly) ? fly[0] : fly)?.trim();
    if (valor) return valor;
  }
  return req.socket?.remoteAddress || 'desconocida';
}

/**
 * ¿Es una petición de la web construida? La ruta comodín de @fastify/static (`/*`) sirve los
 * ficheros y el respaldo de la SPA; `/api/...` nunca es estático aunque caiga en ella.
 */
export function esEstatica(req: FastifyRequest): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (req.routeOptions?.url !== '/*') return false;
  return !req.url.startsWith('/api/') && !req.url.startsWith('/api?');
}

export function basicAuthValido(header: string | undefined, c: ConfigAuth): boolean | null {
  const [esquema, valor] = (header ?? '').split(' ');
  if (esquema?.toLowerCase() !== 'basic' || !valor) return null;
  const texto = Buffer.from(valor, 'base64').toString('utf8');
  const corte = texto.indexOf(':');
  if (corte <= 0) return false;
  const usuario = texto.slice(0, corte);
  const clave = texto.slice(corte + 1);
  // Las dos comparaciones SIEMPRE, sin cortocircuito: con `&&`, un usuario equivocado se
  // rechazaría sin llegar a comparar la clave, y la diferencia de tiempo diría si el
  // usuario existe.
  const okUsuario = igual(usuario, c.usuario);
  const okClave = igual(clave, c.password);
  return okUsuario && okClave;
}

export interface AuthRuntime {
  config: ConfigAuth;
  limite: LimiteDeIntentos;
}

/**
 * Exige credenciales en todo lo que no esté exento. No hace nada si la auth no está activa.
 */
export function registerAuth(app: FastifyInstance, runtime: AuthRuntime): void {
  const { config, limite } = runtime;
  if (!config.activa) return;
  const sesionesOn = featureEncendida('auth.sesiones');
  const totpActivo = featureEncendida('auth.totp') && !!config.totpSecret;

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (rutaExenta(req.url) || esEstatica(req)) return;

    // La sesión ANTES del bloqueo: una dirección bloqueada (o compartida con quien la bloqueó)
    // no deja fuera a quien ya entró.
    if (sesionesOn) {
      const s = sesionDe(tokenDeSesion(req));
      if (s) {
        (req as FastifyRequest & { sesion?: { id: number } }).sesion = { id: s.id };
        return;
      }
    }

    const ip = direccionDe(req, config.produccion);
    const espera = limite.bloqueadaSegundos(ip);
    if (espera > 0) {
      return reply.code(429).header('retry-after', String(espera)).send({ error: `Demasiados intentos. Espera ${espera} s.` });
    }

    const basic = basicAuthValido(req.headers.authorization, config);
    if (basic !== null) {
      // Con TOTP, las dos comprobaciones siempre (sin cortocircuito), como en el login.
      const codigo = req.headers['x-totp-code'];
      const okTotp = totpActivo ? verificarTotp(config.totpSecret, String(Array.isArray(codigo) ? codigo[0] : (codigo ?? ''))) : true;
      if (basic && okTotp) return;
      const bloqueo = limite.fallo(ip);
      if (bloqueo > 0) return reply.code(429).header('retry-after', String(bloqueo)).send({ error: `Demasiados intentos. Espera ${bloqueo} s.` });
      if (basic && totpActivo) {
        return reply.code(401).send({ error: 'Código TOTP requerido (cabecera X-TOTP-Code)', totp: true, login: '/api/auth/login' });
      }
    }

    // Para la API y para la pantalla, 401 con JSON. `WWW-Authenticate` solo se añade si la
    // petición vino con Basic Auth (o sin nada desde fuera de un navegador): así curl
    // sigue funcionando y la pantalla no ve el diálogo gris del navegador encima de su
    // propia pantalla de entrada.
    const esNavegador = (req.headers.accept ?? '').includes('text/html') || !!req.headers.cookie || req.headers['sec-fetch-mode'] !== undefined;
    if (!esNavegador) reply.header('WWW-Authenticate', 'Basic realm="Sports Predictor", charset="UTF-8"');
    return reply.code(401).send({ error: 'Contraseña requerida', login: '/api/auth/login', totp: totpActivo });
  });
}

/** El runtime por defecto, construido del entorno. Los tests pasan el suyo. */
export function authRuntimeDesdeEntorno(entorno: NodeJS.ProcessEnv = process.env): AuthRuntime {
  return { config: configAuth(entorno), limite: new LimiteDeIntentos() };
}
