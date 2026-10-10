import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
// The single source of truth for the default ports — see that file for why they
// are not Vite's own 5173.
import { DEFAULT_API, DEFAULT_PREVIEW, DEFAULT_WEB } from '../scripts/ports.mjs';
import { hostDeEscucha } from '../scripts/escucha.mjs';

/**
 * Where to send /api — and it must NOT be hardcoded.
 *
 * `scripts/dev.mjs` picks a free API port before either server starts and passes
 * it as PORT, so this follows wherever the backend actually landed. With a port
 * baked in, running alongside another project that owned it gave a frontend that
 * loaded perfectly and proxied its API calls to somebody else's server.
 *
 * VITE_API_BASE still wins, for pointing the frontend at a backend somewhere else
 * entirely.
 */
const API_PORT = Number(process.env.PORT) || DEFAULT_API;
// 127.0.0.1 y no «localhost»: la API escucha en IPv4 (scripts/escucha.mjs) y «localhost» puede
// resolverse primero a ::1.
const API_TARGET = process.env.VITE_API_BASE || `http://127.0.0.1:${API_PORT}`;

/** This server's own port, likewise chosen upstream. */
const WEB_PORT = Number(process.env.WEB_PORT) || DEFAULT_WEB;

// The frontend calls "/api/…" and Vite proxies it to the backend, so there is
// no CORS to configure during development.
const proxy = {
  '/api': { target: API_TARGET, changeOrigin: true },
};

/**
 * Where the dev server listens: scripts/escucha.mjs decides, the same rule as the API.
 *
 * 127.0.0.1 by default. It used to be `host: true` (every interface) always, so with the
 * password gate off — the normal case on a laptop — anyone on the same Wi-Fi could open
 * the app and its bet log (D15 of the 8 Oct 2026 review). For a phone on the same Wi-Fi,
 * start with DEV_LAN=on (no password, on purpose) or APP_AUTH=on (with one); Vite then
 * prints the "Network:" line to type into the phone. The phone's /api calls are proxied
 * by the laptop, so the API itself can stay on loopback.
 */
const HOST = hostDeEscucha();
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: HOST, port: WEB_PORT, proxy },
  // The same for the production preview, which serves the built bundle and is
  // noticeably quicker on a phone than the dev server with its source maps.
  // The preview server (built bundle, quicker on a phone) gets its own port so it
  // and the dev server can run at the same time.
  preview: { host: HOST, port: Number(process.env.WEB_PORT) ? WEB_PORT + 1 : DEFAULT_PREVIEW, proxy },
});
