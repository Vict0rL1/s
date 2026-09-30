// `npm run doctor -- --probar` de verdad, en un proceso aparte, con The Odds API simulada.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('doctor --probar: secciones, cupo, sondeo y resultado', () => {
  const r = spawnSync(
    process.execPath,
    ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', '--import', 'tsx', '--import', './src/test/fakeOddsApi.ts', 'src/scripts/doctor.ts', '--probar'],
    {
      cwd: serverDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        ODDS_API_KEY: '0123456789abcdef0123456789abcdef',
        DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-e2e-')),
        PORT: '65531',
      },
      timeout: 60_000,
    },
  );
  // Sin los códigos de color de la terminal (ESC[…m).
  const out = (r.stdout + r.stderr).replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
  for (const s of ['CONFIGURACIÓN', 'THE ODDS API', 'DEPORTES', 'BASE DE DATOS', 'SERVIDOR Y PANTALLA', 'RESULTADO']) {
    assert.match(out, new RegExp(s), `falta la sección ${s}\n${out}`);
  }
  assert.match(out, /✓ API key válida/);
  assert.match(out, /Créditos restantes: 463 · usados este mes: 37/);
  assert.match(out, /sondeo basketball_nba: 1 eventos, 1 con cuotas · mercados: h2h · casas \(1\): pinnacle/);
  assert.match(out, /No existe la base de datos/);
  assert.match(out, /El backend no responde/);
  assert.ok(!out.includes('0123456789abcdef0123456789abcdef'), 'la clave completa no puede imprimirse');
  assert.equal(r.status, 1, 'sin base de datos hay error, y el código de salida lo dice');
});
