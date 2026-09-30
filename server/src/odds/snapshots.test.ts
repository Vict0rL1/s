import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simularFetch } from '../test/setup.ts';

const snap = await import('./snapshots.ts');
const { getDb } = await import('../db.ts');
const { requestOdds } = await import('../oddsApi.ts');

const COMIENZO = '2026-10-04T17:00:00Z';
/** Un evento de tenis con las cuotas de Sinner que se pasen, en dos casas. */
function evento(id: string, sinner: number, alcaraz: number, casas = ['pinnacle', 'bet365']) {
  return {
    id,
    sport_key: 'tennis_atp_shanghai',
    commence_time: COMIENZO,
    home_team: 'Jannik Sinner',
    away_team: 'Carlos Alcaraz',
    bookmakers: casas.map((c) => ({
      key: c,
      title: c,
      markets: [{ key: 'h2h', outcomes: [{ name: 'Jannik Sinner', price: sinner }, { name: 'Carlos Alcaraz', price: alcaraz }] }],
    })),
  };
}
const registrar = (id: string, at: string, s: number, a: number, casas?: string[]) =>
  snap.recordOddsResponse('tennis_atp_shanghai', 'h2h', { events: [evento(id, s, a, casas)], fetchedAt: at });

test('la evolución del ejemplo: 1.82 → 1.76 → 1.69 → cierre 1.67', () => {
  registrar('sa', '2026-10-04T10:00:00Z', 1.82, 2.05);
  registrar('sa', '2026-10-04T13:00:00Z', 1.76, 2.15);
  registrar('sa', '2026-10-04T16:00:00Z', 1.69, 2.25);
  registrar('sa', '2026-10-04T16:50:00Z', 1.67, 2.3);
  const h = snap.history('sa', 'h2h', 'Jannik Sinner');
  assert.deepEqual(h.map((p) => [p.at.slice(11, 16), p.consensus]), [
    ['10:00', 1.82], ['13:00', 1.76], ['16:00', 1.69], ['16:50', 1.67],
  ]);
  assert.equal(snap.openingLine('sa', 'h2h', 'Jannik Sinner')?.consensus, 1.82);
  const cierre = snap.closingLine('sa', 'h2h', 'Jannik Sinner', COMIENZO);
  assert.equal(cierre?.consensus, 1.67);
  assert.equal(cierre?.minutesBeforeStart, 10);
});

test('una cuota que NO cambia no genera snapshot, pero sí observación', () => {
  const r1 = registrar('igual', '2026-10-04T10:00:00Z', 1.9, 1.95);
  const r2 = registrar('igual', '2026-10-04T12:00:00Z', 1.9, 1.95);
  assert.equal(r1.snapshots, 4); // 2 casas × 2 selecciones
  assert.equal(r2.snapshots, 0);
  // Y aun así el cierre sabe que a las 12:00 seguía siendo 1.90.
  const cierre = snap.closingLine('igual', 'h2h', 'Jannik Sinner', COMIENZO);
  assert.equal(cierre?.at, '2026-10-04T12:00:00Z');
  assert.equal(cierre?.consensus, 1.9);
});

test('los snapshots anteriores nunca se sobrescriben: el pasado sigue igual', () => {
  registrar('pasado', '2026-10-04T10:00:00Z', 2.0, 1.8);
  registrar('pasado', '2026-10-04T11:00:00Z', 1.5, 2.6);
  assert.equal(snap.marketAt('pasado', 'h2h', 'Jannik Sinner', '2026-10-04T10:30:00Z')?.consensus, 2.0);
  assert.equal(snap.marketAt('pasado', 'h2h', 'Jannik Sinner', '2026-10-04T11:30:00Z')?.consensus, 1.5);
});

// TESTS NEGATIVOS: append-only lo garantiza la base de datos, no la disciplina.
test('UPDATE sobre odds_snapshots falla', () => {
  registrar('bloq', '2026-10-04T10:00:00Z', 2.0, 1.8);
  assert.throws(() => getDb().prepare("UPDATE odds_snapshots SET odds_decimal = 9.99 WHERE event_id = 'bloq'").run(), /append-only/);
});
test('DELETE sobre odds_snapshots falla', () => {
  assert.throws(() => getDb().prepare("DELETE FROM odds_snapshots WHERE event_id = 'bloq'").run(), /append-only/);
});
test('UPDATE y DELETE sobre las observaciones fallan', () => {
  assert.throws(() => getDb().prepare("UPDATE odds_event_observations SET observed_at = 'x'").run(), /append-only/);
  assert.throws(() => getDb().prepare('DELETE FROM odds_event_observations').run(), /append-only/);
});

