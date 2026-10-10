// Cuándo se pide contraseña, y con qué.
//
// Tres modos, por `APP_AUTH`:
//   auto  (por defecto) solo en producción (NODE_ENV=production). Es el comportamiento de
//         siempre: en el portátil no se pide nada.
//   on    siempre. Para probar la puerta sin disfrazar el proceso de producción, y para
//         quien exponga la app en su red local y quiera contraseña.
//   off   nunca. Solo tiene sentido detrás de otra puerta (un proxy con su propia auth).
//
// En producción, `off` NO vale: la app se niega a arrancar igual que sin contraseña. Ver
// la explicación larga en ../auth.ts.

export const isProduction = process.env.NODE_ENV === 'production';

export type ModoAuth = 'auto' | 'on' | 'off';

/**
 * En qué dirección escucha la API (D15 de la revisión del 8 de octubre de 2026).
 *
 * Antes, siempre 0.0.0.0: con la puerta apagada —lo normal en el portátil— cualquiera en la
 * misma wifi abría la app y el registro de apuestas. Ahora 127.0.0.1 salvo en producción (el
 * contenedor necesita escuchar fuera, y ahí la contraseña es obligatoria), con APP_AUTH=on (hay
 * contraseña) o con DEV_LAN=on (abrirla sin contraseña, a sabiendas). HOST, si se fija, manda.
 * La misma regla está en scripts/escucha.mjs para Vite y dev.mjs; un test comprueba que coinciden.
 */
export function hostDeEscucha(entorno: NodeJS.ProcessEnv = process.env): string {
  const fijo = entorno.HOST?.trim();
  if (fijo) return fijo;
  const si = (v: string | undefined) => ['on', '1', 'true', 'si', 'sí'].includes((v ?? '').trim().toLowerCase());
  if (entorno.NODE_ENV === 'production' || entorno.APP_AUTH?.trim().toLowerCase() === 'on' || si(entorno.DEV_LAN)) return '0.0.0.0';
  return '127.0.0.1';
}

export function modoAuth(entorno: NodeJS.ProcessEnv = process.env): ModoAuth {
  const v = entorno.APP_AUTH?.trim().toLowerCase();
  return v === 'on' || v === 'off' ? v : 'auto';
}

export interface ConfigAuth {
  activa: boolean;
  modo: ModoAuth;
  password: string;
  usuario: string;
  /** Secreto TOTP en base32, o '' si no hay segundo factor. */
  totpSecret: string;
  produccion: boolean;
}

export function configAuth(entorno: NodeJS.ProcessEnv = process.env): ConfigAuth {
  const modo = modoAuth(entorno);
  const produccion = entorno.NODE_ENV === 'production';
  const password = entorno.APP_PASSWORD?.trim() ?? '';
  return {
    modo,
    produccion,
    password,
    usuario: entorno.APP_USER?.trim() || 'victor',
    totpSecret: (entorno.TOTP_SECRET ?? '').replace(/[\s=-]/g, '').toUpperCase(),
    activa: modo === 'on' || (modo === 'auto' && produccion),
  };
}

/**
 * Comprueba la configuración ANTES de escuchar, y revienta si no cuadra.
 *
 * Se llama aparte del registro del hook para que el fallo ocurra en el arranque y no en
 * la primera petición: un servidor que acepta conexiones y las rechaza todas parece un
 * problema de red, y se depura buscando donde no es.
 */
export function assertAuthConfigured(c: ConfigAuth = configAuth()): void {
  if (c.produccion && c.modo === 'off') {
    throw new Error('APP_AUTH=off con NODE_ENV=production: este proceso sirve a internet y no arranca sin contraseña.');
  }
  if (!c.activa) return;
  if (c.password.length === 0) {
    throw new Error(
      'APP_PASSWORD está vacía y la autenticación está activa.\n\n' +
        'Este proceso sirve a internet, y sin contraseña quedarían públicos tu registro\n' +
        'de apuestas (importes y beneficios) y el endpoint que gasta tu cuota de The Odds\n' +
        'API. En Fly.io:\n\n' +
        '    fly secrets set APP_PASSWORD="algo-largo-y-tuyo"\n\n' + // secret-scan:ignore (ejemplo)
        'No arranco sin ella.',
    );
  }
  if (c.password.length < 8) {
    throw new Error(
      `APP_PASSWORD tiene ${c.password.length} caracteres. Ocho es el mínimo aquí, y no ` +
        'por ceremonia: esta URL es pública y adivinable a fuerza bruta sin límite de\n' +
        'intentos. Usa una frase larga.',
    );
  }
  if (c.totpSecret && !/^[A-Z2-7]{16,}$/.test(c.totpSecret)) {
    throw new Error('TOTP_SECRET tiene que ser base32 (A–Z, 2–7) de al menos 16 caracteres. Genera uno con: npm run totp:secreto');
  }
}
