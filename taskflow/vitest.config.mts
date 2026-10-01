import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@/": root,
      // `server-only` revienta fuera del build de Next a propósito; en los
      // tests se cambia por un módulo vacío para poder importar lib/ del servidor.
      "server-only": fileURLToPath(new URL("./tests/helpers/server-only.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    // Los tests de integración arrancan un Postgres entero (PGlite). Con todos
    // los archivos en paralelo, el arranque solo puede pasar de los 5 s por
    // defecto sin que nada esté mal.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
