// Por qué una pestaña de deporte está vacía sin la demostración (ui/slate → VacioPorqueNoHayCuotas).
import type { Clave } from '../i18n/es';

const POR_MOTIVO: Record<string, Clave> = {
  sin_eventos: 'vacio.sinEventos',
  sin_ligas: 'vacio.sinLigas',
  presupuesto: 'vacio.presupuesto',
  fuente_falla: 'vacio.fuenteFalla',
  sin_clave: 'vacio.sinClave',
};

/**
 * La frase de la causa. `hayClave` es null mientras /meta no ha contestado (o si falló): entonces
 * no se sabe si hay clave y no se le echa la culpa (D14; antes `hasKey ?? false` la culpaba).
 */
export function motivoVacio(motivo: string | null | undefined, hayClave: boolean | null): Clave {
  if (motivo && POR_MOTIVO[motivo]) return POR_MOTIVO[motivo];
  if (hayClave === null) return 'vacio.estadoDesconocido';
  return hayClave ? 'vacio.sinCausa' : 'vacio.sinClave';
}
