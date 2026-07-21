import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const API_TARGET = process.env.VITE_API_BASE || 'http://localhost:4000';

// The frontend calls "/api/…" and Vite proxies it to the backend, so there is
// no CORS to configure during development.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
    },
  },
});
