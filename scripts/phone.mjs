// npm run phone
//
// Prints the addresses to type into a phone on the same Wi-Fi.
//
// Vite already prints a "Network:" line, but it scrolls away behind the API's
// startup logs and it appears before you know whether you needed it. This is the
// same information on demand, plus the two things that actually go wrong: the
// dev server not running, and a firewall quietly dropping the connection.
//
// No dependencies — node's own os.networkInterfaces() knows all of this.

import { networkInterfaces } from 'node:os';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_API, DEFAULT_WEB } from './ports.mjs';

// The same names scripts/dev.mjs sets, so `npm run phone` reports the ports the
// app is actually on rather than the ones it would have preferred. (This used to
// read PORT_WEB, which nothing else set — so it always printed Vite's default even
// when the dev server had moved.)
/**
 * Los puertos en los que la app está DE VERDAD.
 *
 * Tres fuentes, en orden de fiabilidad, y ninguna se cree sin comprobarla:
 *
 *   1. `data/.dev-ports.json`, que escribe `npm run dev` con los puertos que acabó
 *      eligiendo. Es la única fuente que conoce una mudanza de puerto.
 *   2. Las variables de entorno, por si alguien las fijó a mano.
 *   3. Los valores por defecto.
 *
 * Antes solo existían la 2 y la 3, y ese era el fallo: `npm run phone` se lanza en OTRA
 * terminal, no hereda el entorno de `npm run dev`, así que caía siempre a 7373/7374. Con
 * los puertos por defecto ocupados —el caso exacto para el que existe la búsqueda de
 * puerto libre— la app quedaba en 7376 y esto mandaba a escribir 7373 en el teléfono: una
 * dirección que no carga, acompañada de un «la app no está corriendo» que era falso.
 *
 * El fichero puede quedar rancio (el servidor murió, o se arrancó otro), así que se
 * PRUEBAN los candidatos y gana el primero que conteste. Un puerto guardado no es un
 * puerto vivo.
 */
function candidatos(envVar, guardado, porDefecto) {
  const vistos = new Set();
  const out = [];
  for (const p of [guardado, Number(process.env[envVar]) || 0, porDefecto]) {
    if (p && !vistos.has(p)) {
      vistos.add(p);
      out.push(p);
    }
  }
  return out;
}

let guardados = {};
try {
  guardados = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'data', '.dev-ports.json'), 'utf8'),
  );
} catch {
  // No haberlo es normal: la app nunca se arrancó, o se borró data/. Se sigue con el
  // entorno y los valores por defecto, que es lo que hacía antes.
}

let PORT = DEFAULT_WEB;

/**
 * The addresses another device could actually reach.
 *
 * Skips loopback (127.x, only this machine), link-local (169.254.x, what you get
 * when DHCP failed) and IPv6, which is right far more often than it is wrong on
 * a home network.
 */
function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.address.startsWith('169.254.')) continue;
      out.push({ name, address: a.address });
    }
  }
  return out;
}

async function reachable(url) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 1500);
    const res = await fetch(url, { signal: c.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

const addrs = lanAddresses();
console.log('\n📱 Abrir la app en el teléfono\n' + '='.repeat(46));

if (addrs.length === 0) {
  console.log(
    '\nNo encuentro ninguna dirección de red en este equipo.\n' +
      '¿Está conectado al Wi-Fi? Con el cable desenchufado y sin Wi-Fi solo existe\n' +
      'localhost, y a eso el teléfono no puede llegar.\n',
  );
  process.exit(0);
}

/** El primero de los candidatos que conteste, o null si ninguno lo hace. */
async function primerVivo(puertos, ruta) {
  for (const p of puertos) {
    if (await reachable(`http://localhost:${p}${ruta}`)) return p;
  }
  return null;
}

const webVivo = await primerVivo(candidatos('WEB_PORT', guardados.web, DEFAULT_WEB), '/');
const apiVivo = await primerVivo(candidatos('PORT', guardados.api, DEFAULT_API), '/api/nfl/meta');
// Si nada contesta, el puerto POR DEFECTO, no el guardado.
//
// El guardado es de la sesión anterior, y con la app parada ya no significa nada: enseñar
// «7377» porque ayer tocó ese puerto manda a escribir en el teléfono una dirección que no
// solo está muerta, sino que probablemente tampoco será la de la próxima vez. El valor por
// defecto es el que va a usar el siguiente `npm run dev` salvo que esté ocupado, y en ese
// caso este mismo comando lo dirá bien en cuanto la app esté arriba.
PORT = webVivo ?? DEFAULT_WEB;
const webUp = webVivo != null;
const apiUp = apiVivo != null;

console.log('\nEscribe esta dirección en el navegador del teléfono:\n');
for (const { name, address } of addrs) {
  console.log(`   http://${address}:${PORT}      (${name})`);
}

console.log('\nRequisitos:');
console.log(`   ${webId(webUp)} la app está corriendo   ${webUp ? '' : '→ arranca "npm run dev"'}`);
console.log(`   ${webId(apiUp)} la API está corriendo   ${apiUp ? '' : '→ va dentro de "npm run dev"'}`);
console.log('   ·  el teléfono tiene que estar en la MISMA red Wi-Fi');

console.log(
  '\nSi la dirección no carga en el teléfono pero sí en el ordenador, casi siempre\n' +
    'es el cortafuegos del sistema bloqueando el puerto ' + PORT + '. En macOS está en\n' +
    'Ajustes → Red → Firewall; en Windows, «Permitir una aplicación a través del\n' +
    'Firewall de Windows» y marcar Node.js en redes privadas.\n' +
    '\nUna vez abierta, en el menú del navegador elige «Añadir a pantalla de inicio»\n' +
    'y queda con su icono y a pantalla completa, como una app.\n',
);

function webId(ok) {
  return ok ? '✅' : '❌';
}
