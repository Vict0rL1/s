// Arranca el servidor para los tests de Playwright: base de demostración en un directorio
// temporal (nunca la tuya), sin clave de cuotas, sin contraseña, sirviendo web/dist en el
// puerto 7390. `npm run build` tiene que haber corrido antes.
//
// Y un SEGUNDO servidor en el 7391 con la puerta activa (APP_AUTH=on, la contraseña de abajo)
// sobre una copia de la misma base: es el que prueba web/e2e/auth.spec.ts. Antes del lote A
// los e2e solo corrían sin contraseña, y así no se vio que en producción la web entera
// quedaba detrás de la puerta (A1).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'predictor-e2e-'));
const env = {
  ...process.env,
  DATA_DIR,
  PORT: '7390',
  APP_AUTH: 'off',
  ODDS_API_KEY: '',
  THE_ODDS_API_KEY: '',
  AUTO_REFRESH_MINUTES: '0',
  DEMO_FIXTURES: 'on',
  NODE_ENV: 'test',
  NODE_OPTIONS: '--experimental-sqlite --disable-warning=ExperimentalWarning',
};
if (!fs.existsSync(path.join(ROOT, 'web', 'dist', 'index.html'))) {
  console.error('No hay web/dist: corre npm run build antes de los tests de punta a punta.');
  process.exit(1);
}
const seed = spawnSync('npm', ['run', 'seed', '--workspace', 'server'], { cwd: ROOT, env, stdio: 'inherit', shell: process.platform === 'win32' });
if (seed.status !== 0) process.exit(seed.status ?? 1);
// La copia para el servidor con contraseña, ANTES de arrancar ninguno: dos servidores sobre el
// mismo fichero migrarían a la vez.
const DATA_DIR_AUTH = fs.mkdtempSync(path.join(os.tmpdir(), 'predictor-e2e-auth-'));
fs.cpSync(DATA_DIR, DATA_DIR_AUTH, { recursive: true });
const envAuth = { ...env, DATA_DIR: DATA_DIR_AUTH, PORT: '7391', APP_AUTH: 'on', APP_PASSWORD: 'contrasena-de-pruebas-e2e' };

const arranca = (e) => spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'server', 'src', 'index.ts')], { cwd: ROOT, env: e, stdio: 'inherit' });
const hijos = [arranca(env), arranca(envAuth)];
const para = (senal) => hijos.forEach((h) => h.kill(senal));
for (const h of hijos) {
  h.on('exit', (code) => {
    para('SIGTERM');
    process.exit(code ?? 0);
  });
}
process.on('SIGTERM', () => para('SIGTERM'));
process.on('SIGINT', () => para('SIGINT'));
