// El ciclo pre-partido: predecir todos los próximos (registro, instantánea y evaluación de
// confianza) y congelar la final de lo que ya empezó. Lo llama el servidor cada 15 minutos
// y, además, justo ANTES de apostar: la abstención necesita una evaluación hecha con las
// mismas cuotas que se van a apostar (ver paper/bankroll.ts).

import { predecirProximosTenis } from '../routes/api.ts';
import { predecirProximosFutbol } from '../routes/football.ts';
import { predecirProximosBaloncesto } from '../routes/basketball.ts';
import { predecirProximosBeisbol } from '../routes/baseball.ts';
import { predecirProximosNfl } from '../routes/nfl.ts';
import { predecirProximosNhl } from '../routes/nhl.ts';
import { predecirProximasUfc } from '../routes/ufc.ts';
import { freezeFinals, META_CICLO } from './snapshots.ts';
import { setMeta } from '../db.ts';

export function cicloPrePartido(log: (m: string) => void = () => {}): { congeladas: number } {
  for (const [nombre, f] of [
    ['tenis', predecirProximosTenis], ['fútbol', predecirProximosFutbol], ['baloncesto', predecirProximosBaloncesto],
    ['béisbol', predecirProximosBeisbol], ['NFL', predecirProximosNfl], ['NHL', predecirProximosNhl], ['UFC', predecirProximasUfc],
  ] as const) {
    try {
      f();
    } catch (e) {
      log(`Pre-partido (${nombre}): ${(e as Error).message}`);
    }
  }
  const ahora = new Date();
  const r = freezeFinals(ahora);
  if (r.congeladas) log(`Pre-partido: ${r.congeladas} predicción(es) final(es) congelada(s).`);
  // Se escribe al FINAL (si algo de arriba lanzara, el latido no diría que el ciclo pasó) y
  // con la MISMA hora con la que se congeló: «empezado antes del último ciclo y sin
  // congelar» tiene que ser un fallo de verdad, no milisegundos de diferencia.
  setMeta(META_CICLO, ahora.toISOString());
  return r;
}
