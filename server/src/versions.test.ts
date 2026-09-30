import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import './test/setup.ts';

const { fingerprint, versionsFor, stampPredictionVersions, _resetVersionCache } = await import('./versions.ts');
const { getDb } = await import('./db.ts');

test('la huella cambia si cambia UN byte, y no cambia si no cambia nada', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huella-'));
  const f = path.join(dir, 'modelo.ts');
  fs.writeFileSync(f, 'export const K = 20;\n');
  const a = fingerprint([f]);
  assert.equal(fingerprint([f]), a);
  fs.writeFileSync(f, 'export const K = 21;\n');
  assert.notEqual(fingerprint([f]), a);
  assert.match(a, /^[0-9a-f]{12}$/);
});

test('versiones de los cinco deportes, con el formato esperado', () => {
  _resetVersionCache();
  for (const s of ['tennis', 'football', 'basketball', 'baseball', 'nfl'] as const) {
    const v = versionsFor(s);
    assert.match(v.model_version, new RegExp(`^${s}-[0-9a-f]{12}$`));
    assert.match(v.model_config_version, /^[0-9a-f]{12}$/);
    assert.match(v.calibration_version, /^[0-9a-f]{12}$/);
    assert.match(v.strategy_version, /^[0-9a-f]{12}$/);
    assert.ok(v.data_version.length > 0);
  }
  // Modelos distintos, huellas distintas: un cambio en el fútbol no mueve la del tenis.
  assert.notEqual(versionsFor('tennis').model_version.split('-')[1], versionsFor('football').model_version.split('-')[1]);
});

const db = getDb();
const alta = (key: string) =>
  db
    .prepare(
      `INSERT INTO bb_prediction_log (game_key, league, upcoming_id, commence_time, home_id, away_id, home_name, away_name, prob_home, reliability, predicted_at)
       VALUES (?, 'nba', 'u', '2026-10-22T23:30:00Z', 'bos', 'nyk', 'Celtics', 'Knicks', 0.6, 'high', '2026-10-20T10:00:00Z')
       ON CONFLICT(game_key) DO NOTHING`,
    )
    .run(key);
const versiones = (key: string) => db.prepare('SELECT model_version, git_commit, data_version FROM bb_prediction_log WHERE game_key = ?').get(key) as Record<string, string | null>;

test('una predicción NUEVA queda estampada con sus versiones', () => {
  stampPredictionVersions('bb_prediction_log', 'game_key', 'nueva', 'basketball', alta('nueva'));
  assert.match(String(versiones('nueva').model_version), /^basketball-/);
  assert.ok(versiones('nueva').data_version);
});

test('una predicción que YA existía no recibe las versiones de hoy', () => {
  // Una fila antigua, anterior al versionado: sin versión.
  alta('antigua');
  assert.equal(versiones('antigua').model_version, null);
  // Otra pasada la vuelve a «registrar»: el INSERT no inserta (0 cambios) y no se estampa.
  stampPredictionVersions('bb_prediction_log', 'game_key', 'antigua', 'basketball', alta('antigua'));
  assert.equal(versiones('antigua').model_version, null, 'inventarle un origen sería peor que no tenerlo');
});

// TEST NEGATIVO: la versión se fija una vez.
test('la versión de una predicción no se puede cambiar después', () => {
  assert.throws(
    () => db.prepare("UPDATE bb_prediction_log SET model_version = 'basketball-otra' WHERE game_key = 'nueva'").run(),
    /no se reescribe/,
  );
});
