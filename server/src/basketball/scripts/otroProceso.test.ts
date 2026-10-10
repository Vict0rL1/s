// E9 (revisión del 8 de octubre): con el reloj del planificador, la ingesta de baloncesto nunca
// deja los ratings vacíos al ciclo pre-partido. El test de A5 mira la base desde la MISMA
// conexión; lo que pasa de verdad es que `npm run update-data:basketball` corre en OTRO proceso
// mientras el servidor predice con su reloj. Aquí un proceso hijo lee los ratings en bucle con su
// propia conexión mientras este proceso ingiere con una descarga lenta.
//
// Y un control: el mismo vigilante, contra el patrón de antes de A5 (borrar y confirmar, luego
// descargar, luego insertar), VE los ratings vacíos. Así el test demuestra que caza el defecto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../../test/setup.ts';

const { getDb } = await import('../../db.ts');
const { rutaPrincipal } = await import('../../db/layout.ts');
const { actualizarHistoriaBaloncesto } = await import('./actualizar.ts');
const { basketballConfig } = await import('../../config.ts');
const { recomputeBasketballRatings } = await import('../ratings.ts');

const db = getDb();
const nba = basketballConfig.leagues.find((l) => l.id === 'nba')!;
db.prepare("INSERT INTO bb_teams (id, league, name) VALUES ('fuertes', 'nba', 'Fuertes'), ('flojos', 'nba', 'Flojos')").run();
const ins = db.prepare("INSERT INTO bb_games (league, season, game_date, home_id, away_id, home_pts, away_pts) VALUES ('nba', 2025, ?, ?, ?, ?, ?)");
for (let i = 0; i < 30; i++) ins.run(`2025${String(1 + (i % 6)).padStart(2, '0')}${String(1 + (i % 28)).padStart(2, '0')}`, i % 2 ? 'fuertes' : 'flojos', i % 2 ? 'flojos' : 'fuertes', 110, 95);
recomputeBasketballRatings();

/** El vigilante: otro proceso, otra conexión, leyendo cuántos ratings hay hasta que se le pare. */
async function vigilar<T>(durante: () => Promise<T>): Promise<{ minimo: number; lecturas: number; r: T }> {
  const parar = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vigia-')), 'parar');
  const codigo = `
    import { DatabaseSync } from 'node:sqlite';
    import fs from 'node:fs';
    const db = new DatabaseSync(process.env.VIGIA_DB, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 2000');
    const q = db.prepare("SELECT COUNT(*) AS n FROM bb_team_ratings WHERE league = 'nba'");
    let minimo = Infinity, lecturas = 0;
    while (!fs.existsSync(process.env.VIGIA_PARAR)) {
      minimo = Math.min(minimo, q.get().n); lecturas++;
      if (lecturas === 1) console.log('listo');
      await new Promise((r) => setTimeout(r, 2));
    }
    console.log(JSON.stringify({ minimo, lecturas }));`;
  const hijo = spawn(process.execPath, ['--input-type=module', '-e', codigo], { env: { ...process.env, VIGIA_DB: rutaPrincipal(), VIGIA_PARAR: parar }, stdio: ['ignore', 'pipe', 'inherit'] });
  let salida = '';
  await new Promise<void>((listo) => hijo.stdout.on('data', (d) => ((salida += String(d)), salida.includes('listo') && listo())));
  const r = await durante();
  await new Promise((ok) => setTimeout(ok, 50));
  fs.writeFileSync(parar, '');
  await new Promise((ok) => hijo.on('exit', ok));
  const ultima = salida.trim().split('\n').pop()!;
  return { ...(JSON.parse(ultima) as { minimo: number; lecturas: number }), r };
}

const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
const partido = (fecha: string, local: string, visitante: string, pl: number, pv: number) => ({
  date: fecha,
  competitions: [{ date: fecha, status: { type: { completed: true } }, competitors: [{ homeAway: 'home', team: { displayName: local }, score: String(pl) }, { homeAway: 'away', team: { displayName: visitante }, score: String(pv) }] }],
});
/** ESPN simulada y lenta: cada petición tarda lo que una de verdad desde un portátil. */
const espnLenta = (async (url: string) => {
  await new Promise((ok) => setTimeout(ok, 150));
  const u = String(url);
  if (u.endsWith('/teams')) return json({ sports: [{ leagues: [{ teams: [{ team: { id: '1', displayName: 'Fuertes' } }, { team: { id: '2', displayName: 'Flojos' } }] }] }] });
  if (u.includes('/schedule')) return json({ events: [partido('2026-01-10T00:00Z', 'Fuertes', 'Flojos', 100, 99), partido('2026-01-12T00:00Z', 'Flojos', 'Fuertes', 101, 90)] });
  return new Response('no', { status: 404 });
}) as unknown as typeof fetch;

test('E9 (control): el patrón de antes de A5 —borrar, descargar, insertar— deja ver los ratings vacíos a otro proceso', async () => {
  const { minimo, lecturas } = await vigilar(async () => {
    const guardados = db.prepare("SELECT * FROM bb_team_ratings WHERE league = 'nba'").all() as Record<string, unknown>[];
    db.prepare("DELETE FROM bb_team_ratings WHERE league = 'nba'").run(); // confirmado: así era
    await new Promise((ok) => setTimeout(ok, 400)); // la descarga
    for (const r of guardados) db.prepare(`INSERT INTO bb_team_ratings (${Object.keys(r).join(', ')}) VALUES (${Object.keys(r).map(() => '?').join(', ')})`).run(...(Object.values(r) as never[]));
  });
  assert.ok(lecturas > 10, `${lecturas} lecturas`);
  assert.equal(minimo, 0, 'el vigilante caza el hueco');
});

test('E9: la ingesta de verdad nunca deja los ratings vacíos a otro proceso, ni durante la descarga ni al reemplazar', async () => {
  const { minimo, lecturas, r } = await vigilar(() => actualizarHistoriaBaloncesto({ leagues: [nba], seasons: [2026], source: 'espn', fetch: espnLenta, log: () => undefined }));
  assert.deepEqual(r.fallidas, []);
  assert.ok(lecturas > 10, `${lecturas} lecturas`);
  assert.ok(minimo > 0, `el otro proceso vio ${minimo} ratings en algún momento`);
});
