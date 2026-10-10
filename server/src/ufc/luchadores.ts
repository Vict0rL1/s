// Quién es quién: el nombre que da la casa de apuestas → el id de ufcstats.
//
// Solo coincidencias EXACTAS tras normalizar (tildes, mayúsculas, puntos, guiones, apóstrofos y los
// sufijos «Jr.», «Sr.», «II», «III»), nunca por parecido: «Bruno Silva» son dos luchadores distintos
// en la UFC, y adivinar cuál pondría la predicción de uno en la pelea del otro. Un nombre que
// comparten varios, o que no aparece, se queda sin id y la pelea sin predicción.

import { getDb } from '../db.ts';

const SUFIJOS = /\s+(jr|sr|ii|iii|iv)$/;

/** «José Aldo Jr.» → «jose aldo»; «Rafael dos-Anjos» → «rafael dos anjos». */
export function normalizarNombre(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.'’`]/g, '')
    .replace(/[-_]/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(SUFIJOS, '');
}

let memo: { firma: string; indice: Map<string, string[]> } | null = null;

function indice(): Map<string, string[]> {
  const d = getDb();
  const f = d.prepare('SELECT COUNT(*) AS n, MAX(id) AS m FROM ufc_fighters').get() as { n: number; m: string | null };
  const firma = `${f.n}|${f.m}`;
  if (memo?.firma === firma) return memo.indice;
  const m = new Map<string, string[]>();
  for (const r of d.prepare('SELECT id, nombre FROM ufc_fighters').all() as { id: string; nombre: string }[]) {
    const k = normalizarNombre(r.nombre);
    if (!k) continue;
    m.set(k, [...(m.get(k) ?? []), r.id]);
  }
  memo = { firma, indice: m };
  return m;
}

export type Resolucion = { id: string } | { id: null; motivo: 'desconocido' | 'ambiguo' };

/** El id de ufcstats de un nombre, o por qué no lo hay. */
export function resolverLuchador(nombre: string): Resolucion {
  const ids = indice().get(normalizarNombre(nombre)) ?? [];
  if (ids.length === 1) return { id: ids[0] };
  return { id: null, motivo: ids.length > 1 ? 'ambiguo' : 'desconocido' };
}

/** Para los tests: olvida el índice. */
export function olvidarIndice(): void {
  memo = null;
}
