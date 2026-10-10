// Horas de una cadencia leídas del entorno, acotadas (lote B, B5).
//
// `setTimeout` guarda el retardo en 32 bits con signo: por encima de 2³¹−1 ms (24,8 días) Node
// avisa con TimeoutOverflowWarning y dispara EN EL ACTO. `BACKUP_HOURS=1000` no era «cada 41
// días»: era la copia en bucle. Tope de 7 días, el mismo que admite Ajustes para una cadencia.

export const HORAS_MAXIMAS = 7 * 24;

/** El valor de `nombre` en horas: 0 apaga; vacío, no numérico o negativo → `defecto`; nunca más de 7 días. */
export function horasDesdeEntorno(entorno: NodeJS.ProcessEnv, nombre: string, defecto: number): number {
  const v = entorno[nombre]?.trim();
  if (!v) return defecto;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return defecto;
  return Math.min(n, HORAS_MAXIMAS);
}
