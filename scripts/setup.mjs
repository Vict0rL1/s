// `npm run setup` — la primera puesta en marcha, paso a paso: el .env, la base (partir y
// migrar), los datos (descargar, construir o demostración) y el doctor. Cada paso dice lo que
// va a hacer y pregunta; nada se hace a ciegas.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hayHistoria } from './datos-estado.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const C = { bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', amber: '\x1b[33m', off: '\x1b[0m' };
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const pregunta = async (texto, porDefecto = 's') => {
  const r = (await rl.question(`${texto} ${C.dim}[${porDefecto === 's' ? 'S/n' : 's/N'}]${C.off} `)).trim().toLowerCase();
  return r ? r.startsWith('s') : porDefecto === 's';
};
const corre = (args) => spawnSync('npm', args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' }).status === 0;
/**
 * Para un hijo que LEE del teclado (npm run clave): se le cede la terminal en modo normal y
 * se recupera después. Sin esto, el modo «raw» que deja el hijo al salir no es el que espera
 * este readline y las preguntas siguientes salen con las letras repetidas.
 */
const correInteractivo = (args) => {
  rl.pause();
  const raw = process.stdin.isTTY ? process.stdin.isRaw : null;
  if (raw != null) process.stdin.setRawMode(false);
  const ok = corre(args);
  if (raw != null) process.stdin.setRawMode(raw);
  rl.resume();
  return ok;
};

console.log(`${C.bold}Sports Predictor — puesta en marcha${C.off}\n`);

// 1. Node
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.log(`${C.amber}⚠ Node ${process.versions.node}: hace falta 22.13 o superior (node:sqlite sin flag).${C.off}`);
}

// 2. .env
const env = path.join(ROOT, '.env');
if (!fs.existsSync(env)) {
  console.log('No hay .env. Sin él la app arranca en modo demostración (cuotas inventadas y etiquetadas).');
  if (await pregunta('¿Creo un .env a partir de .env.example para que rellenes tu clave de The Odds API?')) {
    fs.copyFileSync(path.join(ROOT, '.env.example'), env);
    console.log(`${C.green}✓${C.off} .env creado${C.dim} (APP_PASSWORD también va ahí si la app va a salir de tu red)${C.off}.`);
  }
} else {
  console.log(`${C.green}✓${C.off} .env encontrado.`);
}

// 2b. La clave: con `npm run clave` (sin eco, una sola línea, comprobada gratis) en vez de
// «abre el .env y escríbela», que es donde se rompía la mitad de las instalaciones.
if (fs.existsSync(env)) {
  const tieneClave = fs.readFileSync(env, 'utf8').split(/\r?\n/).some((l) => /^\s*(export\s+)?(THE_)?ODDS_API_KEY\s*=\s*\S/.test(l));
  if (tieneClave) console.log(`${C.green}✓${C.off} El .env ya tiene una clave de cuotas (npm run doctor dice si funciona).`);
  else if (await pregunta('¿Pones ahora tu clave de The Odds API? (sin ella, la app enseña partidos sin cuotas reales)')) correInteractivo(['run', 'clave']);
}

// 3. Base de datos: partir la antigua si la hay y migrar.
console.log('\nBase de datos: history.db (historia) + ledger.db (lo tuyo). Un tennis.db antiguo se parte sin perder nada.');
if (await pregunta('¿Aplico las migraciones ahora (npm run db:migrate)?')) corre(['run', 'db:migrate']);

// 4. Datos. Por FILAS, no por si el fichero existe: db:migrate (paso 3) acaba de dejar un
// history.db solo con esquema, y antes eso pasaba por «ya hay historia» (lote A, A7).
const history = path.join(process.env.DATA_DIR?.trim() || path.join(ROOT, 'data'), 'history.db');
if (hayHistoria(history)) {
  console.log(`\n${C.green}✓${C.off} Ya hay historia en ${path.relative(ROOT, history)}.`);
} else {
  console.log('\nDatos: hay tres caminos.');
  console.log('  1) Descargar la historia publicada (9 MB, recomendado)');
  console.log('  2) Construirla desde las fuentes (unos minutos, ~100 MB de descargas)');
  console.log('  3) Demostración sin internet (npm run seed)');
  const r = (await rl.question(`¿Cuál? ${C.dim}[1/2/3]${C.off} `)).trim();
  if (r === '2') corre(['run', 'update-all', '--', '--skip-odds']);
  else if (r === '3') corre(['run', 'seed']);
  else if (!corre(['run', 'fetch-data']) || !hayHistoria(history)) {
    console.log(`${C.amber}⚠ La descarga no está disponible (la release «data-latest» aún no existe, o no hay red).${C.off}`);
    if (await pregunta('¿Construyo la historia desde las fuentes (npm run update-all -- --skip-odds, unos minutos)?')) corre(['run', 'update-all', '--', '--skip-odds']);
  }
  if (!hayHistoria(history)) console.log(`${C.amber}⚠ La base sigue sin filas: la app arrancará vacía. Cuando tengas red: npm run fetch-data  (o npm run update-all -- --skip-odds).${C.off}`);
}

// 5. Demostración
if (await pregunta('¿Quieres ver partidos de demostración cuando no haya cuotas reales? (DEMO_FIXTURES)', 'n')) corre(['run', 'demo', '--', '--on']);
else console.log(`${C.dim}Sin demostración: sin clave de cuotas, las pestañas enseñan solo partidos reales con calendario oficial.${C.off}`);

// 6. Doctor
console.log('');
if (await pregunta('¿Paso el doctor (gratis, no gasta cuota)?')) corre(['run', 'doctor', '--', '--sin-red']);

rl.close();
console.log(`\n${C.bold}Listo.${C.off} Arranca con  ${C.bold}npm run dev${C.off}  y abre http://localhost:7373. Todos los comandos: npm run help`);
