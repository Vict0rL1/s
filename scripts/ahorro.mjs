// `npm run ahorro` — cuánto cuesta el refresco automático, y bajarlo si hace falta.
//
// ===========================================================================
// POR QUÉ HACE FALTA UN COMANDO Y NO BASTA CON EDITAR EL .env
// ===========================================================================
// La variable existe (`AUTO_REFRESH_MINUTES`) y está documentada. Pero ponerla exige
// saber tres cosas que no están a la vista: qué cadencia tienes ahora, cuánto cuesta un
// ciclo en tu plan, y por tanto qué número escribir. Sin eso, elegir es adivinar — y
// adivinar por lo bajo deja los precios viejos, adivinar por lo alto quema el plan.
//
// Así que esto PRIMERO te dice lo que cuesta lo que ya tienes, y solo después te deja
// cambiarlo. La cuenta sale de datos medidos: lo que gastó el último ciclo de verdad y
// el tamaño del plan que la API declaró en sus cabeceras.
//
// ===========================================================================
// LO QUE NO TOCA
// ===========================================================================
// No toca las cuotas guardadas ni las vuelve a pedir: solo escribe una línea en el .env.
// Y cambiarla NO apaga nada — los refrescos manuales (`npm run odds`, el botón) siguen
// funcionando igual, porque son los que una persona pide y nunca se frenan.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV = path.join(ROOT, '.env');
const DB = path.join(ROOT, 'data', 'tennis.db');
const C = { bold: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', amber: '\x1b[33m', off: '\x1b[0m' };
const CLAVE = 'AUTO_REFRESH_MINUTES';

const args = process.argv.slice(2);
const auto = args.includes('--auto');
const minArg = args.find((a) => a.startsWith('--minutos='));

/** Lee meta sin depender del servidor. Carga perezosa, como en go.mjs. */
function meta() {
  try {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const db = new DatabaseSync(DB, { readOnly: true });
    const get = (k) => {
      try {
        return db.prepare('SELECT value FROM meta WHERE key = ?').get(k)?.value ?? null;
      } catch {
        return null;
      }
    };
    const r = {
      plan: Number(get('odds:planTotal')) || null,
      restantes: Number(get('odds:requestsRemaining')),
      usadas: Number(get('odds:requestsUsed')),
      porCiclo: Number(get('odds:lastCycleCredits')) || null,
    };
    db.close();
    return r;
  } catch {
    return { plan: null, restantes: NaN, usadas: NaN, porCiclo: null };
  }
}

function leerEnv() {
  try {
    return fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '';
  } catch {
    return '';
  }
}

const texto = leerEnv();
const linea = texto.split(/\r?\n/).find((l) => new RegExp(`^\\s*${CLAVE}\\s*=`).test(l));
const actual = linea ? Number(linea.slice(linea.indexOf('=') + 1).trim()) : null;
const m = meta();

console.log(`\n${C.bold}Gasto del refresco automático de cuotas${C.off}\n`);

if (m.plan) {
  console.log(`  plan de The Odds API   ${m.plan.toLocaleString('es')} peticiones al mes`);
  if (Number.isFinite(m.restantes)) {
    console.log(`  quedan                 ${m.restantes.toLocaleString('es')}   ${C.dim}(usadas ${Number.isFinite(m.usadas) ? m.usadas.toLocaleString('es') : '?'})${C.off}`);
  }
} else {
  console.log(`  ${C.dim}Todavía no se conoce el plan: se aprende de la primera respuesta de la API.${C.off}`);
}

const porCiclo = m.porCiclo;
console.log(
  `  coste de un ciclo      ${porCiclo ? `${porCiclo} peticiones  ${C.dim}(medido en el último${C.off})` : `${C.dim}sin medir todavía${C.off}`}`,
);
console.log(
  `  cadencia ahora         ${
    actual && Number.isFinite(actual)
      ? `${actual} min  ${C.dim}(fijada a mano en el .env)${C.off}`
      : `${C.dim}automática: la app la calcula del tamaño de tu plan${C.off}`
  }`,
);

/** Peticiones al mes con una cadencia dada. 43.200 minutos tiene un mes. */
const alMes = (min) => (porCiclo ? Math.round((43_200 / min) * porCiclo) : null);

if (porCiclo) {
  console.log(`\n  ${C.bold}Lo que costaría cada cadencia${C.off}`);
  for (const min of [60, 180, 360, 720, 1440, 2880]) {
    const total = alMes(min);
    const cabe = m.plan ? total <= m.plan : null;
    const etq =
      min < 60 ? `${min} min` : min < 1440 ? `cada ${min / 60} h` : `cada ${min / 1440} día(s)`;
    const marca =
      cabe === null ? '' : cabe ? ` ${C.green}cabe en el plan${C.off}` : ` ${C.red}se pasa del plan${C.off}`;
    const esActual = actual === min ? ` ${C.bold}← la tuya${C.off}` : '';
    console.log(`    ${etq.padEnd(14)} ${String(total).padStart(6)} peticiones/mes${marca}${esActual}`);
  }
}

// ---------------------------------------------------------------------------
if (!auto && !minArg) {
  console.log(
    `\n  ${C.dim}Para cambiarla:${C.off}\n` +
      `    ${C.bold}npm run ahorro -- --minutos=720${C.off}   una cada 12 horas\n` +
      `    ${C.bold}npm run ahorro -- --auto${C.off}          que la calcule la app\n\n` +
      `  ${C.dim}Esto NO afecta a los refrescos que pides tú: \`npm run odds\` y el botón\n` +
      `  siguen funcionando igual y nunca se frenan.${C.off}\n`,
  );
  process.exit(0);
}

let nuevo;
if (auto) {
  // Quitar la línea, no ponerla a 0: un 0 DESACTIVA el refresco, que es otra cosa muy
  // distinta de «que lo calcule la app». Confundirlos dejaría las cuotas congeladas
  // creyendo haber activado el modo automático.
  nuevo = texto
    .split(/\r?\n/)
    .filter((l) => !new RegExp(`^\\s*${CLAVE}\\s*=`).test(l))
    .join('\n');
} else {
  const v = Number(minArg.split('=')[1]);
  if (!Number.isFinite(v) || v < 30 || v > 43_200) {
    console.error(`\n${C.red}✗ --minutos tiene que estar entre 30 y 43200 (un mes).${C.off}\n`);
    process.exit(1);
  }
  const re = new RegExp(`^\\s*${CLAVE}\\s*=.*$`, 'm');
  nuevo = re.test(texto)
    ? texto.replace(re, `${CLAVE}=${v}`)
    : `${texto}${texto === '' || texto.endsWith('\n') ? '' : '\n'}${CLAVE}=${v}\n`;
}

// Temporal y renombrado, como en `npm run demo`: un corte a mitad de escritura dejaría
// el .env truncado, y ese fichero lleva dentro la clave.
const tmp = `${ENV}.tmp`;
fs.writeFileSync(tmp, nuevo.endsWith('\n') ? nuevo : `${nuevo}\n`, { mode: 0o600 });
fs.renameSync(tmp, ENV);

console.log(
  auto
    ? `\n  ${C.green}✓${C.off} cadencia automática: la app la calculará del tamaño de tu plan.\n`
    : `\n  ${C.green}✓${C.off} cadencia fijada en ${minArg.split('=')[1]} minutos` +
      `${alMes(Number(minArg.split('=')[1])) ? ` ≈ ${alMes(Number(minArg.split('=')[1]))} peticiones al mes` : ''}.\n`,
);
console.log(`  Reinicia para aplicarlo:   ${C.bold}npm run dev${C.off}\n`);
