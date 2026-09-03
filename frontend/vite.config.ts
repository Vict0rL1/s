import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // El frontend habla siempre con el backend local; nada de keys en el navegador.
      '/api': 'http://localhost:8000',
    },
  },
})
