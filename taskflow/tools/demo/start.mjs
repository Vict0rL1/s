/**
 * `npm run demo` — levanta TaskFlow contra un Supabase de mentira local, con
 * datos de ejemplo. No hace falta ninguna cuenta.
 *
 * Arranca el servidor falso, siembra, y lanza `next dev` apuntándole.
 */
import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";

const PORT = process.env.DEMO_PORT || "7411";
const URL_BASE = `http://127.0.0.1:${PORT}`;
const hijos = [];

function lanzar(cmd, args, env, nombre) {
  const p = spawn(cmd, args, { stdio: "inherit", env: { ...process.env, ...env } });
  p.on("exit", (code) => {
    if (code) console.error(`\n${nombre} terminó con código ${code}`);
    cerrar(code ?? 0);
  });
  hijos.push(p);
  return p;
}

function cerrar(code) {
  for (const h of hijos) h.kill();
  process.exit(code);
}
process.on("SIGINT", () => cerrar(0));
process.on("SIGTERM", () => cerrar(0));

lanzar(process.execPath, [new URL("./supabase.mjs", import.meta.url).pathname], { PORT }, "supabase de mentira");

// Esperar a que responda antes de sembrar.
for (let i = 0; i < 60; i++) {
  try {
    await fetch(`${URL_BASE}/auth/v1/user`);
    break;
  } catch {
    await wait(500);
  }
}

const seed = spawn(process.execPath, [new URL("./seed.mjs", import.meta.url).pathname], {
  stdio: "inherit",
  env: { ...process.env, DEMO_URL: URL_BASE },
});
await new Promise((r) => seed.on("exit", r));

console.log("\n──────────────────────────────────────────────");
console.log("  TaskFlow en modo demo → http://localhost:3000");
console.log("  entra con:  victor@ejemplo.com / contrasena");
console.log("  los datos viven en memoria: al cerrar, se van");
console.log("──────────────────────────────────────────────\n");

lanzar("npm", ["run", "dev"], {
  NEXT_PUBLIC_SUPABASE_URL: URL_BASE,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "llave-de-mentira-para-el-demo",
}, "next dev");
