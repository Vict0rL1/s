import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Where to send /api — and it must NOT be hardcoded.
 *
 * `scripts/dev.mjs` picks a free API port before either server starts and passes
 * it as PORT, so this follows wherever the backend actually landed. With 4000
 * baked in, running alongside another project that owned 4000 gave a frontend
 * that loaded perfectly and proxied its API calls to somebody else's server.
 *
 * VITE_API_BASE still wins, for pointing the frontend at a backend somewhere else
 * entirely.
 */
const API_PORT = Number(process.env.PORT) || 4000;
const API_TARGET = process.env.VITE_API_BASE || `http://localhost:${API_PORT}`;

/** This server's own port, likewise chosen upstream. */
const WEB_PORT = Number(process.env.WEB_PORT) || 5173;

// The frontend calls "/api/…" and Vite proxies it to the backend, so there is
// no CORS to configure during development.
const proxy = {
  '/api': { target: API_TARGET, changeOrigin: true },
};

/**
 * `host: true` binds the dev server to every interface, not just localhost.
 *
 * That is what lets a phone on the same Wi-Fi open the app: Vite then prints a
 * "Network: http://192.168.x.x:5173/" line to type into the phone's browser.
 * The API needs no change — it already listens on 0.0.0.0, and in any case the
 * phone's /api calls are proxied by the laptop that is serving the page, so the
 * backend never has to be reachable from the phone directly.
 *
 * This is a LAN-only exposure. It does not put anything on the internet: another
 * device has to be on the same network to reach it.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: true, port: WEB_PORT, proxy },
  // The same for the production preview, which serves the built bundle and is
  // noticeably quicker on a phone than the dev server with its source maps.
  // The preview server (built bundle, quicker on a phone) sits one port up from
  // the dev server so both can run at once.
  preview: { host: true, port: WEB_PORT + 1000, proxy },
});
