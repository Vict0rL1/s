// npm run clave — poner la clave de The Odds API, bien puesta, en un paso.
//
// ===========================================================================
// POR QUÉ EXISTE
// ===========================================================================
// «¿Dónde la agrego?» es la pregunta, y las respuestas a mano fallan de formas que no se
// ven: la línea duplicada (`echo … >> .env` dos veces), las comillas, el `export`, la
// clave pegada sin `ODDS_API_KEY=` delante, el \r de Windows, el .env en otra carpeta…
// y la peor: una ODDS_API_KEY vieja (o vacía) en la terminal, que GANA sobre el .env sin
// decir nada porque dotenv no pisa variables que ya existen.
//
// Esto pide la clave sin enseñarla, la limpia, deja UNA línea `ODDS_API_KEY=` en el .env de
// la raíz (creándolo desde .env.example si no existe), la prueba contra el listado
// gratuito del proveedor (no gasta créditos) y dice lo que falta: reiniciar la app, o
// quitar la variable de la terminal.
//
// La clave nunca se imprime: solo sus cuatro últimos caracteres. Tampoco se acepta como
// argumento (`npm run clave -- abc…`), porque se quedaría en el historial de la terminal.
//
//   npm run clave              pregunta (sin eco) y comprueba
//   npm run clave -- --sin-red  sin la comprobación contra el proveedor
//   pbpaste | npm run clave     desde el portapapeles (macOS), sin preguntar

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pareceEstaApp } from './otra-copia.mjs';
import { DEFAULT_API } from './ports.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LINEA_CLAVE = /^\s*(export\s+)?ODDS_API_KEY\s*=/;

/** Las marcas de «pegado entre corchetes» que algunas terminales mandan alrededor de lo pegado. */
const MARCAS_PEGADO = ['\u001b[200~', '\u001b[201~'];
const sinMarcasDePegado = (t) => MARCAS_PEGADO.reduce((acc, m) => acc.split(m).join(''), t);

/** Solo los cuatro últimos, como el doctor. */
export function enmascarar(clave) {
  return clave.length <= 4 ? '••••' : `••••${clave.slice(-4)}`;
}

/**
 * Lo pegado → la clave. Acepta la línea entera (`ODDS_API_KEY=…`, con o sin `export`),
 * comillas alrededor, espacios y \r. Devuelve null si no queda una clave plausible.
 */
