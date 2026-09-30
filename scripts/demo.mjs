// `npm run demo -- --off` — que la app deje de inventarse partidos.
//
// ===========================================================================
// POR QUÉ ES UN COMANDO Y NO «EDITA TU .env»
// ===========================================================================
// Editar el .env a mano ya salió mal una vez en este proyecto: un `echo CLAVE > .env`
// —con `>`, que sobrescribe— se llevó por delante un fichero que tenía la clave bien
// puesta, y dejó la clave suelta sin `ODDS_API_KEY=` delante. Dos formas de romperlo en
// un comando de siete palabras.
//
// Así que este lo hace solo, y lo hace de la única forma segura: LEE el fichero entero,
// cambia o añade una línea, y vuelve a escribirlo. Nunca sobrescribe a ciegas y nunca
// toca ninguna otra línea — tu clave no se mueve de donde está.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV = path.join(ROOT, '.env');
const C = { bold: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', amber: '\x1b[33m', off: '\x1b[0m' };
const CLAVE = 'DEMO_FIXTURES';

const args = process.argv.slice(2);
const apagar = args.includes('--off') || args.includes('--quitar');
const encender = args.includes('--on') || args.includes('--poner');

function leer() {
  try {
    return fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '';
  } catch {
    return '';
  }
}

function estadoActual(texto) {
  const linea = texto.split(/\r?\n/).find((l) => new RegExp(`^\\s*${CLAVE}\\s*=`).test(l));
  if (!linea) return true; // sin la línea, la demostración está encendida
  return !/^(off|0|false|no)$/i.test(linea.slice(linea.indexOf('=') + 1).trim());
}

const texto = leer();

if (!apagar && !encender) {
  const on = estadoActual(texto);
  console.log(
    `\n${C.bold}Partidos de demostración: ${on ? `${C.amber}ENCENDIDOS` : `${C.green}APAGADOS`}${C.off}\n\n` +
      (on
        ? '  Cuando no llegan cuotas reales, la app se inventa partidos plausibles a partir\n' +
          '  de su propio Elo, con un precio que no es de ninguna casa. Sirve para que una\n' +
          '  instalación recién hecha no parezca rota; estorba si ya tienes clave.\n\n' +
          `  Para quitarlos:   ${C.bold}npm run demo -- --off${C.off}\n`
        : '  Sin cuotas reales, las pestañas se quedan vacías y dicen por qué. No se\n' +
          '  inventa ningún partido ni ningún precio.\n\n' +
          `  Para volver a tenerlos:   ${C.bold}npm run demo -- --on${C.off}\n`),
  );
  process.exit(0);
}

const valor = apagar ? 'off' : 'on';
const re = new RegExp(`^\\s*${CLAVE}\\s*=.*$`, 'm');
let nuevo;
if (re.test(texto)) {
  nuevo = texto.replace(re, `${CLAVE}=${valor}`);
} else {
  // `\n` delante solo si hace falta: un fichero que no acababa en salto de línea se
  // quedaría con la línea nueva pegada al final de la anterior, y eso rompe las DOS.
  const sep = texto === '' || texto.endsWith('\n') ? '' : '\n';
  nuevo = `${texto}${sep}${CLAVE}=${valor}\n`;
}

// Se escribe a un temporal y se renombra. Un corte de luz a mitad de un writeFile deja
// un .env truncado, y este fichero lleva dentro la clave de alguien.
const tmp = `${ENV}.tmp`;
fs.writeFileSync(tmp, nuevo, { mode: 0o600 });
fs.renameSync(tmp, ENV);

console.log(
  apagar
    ? `\n  ${C.green}✓${C.off} apagados. La app ya no se inventará ningún partido ni ninguna cuota.\n\n` +
      `  ${C.dim}Lo guardado de antes se borra en el primer refresco, que ocurre al arrancar.\n` +
      `  Las pestañas sin cuotas reales se quedarán vacías, diciendo por qué.${C.off}\n\n` +
      `  Reinicia para aplicarlo:   ${C.bold}npm run dev${C.off}\n`
    : `\n  ${C.green}✓${C.off} encendidos otra vez.\n\n  Reinicia para aplicarlo:   ${C.bold}npm run dev${C.off}\n`,
);
