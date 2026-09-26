// Subirla a Fly.io. Un comando: `npm run deploy`.
//
// ===========================================================================
// LO QUE COMPRUEBA ANTES DE SUBIR, Y POR QUÉ CADA COSA
// ===========================================================================
// Un despliegue tarda unos minutos y falla tarde: `fly deploy` construye la imagen
// entera, la sube, arranca la máquina y ENTONCES descubre que falta la contraseña. Todo
// lo que se pueda saber en dos segundos se sabe aquí.
//
//   · ¿Está `fly` instalado y has iniciado sesión? Sin eso, el error de fly es un
//     «Error: not logged in» al final de la construcción.
//   · ¿Está puesta APP_PASSWORD como secreto? Es la comprobación que más tiempo ahorra:
//     sin ella el servidor se niega a arrancar (a propósito, ver auth.ts), así que el
//     despliegue terminaría «bien» y la máquina moriría en bucle.
//   · ¿Existe la base de datos? El Dockerfile la copia como semilla y sin ella el build
//     falla en el COPY, después de haber instalado todas las dependencias.
//
// ===========================================================================
// LO QUE NO HACE
// ===========================================================================
// Crear la app ni el volumen. Eso es `fly launch` y se hace UNA vez, contestando cuatro
// preguntas; automatizarlo aquí significaría elegir por ti el nombre —que es público y
// único en todo Fly— y la región. Si no están, este script lo dice y te da el comando.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const C = { dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m', off: '\x1b[0m' };

const ok = (t) => console.log(`  ${C.green}✓${C.off} ${t}`);
function morir(que, comoArreglarlo) {
  console.error(`\n${C.red}✗ ${que}${C.off}`);
  if (comoArreglarlo) console.error(`\n${comoArreglarlo}\n`);
  process.exit(1);
}
const captura = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8' });
  return { ok: r.status === 0, salida: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

console.log(`\n${C.bold}Desplegando en Fly.io${C.off}\n`);

// --- 1. La herramienta ---
if (!captura('fly', ['version']).ok) {
  morir(
    'no encuentro el comando `fly`.',
    'Instálalo con:\n    brew install flyctl\n\nO desde https://fly.io/docs/flyctl/install/',
  );
}
ok('flyctl instalado');

if (!captura('fly', ['auth', 'whoami']).ok) {
  morir('no has iniciado sesión en Fly.', 'Hazlo con:\n    fly auth login');
}
ok(`sesión iniciada como ${captura('fly', ['auth', 'whoami']).salida.trim()}`);

// --- 2. La app existe ---
const cfg = path.join(ROOT, 'fly.toml');
if (!fs.existsSync(cfg)) {
  morir('no hay fly.toml.', 'Créalo con:\n    fly launch --no-deploy');
}
const nombre = (fs.readFileSync(cfg, 'utf8').match(/^\s*app\s*=\s*"([^"]+)"/m) ?? [])[1];
if (!nombre) morir('fly.toml no dice el nombre de la app.');

const estado = captura('fly', ['status', '--app', nombre]);
if (!estado.ok) {
  morir(
    `la app «${nombre}» no existe en tu cuenta de Fly.`,
    'Créala una vez (contesta que NO a desplegar ahora):\n' +
      '    fly launch --no-deploy\n\n' +
      'Eso escribirá tu nombre en fly.toml. Luego crea el disco donde vivirán los datos:\n' +
      `    fly volumes create datos --size 3 --region mad --app <tu-nombre>`,
  );
}
ok(`app «${nombre}» encontrada`);

// --- 3. El disco ---
const vols = captura('fly', ['volumes', 'list', '--app', nombre]);
if (!/\bdatos\b/.test(vols.salida)) {
  morir(
    'no hay ningún volumen llamado «datos».',
    'Sin él, CADA despliegue borraría la base y tu registro de apuestas. Créalo:\n' +
      `    fly volumes create datos --size 3 --app ${nombre}`,
  );
}
ok('volumen «datos» presente');

// --- 4. La contraseña ---
// La comprobación que más tiempo ahorra: sin ella el servidor no arranca (auth.ts), así
// que el despliegue "terminaría bien" y la máquina se reiniciaría en bucle.
const secretos = captura('fly', ['secrets', 'list', '--app', nombre]);
if (!/APP_PASSWORD/.test(secretos.salida)) {
  morir(
    'falta el secreto APP_PASSWORD.',
    'Esta URL es pública. Sin contraseña quedarían al alcance de cualquiera tu registro\n' +
      'de apuestas y el endpoint que gasta tu cuota de The Odds API, así que el servidor\n' +
      'se niega a arrancar sin ella. Ponla (ocho caracteres mínimo, usa una frase):\n\n' +
      `    fly secrets set APP_PASSWORD="una-frase-larga-y-tuya" --app ${nombre}`,
  );
}
ok('APP_PASSWORD configurada');
if (!/ODDS_API_KEY/.test(secretos.salida)) {
  console.log(
    `  ${C.dim}· sin ODDS_API_KEY: la app funcionará con cuotas de demostración.\n` +
      `    fly secrets set ODDS_API_KEY="tu-clave" --app ${nombre}${C.off}`,
  );
}

// --- 5. La semilla ---
const db = path.join(ROOT, 'data', 'tennis.db');
if (!fs.existsSync(db)) {
  morir(
    'no existe data/tennis.db, y el Dockerfile la copia como semilla.',
    'Constrúyela antes:\n    npm run update-all -- --skip-odds',
  );
}
ok(`base de datos lista (${(fs.statSync(db).size / 1024 / 1024).toFixed(0)} MB de semilla)`);

// --- Subir ---
console.log(`\n${C.dim}Construyendo y subiendo. Tarda unos minutos la primera vez.${C.off}\n`);
const r = spawnSync('fly', ['deploy', '--app', nombre], { cwd: ROOT, stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status ?? 1);

console.log(`\n${C.green}Desplegada:${C.off} https://${nombre}.fly.dev`);
console.log(`${C.dim}Te pedirá usuario y contraseña. El usuario es «victor» salvo que hayas`);
console.log(`puesto otro con: fly secrets set APP_USER="…"${C.off}\n`);
