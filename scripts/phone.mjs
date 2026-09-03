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
import { DEFAULT_API, DEFAULT_WEB } from './ports.mjs';

// The same names scripts/dev.mjs sets, so `npm run phone` reports the ports the
// app is actually on rather than the ones it would have preferred. (This used to
// read PORT_WEB, which nothing else set — so it always printed Vite's default even
// when the dev server had moved.)
const PORT = Number(process.env.WEB_PORT) || DEFAULT_WEB;
const API_PORT = Number(process.env.PORT) || DEFAULT_API;

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

const webUp = await reachable(`http://localhost:${PORT}/`);
const apiUp = await reachable(`http://localhost:${API_PORT}/api/nfl/meta`);

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
