// Parar bien (lote B, B1): SIGINT y SIGTERM paran los trabajos, cierran Fastify y la base.
//
// Sin esto el proceso moría con la conexión abierta: la base no se corrompe (WAL), pero el
// último WAL quedaba sin volcar, y una copia o un `restore` hechos justo después veían una base
// incompleta. Cerrar la conexión hace el checkpoint y quita `-wal`/`-shm`.

import { cerrarDb } from './db.ts';
import { parar } from './scheduler/registry.ts';

export interface OpcionesApagado {
  senal: string;
  /** Cierra el servidor HTTP (app.close()). Si tarda más de `esperaMs`, se sigue sin él. */
  cerrarApp: () => Promise<unknown>;
  esperaMs?: number;
  salir?: (codigo: number) => void;
  log?: (m: string) => void;
}

let apagando = false;

export async function apagar(o: OpcionesApagado): Promise<void> {
  if (apagando) return;
  apagando = true;
  const log = o.log ?? ((m: string) => process.stdout.write(`${m}\n`));
  const salir = o.salir ?? ((c: number) => process.exit(c));
  log(`${o.senal}: parando trabajos, cerrando el servidor y la base…`);
  let codigo = 0;
  try {
    parar();
  } catch (e) {
    codigo = 1;
    log(`al parar los trabajos: ${(e as Error).message}`);
  }
  try {
    // Un SSE abierto puede retener el cierre: se espera un poco y se sigue.
    await Promise.race([o.cerrarApp(), new Promise((r) => setTimeout(r, o.esperaMs ?? 10_000).unref?.())]);
  } catch (e) {
    codigo = 1;
    log(`al cerrar el servidor: ${(e as Error).message}`);
  }
  try {
    cerrarDb();
  } catch (e) {
    codigo = 1;
    log(`al cerrar la base: ${(e as Error).message}`);
  }
  salir(codigo);
}

/** Para los tests: olvidar que ya se apagó. */
export function reiniciarApagado(): void {
  apagando = false;
}

export function instalarApagado(cerrarApp: () => Promise<unknown>, log?: (m: string) => void): void {
  for (const senal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(senal, () => void apagar({ senal, cerrarApp, log }));
  }
}
