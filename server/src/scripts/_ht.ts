// ¿Se pueden modelar las dos mitades por separado?
//
// The half-time score has been in the database since the openfootball ingest landed
// and nothing reads it. It is the missing piece behind a whole family of markets the
// user's own betting slip carries — "gana cualquier mitad", "resultado al descanso",
// HT/FT — which the app cannot offer today without inventing them.
//
// Before modelling anything, measure the three facts a half-time model stands on:
//
//   1. WHAT SHARE OF GOALS falls in the first half. If it were 50 % the whole thing
//      is trivial; the received wisdom is that it is not, and the size of the gap
//      decides whether a naive "half the goals" model is good enough.
//   2. WHETHER THE TWO HALVES ARE INDEPENDENT. A Poisson split assumes they are.
//      They plainly might not be: a team two goals up defends, a team behind chases.
//      If the correlation is large the simple model is wrong and should not ship.
//   3. WHETHER THE SHARE IS STABLE across leagues and seasons, which decides whether
//      it is one constant, ten, or a moving target.

import { getDb } from '../db.ts';

const db = getDb();
const rows = db
  .prepare(
    `SELECT league, season, home_goals fg, away_goals fa, ht_home_goals hh, ht_away_goals ha
     FROM fb_matches
     WHERE ht_home_goals IS NOT NULL AND ht_away_goals IS NOT NULL
       AND home_goals >= ht_home_goals AND away_goals >= ht_away_goals`,
  )
  .all() as unknown as {
  league: string;
  season: string;
  fg: number;
  fa: number;
  hh: number;
  ha: number;
}[];
console.log(`${rows.length} partidos con marcador al descanso coherente\n`);

// A half-time score larger than the full-time one is impossible; the filter above
// drops them, and how many there were is worth knowing.
const bad = (
  db
    .prepare(
      `SELECT COUNT(*) c FROM fb_matches WHERE ht_home_goals IS NOT NULL
        AND (home_goals < ht_home_goals OR away_goals < ht_away_goals)`,
    )
    .get() as { c: number }
).c;
console.log(`descartados por imposibles (descanso > final): ${bad}\n`);

// --- 1. the share -----------------------------------------------------------
let g1 = 0;
let g2 = 0;
for (const r of rows) {
  g1 += r.hh + r.ha;
  g2 += r.fg - r.hh + (r.fa - r.ha);
}
const share = g1 / (g1 + g2);
console.log(`1. REPARTO DE GOLES`);
console.log(`   primera parte ${g1}  ·  segunda ${g2}  ·  cuota 1ª = ${share.toFixed(4)}`);
console.log(`   (0.5 sería reparto uniforme; la diferencia es ${((0.5 - share) * 100).toFixed(2)} pp)\n`);

// --- 2. independence --------------------------------------------------------
function corr(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy);
}
const first = rows.map((r) => r.hh + r.ha);
const second = rows.map((r) => r.fg - r.hh + (r.fa - r.ha));
console.log(`2. ¿SON INDEPENDIENTES LAS DOS MITADES?`);
console.log(`   correlación entre goles de 1ª y de 2ª: ${corr(first, second).toFixed(4)}`);

// The interesting conditional: does a lead at half-time change the second half?
const byLead = new Map<string, { n: number; g2: number; homeG2: number; awayG2: number }>();
for (const r of rows) {
  const lead = r.hh - r.ha;
  const key = lead === 0 ? 'empate' : Math.abs(lead) === 1 ? '±1' : '±2 o más';
  const c = byLead.get(key) ?? { n: 0, g2: 0, homeG2: 0, awayG2: 0 };
  c.n++;
  c.g2 += r.fg - r.hh + (r.fa - r.ha);
  // Signed by the side that LEADS, so "leader" and "chaser" are comparable across rows.
  const leaderG2 = lead > 0 ? r.fg - r.hh : r.fa - r.ha;
  const chaserG2 = lead > 0 ? r.fa - r.ha : r.fg - r.hh;
  c.homeG2 += lead === 0 ? r.fg - r.hh : leaderG2;
  c.awayG2 += lead === 0 ? r.fa - r.ha : chaserG2;
  byLead.set(key, c);
}
console.log(`   goles de la 2ª parte según cómo iba el descanso:`);
for (const [k, c] of [...byLead].sort()) {
  console.log(
    `     ${k.padEnd(10)} n=${String(c.n).padStart(5)}  total 2ª ${(c.g2 / c.n).toFixed(3)}` +
      `  ·  ${k === 'empate' ? 'local' : 'quien iba ganando'} ${(c.homeG2 / c.n).toFixed(3)}` +
      `  ${k === 'empate' ? 'visitante' : 'quien perdía'} ${(c.awayG2 / c.n).toFixed(3)}`,
  );
}
console.log();

// --- 3. stability -----------------------------------------------------------
console.log(`3. ¿ES ESTABLE LA CUOTA?`);
const byLeague = new Map<string, [number, number]>();
for (const r of rows) {
  const c = byLeague.get(r.league) ?? [0, 0];
  c[0] += r.hh + r.ha;
  c[1] += r.fg - r.hh + (r.fa - r.ha);
  byLeague.set(r.league, c);
}
console.log('   por liga:');
for (const [lg, [a, b]] of [...byLeague].sort((x, y) => y[1][0] + y[1][1] - (x[1][0] + x[1][1]))) {
  console.log(`     ${lg.padEnd(13)} ${(a / (a + b)).toFixed(4)}   (${a + b} goles)`);
}
const bySeason = new Map<string, [number, number]>();
for (const r of rows) {
  const c = bySeason.get(r.season) ?? [0, 0];
  c[0] += r.hh + r.ha;
  c[1] += r.fg - r.hh + (r.fa - r.ha);
  bySeason.set(r.season, c);
}
console.log('   por temporada:');
for (const [s, [a, b]] of [...bySeason].sort()) {
  console.log(`     ${String(s).padEnd(13)} ${(a / (a + b)).toFixed(4)}   (${a + b} goles)`);
}

// --- 4. the markets this would unlock, as raw frequencies -------------------
// Measured here so the model's own numbers can be checked against them later.
let htHome = 0;
let htDraw = 0;
let htAway = 0;
let winsEither = 0;
let htOver05 = 0;
let htOver15 = 0;
for (const r of rows) {
  if (r.hh > r.ha) htHome++;
  else if (r.hh === r.ha) htDraw++;
  else htAway++;
  const h2h = r.fg - r.hh;
  const h2a = r.fa - r.ha;
  if (r.hh > r.ha || h2h > h2a) winsEither++;
  if (r.hh + r.ha >= 1) htOver05++;
  if (r.hh + r.ha >= 2) htOver15++;
}
const n = rows.length;
const pct = (x: number) => `${((x / n) * 100).toFixed(2)} %`;
console.log(`\n4. FRECUENCIAS REALES DE LOS MERCADOS QUE ESTO ABRE`);
console.log(`   descanso 1 / X / 2      ${pct(htHome)} / ${pct(htDraw)} / ${pct(htAway)}`);
console.log(`   el local gana alguna mitad   ${pct(winsEither)}`);
console.log(`   más de 0.5 goles al descanso ${pct(htOver05)}`);
console.log(`   más de 1.5 goles al descanso ${pct(htOver15)}`);
getDb();
