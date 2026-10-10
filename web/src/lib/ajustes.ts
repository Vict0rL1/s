// Los formularios de Ajustes (D11 de la revisión del 8 de octubre), sin React para probarlos.

/** El mismo rango que el servidor (scheduler/registry.ts → configurar). */
export const CADENCIA_MIN = 1;
export const CADENCIA_MAX = 7 * 24 * 60;

/** Tras aplicar, el borrador de ese trabajo se olvida: el campo vuelve a enseñar lo del servidor. */
export function borradorTrasAplicar(borrador: Record<string, string>, nombre: string): Record<string, string> {
  const resto = { ...borrador };
  delete resto[nombre];
  return resto;
}

export function validarCadencia(texto: string): { ok: true; minutos: number } | { ok: false } {
  const s = texto.trim();
  if (!/^\d+$/.test(s)) return { ok: false };
  const n = Number(s);
  return n >= CADENCIA_MIN && n <= CADENCIA_MAX ? { ok: true, minutos: n } : { ok: false };
}

/** null si fue bien; si no, el motivo del servidor (o el código HTTP) para enseñarlo. */
export async function errorDeRespuesta(r: Response): Promise<string | null> {
  if (r.ok) return null;
  const j = (await r.json().catch(() => null)) as { error?: unknown } | null;
  return typeof j?.error === 'string' && j.error ? j.error : `HTTP ${r.status}`;
}

/**
 * Un importe escrito a mano: coma o punto como decimal, sin separador de miles (con los dos,
 * «1.250,5», no se adivina cuál es cuál). Vacío, negativo o ilegible → null.
 */
export function leerImporte(texto: string): number | null {
  const s = texto.trim();
  if (!s || (s.includes(',') && s.includes('.'))) return null;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : null;
}
