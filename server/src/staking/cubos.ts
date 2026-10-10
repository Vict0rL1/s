// Los topes por DÍA y por LIGA de la política, para cualquier banco (lote A, A6).
//
// `maxExposurePerDay` (6 %) y `maxExposurePerLeague` (5 %) vivían solo en `decideBook`, el
// libro manual. El banco de papel y las estrategias llamaban a `decideEvent` (tope total, por
// partido y de grupo) y los ignoraban: seis partidos de la misma liga y la misma tarde se
// colocaban al 2 % cada uno. Ajustes los enseñaba como si aplicaran.
//
// Un cubo de día es el día UTC del INICIO del partido (lo que se juega en una tarde se
// liquida junto), y el de liga, la liga tal cual (sin liga, un cubo propio). Solo recortan.

export interface Cubos {
  dia: Map<string, number>;
  liga: Map<string, number>;
}

export const diaDe = (commence: string | null | undefined): string => (commence ?? 'sin-fecha').slice(0, 10);
export const ligaDe = (league: string | null | undefined): string => league ?? '(sin liga)';

/** Lo ya abierto por cubo, de las filas pendientes de un banco. */
export function cubosDe(abiertas: { commence_time: string | null; league: string | null; stake: number }[]): Cubos {
  const c: Cubos = { dia: new Map(), liga: new Map() };
  for (const a of abiertas) anotarEnCubos(c, a, a.stake);
  return c;
}

export function anotarEnCubos(c: Cubos, a: { commence_time: string | null; league: string | null }, stake: number): void {
  c.dia.set(diaDe(a.commence_time), (c.dia.get(diaDe(a.commence_time)) ?? 0) + stake);
  c.liga.set(ligaDe(a.league), (c.liga.get(ligaDe(a.league)) ?? 0) + stake);
}

/** Lo que cabe en esta apuesta sin pasar el tope de su día ni el de su liga. */
export function cabeEnCubos(
  a: { commence_time: string | null; league: string | null },
  banco: number,
  cfg: { maxExposurePerDay: number; maxExposurePerLeague: number },
  abiertos: Cubos,
): { cabe: number; limitante: string | null } {
  const huecoDia = Math.max(0, cfg.maxExposurePerDay * banco - (abiertos.dia.get(diaDe(a.commence_time)) ?? 0));
  const huecoLiga = Math.max(0, cfg.maxExposurePerLeague * banco - (abiertos.liga.get(ligaDe(a.league)) ?? 0));
  if (huecoLiga < huecoDia) return { cabe: huecoLiga, limitante: `tope por liga (${ligaDe(a.league)})` };
  return { cabe: huecoDia, limitante: `tope por día (${diaDe(a.commence_time)})` };
}
