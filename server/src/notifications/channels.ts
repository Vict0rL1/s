// Los canales de notificación (Fase 3.6): cada uno sabe si está configurado (qué variable le
// falta) y cómo enviar un mensaje. Ninguno lanza al enviar: devuelve ok/error y el registro
// lo anota. Telegram y el webhook usan `fetch`; el correo, nodemailer; Web Push, web-push.

export interface Mensaje {
  titulo: string;
  cuerpo: string;
  /** Ruta de la app a abrir (p. ej. `/partido/football/<id>?clave=<match_key>`). */
  url?: string | null;
}

export interface ResultadoEnvio {
  ok: boolean;
  error: string | null;
  /** Cuántos destinatarios (Web Push: suscripciones). */
  destinatarios?: number;
}

export interface Canal {
  nombre: 'telegram' | 'webhook' | 'email' | 'webpush';
  descripcion: string;
  /** Variables de entorno que faltan para que funcione; vacío = configurado. */
  falta: (entorno: NodeJS.ProcessEnv) => string[];
  enviar: (m: Mensaje, entorno: NodeJS.ProcessEnv, f: typeof fetch) => Promise<ResultadoEnvio>;
}

const faltan = (entorno: NodeJS.ProcessEnv, vars: string[]) => vars.filter((v) => !entorno[v]?.trim());

async function leerError(res: Response): Promise<string> {
  return `HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`;
}

export const telegram: Canal = {
  nombre: 'telegram',
  descripcion: 'Mensaje a un chat de Telegram desde un bot (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID).',
  falta: (e) => faltan(e, ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']),
  enviar: async (m, e, f) => {
    try {
      const res = await f(`https://api.telegram.org/bot${e.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: e.TELEGRAM_CHAT_ID, text: `*${m.titulo}*\n${m.cuerpo}`, parse_mode: 'Markdown', disable_web_page_preview: true }),
      });
      return res.ok ? { ok: true, error: null } : { ok: false, error: await leerError(res) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
};

/** Discord y Slack aceptan `{ content }` / `{ text }`; se mandan los dos y cada uno lee el suyo. */
export const webhook: Canal = {
  nombre: 'webhook',
  descripcion: 'POST JSON a una URL (Discord, Slack o cualquier receptor): WEBHOOK_URL.',
  falta: (e) => faltan(e, ['WEBHOOK_URL']),
  enviar: async (m, e, f) => {
    try {
      const texto = `**${m.titulo}**\n${m.cuerpo}`;
      const res = await f(e.WEBHOOK_URL!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: texto, text: texto, titulo: m.titulo, cuerpo: m.cuerpo, url: m.url ?? null }) });
      return res.ok ? { ok: true, error: null } : { ok: false, error: await leerError(res) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
};

/**
 * Las opciones del transporte SMTP (D17 de la revisión del 8 de octubre de 2026).
 *
 * 465 es TLS desde el primer byte (`secure`). En cualquier otro puerto se EXIGE STARTTLS
 * (`requireTLS`): antes era opcional, y si el servidor no lo ofrecía —o alguien en medio lo
 * quitaba— usuario y contraseña viajaban en claro. Para un relé local sin TLS (el 25 de la
 * propia máquina) hay que decirlo: SMTP_TLS=off.
 */
export function opcionesSmtp(e: Record<string, string | undefined>) {
  const port = Number(e.SMTP_PORT) || 587;
  const sinTls = e.SMTP_TLS?.trim().toLowerCase() === 'off';
  return {
    host: e.SMTP_HOST,
    port,
    secure: port === 465,
    requireTLS: port !== 465 && !sinTls,
    auth: e.SMTP_USER ? { user: e.SMTP_USER, pass: e.SMTP_PASS ?? '' } : undefined,
  };
}

export const email: Canal = {
  nombre: 'email',
  descripcion: 'Correo por SMTP (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_TO).',
  falta: (e) => faltan(e, ['SMTP_HOST', 'SMTP_FROM', 'SMTP_TO']),
  enviar: async (m, e) => {
    try {
      const { default: nodemailer } = await import('nodemailer');
      const transporte = nodemailer.createTransport(opcionesSmtp(e));
      await transporte.sendMail({ from: e.SMTP_FROM, to: e.SMTP_TO, subject: m.titulo, text: m.cuerpo + (m.url ? `\n\n${m.url}` : '') });
      return { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
};

export interface SuscripcionPush {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Web Push necesita las suscripciones; se las pasa el índice (vienen de la base). */
export function webpush(suscripciones: () => SuscripcionPush[], onFallo: (endpoint: string, definitivo: boolean) => void): Canal {
  return {
    nombre: 'webpush',
    descripcion: 'Notificaciones del navegador (Web Push con VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT).',
    falta: (e) => faltan(e, ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']),
    enviar: async (m, e) => {
      const subs = suscripciones();
      if (subs.length === 0) return { ok: false, error: 'ningún navegador suscrito', destinatarios: 0 };
      try {
        const { default: wp } = await import('web-push');
        wp.setVapidDetails(e.VAPID_SUBJECT!, e.VAPID_PUBLIC_KEY!, e.VAPID_PRIVATE_KEY!);
        let ok = 0;
        const errores: string[] = [];
        for (const s of subs) {
          try {
            await wp.sendNotification(s, JSON.stringify({ title: m.titulo, body: m.cuerpo, url: m.url ?? '/' }), { TTL: 3600 });
            ok++;
          } catch (err) {
            const status = (err as { statusCode?: number }).statusCode;
            onFallo(s.endpoint, status === 404 || status === 410);
            errores.push(`${status ?? '?'}`);
          }
        }
        return ok > 0 ? { ok: true, error: errores.length ? `${errores.length} fallo(s): ${errores.join(', ')}` : null, destinatarios: ok } : { ok: false, error: `ninguna entrega (${errores.join(', ')})`, destinatarios: 0 };
      } catch (err) {
        return { ok: false, error: (err as Error).message, destinatarios: 0 };
      }
    },
  };
}
