import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const API_TARGET = process.env.VITE_API_BASE || 'http://localhost:4000';

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
  server: { host: true, port: 5173, proxy },
  // The same for the production preview, which serves the built bundle and is
  // noticeably quicker on a phone than the dev server with its source maps.
  preview: { host: true, port: 4173, proxy },
});
