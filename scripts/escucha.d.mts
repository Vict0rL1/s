// Tipos de escucha.mjs (web/vite.config.ts la importa con `strict` y sin allowJs; ver ports.d.mts).

/** La dirección en la que escuchar: 127.0.0.1 salvo producción, APP_AUTH=on, DEV_LAN=on o HOST. */
export function hostDeEscucha(entorno?: Record<string, string | undefined>): string;

/** ¿Se ve desde la red local? */
export function abiertaALaRed(entorno?: Record<string, string | undefined>): boolean;