export function limpiarClave(texto) {
  let s = sinMarcasDePegado(String(texto ?? ''))
    .replace(/\r/g, '')
    .trim();
  s = s.split('\n').map((l) => l.trim()).find((l) => l) ?? '';
  s = s.replace(/^export\s+/, '').replace(/^(THE_)?ODDS_API_KEY\s*=\s*/, '').trim();
  s = s.replace(/^(["'])(.*)\1$/, '$2').trim();
  if (!s || /\s/.test(s) || s.length < 8) return null;
  return s;
}

/** ¿Tiene la forma habitual (32 hexadecimales)? Si no, se guarda igual, con aviso. */
export const formaHabitual = (clave) => /^[0-9a-f]{32}$/i.test(clave);

/**
 * El .env con la clave puesta: la PRIMERA línea `ODDS_API_KEY=` se reescribe y las
 * demás se quitan (una línea duplicada es la mitad de los «la puse y no va»). Si no hay
 * ninguna, se añade al final. Todo lo demás del fichero queda como estaba.
 */
export function escribirClave(texto, clave) {
  const eol = texto.includes('\r\n') ? '\r\n' : '\n';
  const lineas = texto.length ? texto.replace(/\r\n/g, '\n').split('\n') : [];
  const out = [];
  let puesta = false;
  for (const l of lineas) {
    if (LINEA_CLAVE.test(l)) {
      if (!puesta) out.push(`ODDS_API_KEY=${clave}`);
      puesta = true;
      continue;
    }
    out.push(l);
  }
  if (!puesta) {
    while (out.length && out.at(-1) === '') out.pop();
    out.push(`ODDS_API_KEY=${clave}`, '');
  }
  return out.join(eol);
}

/**
 * ¿La terminal tiene una ODDS_API_KEY que el .env NO puede pisar? (dotenv no sobrescribe.)
 * Una vacía también cuenta: deja la app sin clave aunque el .env la tenga. Una
 * THE_ODDS_API_KEY en la terminal no estorba: la app mira antes ODDS_API_KEY, que es la
 * que se escribe aquí.
 */
export function terminalQuePisa(entorno, clave) {
  const n = 'ODDS_API_KEY';
  return n in entorno && entorno[n]?.trim() !== clave ? [{ nombre: n, vacia: !entorno[n]?.trim() }] : [];
}

/** La respuesta del listado gratuito → qué decir. */
export function interpretarComprobacion(status, cuerpo, restantes) {
  const b = String(cuerpo ?? '').toUpperCase();
  if (status === 200) return { ok: true, texto: `The Odds API la acepta${restantes != null ? ` · créditos restantes este mes: ${restantes}` : ''}.` };
  if (status === 401 && /OUT_OF_USAGE_CREDITS|QUOTA/.test(b)) {
    return { ok: false, texto: 'La clave es buena pero el plan no tiene créditos este mes: espera al reinicio mensual o cambia de plan.' };
  }
  if (status === 401) return { ok: false, texto: 'The Odds API RECHAZA esta clave (HTTP 401). Cópiala otra vez desde tu cuenta en the-odds-api.com.' };
  if (status === 429) return { ok: null, texto: 'Demasiadas peticiones seguidas (HTTP 429): la clave no se ha podido comprobar ahora; prueba en un minuto con npm run doctor.' };
  return { ok: null, texto: `El proveedor respondió HTTP ${status}: no se ha podido comprobar. npm run doctor lo vuelve a intentar.` };
}

/** GET /v4/sports: no gasta créditos. Nunca lanza. */
export async function comprobar(clave, f = globalThis.fetch) {
  try {
    const r = await f(`https://api.the-odds-api.com/v4/sports?apiKey=${encodeURIComponent(clave)}`, { signal: AbortSignal.timeout(10_000) });
    const rest = r.headers.get('x-requests-remaining');
    return interpretarComprobacion(r.status, await r.text(), rest != null && rest !== '' ? Number(rest) : null);
  } catch (e) {
    return { ok: null, texto: `Sin conexión con The Odds API (${e?.name === 'TimeoutError' ? 'no responde' : 'error de red'}): la clave queda guardada, sin comprobar.` };
  }
}

/** Lee la clave sin eco: un punto por carácter, borrar funciona, Ctrl+C sale. */
function leerOculto(pregunta) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(pregunta);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const fin = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', alLeer);
      process.stdout.write('\n');
      resolve(buf);
    };
    const alLeer = (trozo) => {
      for (const c of sinMarcasDePegado(trozo)) {
        if (c === '\r' || c === '\n') return fin();
        if (c === '\u0003') {
          stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        }
        if (c === '\u007f' || c === '\b') {
          if (buf.length) {
            buf = buf.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        if (c < ' ') continue;
        buf += c;
        process.stdout.write('•');
      }
    };
    stdin.on('data', alLeer);
  });
}

async function leerTodo() {
  let s = '';
  for await (const trozo of process.stdin) s += trozo;
  return s;
}

async function main() {
  const C = { bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', amber: '\x1b[33m', red: '\x1b[31m', off: '\x1b[0m' };
  const env = path.join(ROOT, '.env');
  const ejemplo = path.join(ROOT, '.env.example');
  const sinRed = process.argv.includes('--sin-red');

  if (process.argv.slice(2).some((a) => !a.startsWith('--'))) {
    console.error(`${C.red}✗${C.off} La clave no va como argumento: se quedaría en el historial de la terminal. Ejecuta solo  npm run clave  y pégala cuando la pida.`);
    process.exit(1);
  }

  console.log(`${C.bold}Clave de The Odds API${C.off} ${C.dim}→ ${env}${C.off}`);
  const antes = fs.existsSync(env) ? fs.readFileSync(env, 'utf8') : null;
  const actual = antes?.split(/\r?\n/).find((l) => LINEA_CLAVE.test(l));
  const valorActual = actual ? limpiarClave(actual) : null;
  if (valorActual) console.log(`${C.dim}Ahora tiene una (${enmascarar(valorActual)}); la que pegues la sustituye.${C.off}`);
  console.log(`${C.dim}Está en tu cuenta de the-odds-api.com (y en el correo de alta). Si ha estado en un chat o una captura, genera una nueva.${C.off}\n`);

  const crudo = process.stdin.isTTY ? await leerOculto('Pega la clave y pulsa Enter (no se verá): ') : await leerTodo();
  const clave = limpiarClave(crudo);
  if (!clave) {
    console.error(`${C.red}✗${C.off} Eso no parece una clave (vacía, con espacios o demasiado corta). No he tocado el .env.`);
    process.exit(1);
  }
  if (!formaHabitual(clave)) {
    console.log(`${C.amber}⚠${C.off} No tiene la forma habitual (32 letras y números del 0-9 y a-f). La guardo igual; la comprobación dirá si vale.`);
  }

  // Escribir: desde .env.example si no hay .env, con permisos de solo el dueño si es nuevo.
  const base = antes ?? (fs.existsSync(ejemplo) ? fs.readFileSync(ejemplo, 'utf8') : '');
  const nuevo = escribirClave(base, clave);
  const tmp = `${env}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, nuevo, { mode: antes == null ? 0o600 : fs.statSync(env).mode & 0o777 });
  fs.renameSync(tmp, env);
  console.log(`${C.green}✓${C.off} Guardada en .env (${enmascarar(clave)})${antes == null ? ', creado a partir de .env.example' : ''}.`);

  if (!sinRed) {
    const r = await comprobar(clave);
    console.log(`${r.ok === true ? `${C.green}✓` : r.ok === false ? `${C.red}✗` : `${C.amber}⚠`}${C.off} ${r.texto}`);
  }

  // Lo que el .env no puede arreglar solo.
  for (const v of terminalQuePisa(process.env, clave)) {
    console.log(
      `\n${C.red}✗ Tu terminal tiene ${v.nombre}${v.vacia ? ' VACÍA' : ' con OTRO valor'}, y gana sobre el .env.${C.off}\n` +
        `  Quítala:  unset ${v.nombre}\n` +
        `  y bórrala de donde se define:  grep -n ${v.nombre} ~/.zshrc ~/.zprofile ~/.bash_profile ~/.bashrc 2>/dev/null`,
    );
  }

  const abierta = await pareceEstaApp(Number(process.env.PORT) || DEFAULT_API, { timeoutMs: 500 });
  console.log(
    `\n${C.bold}Siguiente:${C.off} ` +
      (abierta ? 'la app está abierta y solo lee el .env al arrancar: ciérrala (Ctrl+C) y vuelve a  npm run dev' : 'npm run dev') +
      `\n${C.dim}Cuotas al momento:  npm run odds  ·  diagnóstico completo:  npm run doctor${C.off}`,
  );
}

// Solo al ejecutarlo, no al importarlo (los tests importan las funciones). realpath: en una
// carpeta enlazada argv[1] y import.meta.url difieren aunque sean el mismo fichero.
const esPrincipal = (() => {
  try {
    return fs.realpathSync(process.argv[1] ?? '') === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (esPrincipal) await main();