test('una casa que deja de cotizar se marca retirada y sale del consenso', () => {
  registrar('ret', '2026-10-04T10:00:00Z', 2.0, 1.8, ['pinnacle', 'bet365']);
  const r = registrar('ret', '2026-10-04T11:00:00Z', 2.2, 1.7, ['pinnacle']);
  assert.equal(r.retiradas, 2);
  const p = snap.marketAt('ret', 'h2h', 'Jannik Sinner', '2026-10-04T11:30:00Z');
  assert.equal(p?.books, 1);
  assert.equal(p?.consensus, 2.2);
  // Y si vuelve, vuelve a contar.
  registrar('ret', '2026-10-04T12:00:00Z', 2.2, 1.7, ['pinnacle', 'bet365']);
  assert.equal(snap.marketAt('ret', 'h2h', 'Jannik Sinner', '2026-10-04T12:30:00Z')?.books, 2);
});

test('pedir h2h no retira los totales que no se pidieron', () => {
  const conTotales = {
    ...evento('mix', 2.0, 1.8),
    bookmakers: [{ key: 'pinnacle', title: 'P', markets: [{ key: 'totals', outcomes: [{ name: 'Over', price: 1.9, point: 22.5 }, { name: 'Under', price: 1.9, point: 22.5 }] }] }],
  };
  snap.recordOddsResponse('tennis_atp_shanghai', 'totals', { events: [conTotales], fetchedAt: '2026-10-04T10:00:00Z' });
  const r = registrar('mix', '2026-10-04T11:00:00Z', 2.0, 1.8);
  assert.equal(r.retiradas, 0);
  const t = snap.marketAt('mix', 'totals', 'Over', '2026-10-04T11:30:00Z');
  assert.equal(t?.line, 22.5);
});

test('un cambio de LÍNEA con la misma cuota es un snapshot nuevo', () => {
  const tot = (point: number) => ({
    ...evento('linea', 2.0, 1.8),
    bookmakers: [{ key: 'pinnacle', title: 'P', markets: [{ key: 'totals', outcomes: [{ name: 'Over', price: 1.9, point }] }] }],
  });
  snap.recordOddsResponse('tennis_atp_shanghai', 'totals', { events: [tot(22.5)], fetchedAt: '2026-10-04T10:00:00Z' });
  const r = snap.recordOddsResponse('tennis_atp_shanghai', 'totals', { events: [tot(23.5)], fetchedAt: '2026-10-04T11:00:00Z' });
  assert.equal(r.snapshots, 1);
});

test('is_live marca lo observado con el evento ya empezado', () => {
  registrar('vivo', '2026-10-04T17:30:00Z', 1.4, 3.0);
  const fila = getDb().prepare("SELECT is_live FROM odds_snapshots WHERE event_id = 'vivo' LIMIT 1").get() as { is_live: number };
  assert.equal(fila.is_live, 1);
  // Y el cierre NO usa lo observado en vivo.
  assert.equal(snap.closingLine('vivo', 'h2h', 'Jannik Sinner', COMIENZO), null);
});

test('cada respuesta real de requestOdds queda guardada, con deporte y competición', async () => {
  simularFetch(() =>
    new Response(JSON.stringify([evento('real', 1.5, 2.7)]), {
      status: 200,
      headers: { 'x-requests-remaining': '400', 'x-requests-used': '10' },
    }),
  );
  await requestOdds('tennis_atp_shanghai', { manual: true });
  const f = getDb().prepare("SELECT sport, league, source FROM odds_snapshots WHERE event_id = 'real' LIMIT 1").get() as Record<string, string>;
  assert.deepEqual({ ...f }, { sport: 'tennis', league: 'tennis_atp_shanghai', source: 'the-odds-api' });
});

test('deporte a partir de la clave del proveedor', () => {
  assert.equal(snap.sportOfKey('soccer_epl'), 'football');
  assert.equal(snap.sportOfKey('americanfootball_nfl'), 'nfl');
  assert.equal(snap.sportOfKey('basketball_nba'), 'basketball');
  assert.equal(snap.sportOfKey('baseball_mlb'), 'baseball');
  assert.equal(snap.sportOfKey('tennis_wta_wuhan'), 'tennis');
});
