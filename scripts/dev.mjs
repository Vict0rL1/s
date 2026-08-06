// npm run dev
//
// ===========================================================================
// WHY THIS EXISTS INSTEAD OF JUST RUNNING THE TWO DEV SERVERS
// ===========================================================================
// The API bound port 4000 and the frontend 5173, both hardcoded. Anything else on
// the machine already using 4000 — another project's API, a Docker container, a
// second copy of this app — made the backend die with
//
//     Error: listen EADDRINUSE: address already in use 0.0.0.0:4000
//
// and the frontend then loaded fine and showed an app with no data, which is a
// much more confusing failure than a clear crash.
//
// So the ports are chosen HERE, once, before anything binds, and handed to both
// children through the environment. That ordering is the whole point: if the two
// processes each picked their own port, the frontend's /api proxy would be
// pointing at a port the backend did not end up on. One decision, two consumers.
//
// It also means the app can run ALONGSIDE another project rather than fighting it
// for a number, without anyone editing a config file.
//
// Set PORT or WEB_PORT to pin either one; a pinned port that is busy is reported
// rather than silently moved, because "I told it 4000" deserves an answer about
// 4000.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';

const DEFAULT_API = 4000;
const DEFAULT_WEB = 5173;
/** How far to walk up looking for a free port before giving up. */
const SEARCH_RANGE = 20;

/**
 * Is this port actually bindable?
 *
 * Binds 0.0.0.0 rather than 127.0.0.1 on purpose: that is what both dev servers
 * do (the frontend needs it so a phone on the same Wi-Fi can reach it), and a port
 * can be free on loopback while taken on the LAN interface. Testing the narrower
 * address would report free and then fail.
 */
function free(port) {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '0.0.0.0');
  });
}

async function pick(desired, pinned, label) {
  if (await free(desired)) return { port: desired, moved: false };
  if (pinned) {
    console.error(
      `\n❌ El puerto ${desired} (${label}) está ocupado y lo has fijado a mano.\n` +
        `   Cambia el valor en tu .env o cierra lo que esté usando el ${desired}.\n`,
    );
    process.exit(1);
  }
  for (let p = desired + 1; p <= desired + SEARCH_RANGE; p++) {
    if (await free(p)) return { port: p, moved: true };
  }
  console.error(
    `\n❌ No encuentro ningún puerto libre entre ${desired} y ${desired + SEARCH_RANGE} para ${label}.\n`,
  );
  process.exit(1);
}

/** Addresses another device on the same Wi-Fi could reach. */
function lanAddresses() {
  const out = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      // IPv4 only, and never loopback or the 169.254.x a failed DHCP hands out —
      // both are addresses a phone cannot reach.
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.address.startsWith('169.254.')) continue;
      out.push(a.address);
    }
  }
  return out;
}

const apiPinned = !!process.env.PORT?.trim();
const webPinned = !!process.env.WEB_PORT?.trim();
const api = await pick(Number(process.env.PORT) || DEFAULT_API, apiPinned, 'API');
const web = await pick(Number(process.env.WEB_PORT) || DEFAULT_WEB, webPinned, 'web');

if (api.moved || web.moved) {
  console.log(
    `\nℹ️  Puertos por defecto ocupados (¿otra app corriendo?), uso otros:\n` +
      (api.moved ? `   API  ${DEFAULT_API} → ${api.port}\n` : '') +
      (web.moved ? `   web  ${DEFAULT_WEB} → ${web.port}\n` : ''),
  );
}

console.log('\n' + '='.repeat(52));
console.log(`  App        http://localhost:${web.port}`);
console.log(`  API        http://localhost:${api.port}/api`);
for (const ip of lanAddresses()) {
  console.log(`  En el móvil  http://${ip}:${web.port}`);
}
console.log('='.repeat(52) + '\n');

// Both children inherit the chosen ports. WEB_PORT is what vite.config reads for
// its own port, and PORT is what it points its /api proxy at — so the proxy
// cannot end up aimed at a port the API is not on.
const env = { ...process.env, PORT: String(api.port), WEB_PORT: String(web.port) };

const child = spawn(
  'npx',
  ['concurrently', '-n', 'api,web', '-c', 'blue,green', 'npm:dev:server', 'npm:dev:web'],
  { stdio: 'inherit', env, shell: process.platform === 'win32' },
);

// Forward the signals a terminal sends, so Ctrl-C stops the servers instead of
// orphaning them holding the ports we just went to the trouble of choosing.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}
child.on('exit', (code) => process.exit(code ?? 0));
