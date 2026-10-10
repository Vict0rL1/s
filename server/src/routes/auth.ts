// Entrar, salir y ver las sesiones abiertas.
//
//   GET  /api/auth/me                  ¿hay auth? ¿estoy dentro? ¿pide segundo factor?
//   POST /api/auth/login               { password, codigo? } → cookie de sesión
//   POST /api/auth/logout              revoca la sesión de la cookie
//   GET  /api/auth/sessions            las sesiones vivas (la actual marcada)
//   POST /api/auth/sessions/:id/revoke cierra otra sesión
//
// `login` y `me` están exentas de la puerta (auth.ts); las demás van detrás.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthRuntime } from '../auth.ts';
import { direccionDe } from '../auth.ts';
import { igual } from '../auth/compare.ts';
import { verificarTotp } from '../auth/totp.ts';
import { crearSesion, revocarPorToken, revocarSesion, sesionDe, sesionesActivas, SESION_DIAS } from '../auth/sessions.ts';
import { borrarCookieSesion, ponerCookieSesion, tokenDeSesion } from '../auth/cookies.ts';
import { featureEncendida } from '../features.ts';

export function registerAuthRoutes(runtime: AuthRuntime) {
  return async function (app: FastifyInstance): Promise<void> {
    const { config, limite } = runtime;
    // El secreto ya viene en la configuración (del entorno con el que se construyó la app):
    // no se vuelve a leer process.env, para que la app sea la misma en tests y en producción.
    const totpActivo = () => featureEncendida('auth.totp') && !!config.totpSecret;

    app.get('/me', async (req) => {
      if (!config.activa) return { auth: false, dentro: true, totp: false, sesiones: false };
      const s = featureEncendida('auth.sesiones') ? sesionDe(tokenDeSesion(req)) : null;
      // El usuario solo a quien ya ha entrado (G12, lote G): no es la contraseña, pero es la mitad
      // de lo que se prueba en la entrada, y quien no ha entrado no tiene por qué saberlo.
      return { auth: true, dentro: !!s, totp: totpActivo(), sesiones: featureEncendida('auth.sesiones'), sesionId: s?.id ?? null, ...(s ? { usuario: config.usuario } : {}) };
    });

    app.post<{ Body: { password?: unknown; codigo?: unknown } }>('/login', async (req, reply) => {
      if (!config.activa) return { ok: true, nota: 'la autenticación no está activa en este servidor' };
      if (!featureEncendida('auth.sesiones')) return reply.code(404).send({ error: 'Las sesiones están apagadas (features.json); usa Basic Auth.' });
      const ip = direccionDe(req, config.produccion);
      const espera = limite.bloqueadaSegundos(ip);
      if (espera > 0) return reply.code(429).header('retry-after', String(espera)).send({ error: `Demasiados intentos. Espera ${espera} s.` });

      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      const codigo = typeof req.body?.codigo === 'string' ? req.body.codigo : '';
      // Las dos comprobaciones siempre, por el mismo motivo que en Basic Auth.
      const okClave = igual(password, config.password);
      const okTotp = totpActivo() ? verificarTotp(config.totpSecret, codigo) : true;
      if (!(okClave && okTotp)) {
        const bloqueo = limite.fallo(ip);
        if (bloqueo > 0) return reply.code(429).header('retry-after', String(bloqueo)).send({ error: `Demasiados intentos. Espera ${bloqueo} s.` });
        return reply.code(401).send({ error: totpActivo() && okClave ? 'Código incorrecto' : 'Contraseña incorrecta', totp: totpActivo() });
      }
      limite.acierto(ip);
      const { token, id } = crearSesion({ userAgent: req.headers['user-agent'], ip });
      ponerCookieSesion(req, reply, token, SESION_DIAS * 86_400, config.produccion);
      return { ok: true, sesionId: id };
    });

    app.post('/logout', async (req, reply) => {
      const token = tokenDeSesion(req);
      if (token) revocarPorToken(token);
      borrarCookieSesion(reply);
      return { ok: true };
    });

    app.get('/sessions', async (req: FastifyRequest) => {
      const actual = (req as FastifyRequest & { sesion?: { id: number } }).sesion?.id ?? null;
      return { actual, sesiones: sesionesActivas().map((s) => ({ ...s, actual: s.id === actual })) };
    });

    app.post<{ Params: { id: string } }>('/sessions/:id/revoke', async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'id inválido' });
      const actual = (req as FastifyRequest & { sesion?: { id: number } }).sesion?.id ?? null;
      const ok = revocarSesion(id);
      if (ok && id === actual) borrarCookieSesion(reply);
      return { ok, eraLaActual: id === actual };
    });
  };
}
