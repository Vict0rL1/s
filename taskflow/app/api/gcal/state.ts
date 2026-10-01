import { timingSafeEqual } from "node:crypto";

/**
 * La cookie que ata la vuelta de Google al navegador que pidió el permiso.
 * Sin ella, cualquiera podría mandarte un enlace de vuelta con SU código y
 * dejar tu TaskFlow leyendo SU calendario.
 */
export const STATE_COOKIE = "tf_gcal_state";
export const STATE_PATH = "/api/gcal";

export function sameState(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}
