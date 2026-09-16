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

// El demo compila y sirve en modo producción, no `next dev`, por dos razones:
//
// 1. `NEXT_PUBLIC_*` se incrusta en el bundle al compilar. Pasárselas al build
//    es lo correcto; dárselas sólo a `next dev` funcionaba de casualidad.
// 2. En dev, si el websocket de recarga en caliente no conecta —una red rara,
//    un proxy, un contenedor— React no hidrata y la página queda de adorno:
//    escribes el correo, pulsas Entrar y no pasa nada, sin ningún error. El
//    demo es para MIRAR la app, no para desarrollarla; la recarga en caliente
//    no le aporta nada y sí le agrega esa forma de romperse en silencio.
//
// Para desarrollar de verdad está `npm run dev`.
const entorno = {
  NEXT_PUBLIC_SUPABASE_URL: URL_BASE,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "llave-de-mentira-para-el-demo",
};

console.log("\ncompilando la app (esto tarda unos segundos, sólo la primera vez)...\n");
const build = spawn("npm", ["run", "build"], {
  stdio: ["inherit", "ignore", "inherit"],
  env: { ...process.env, ...entorno },
});
const codigoBuild = await new Promise((r) => build.on("exit", r));
if (codigoBuild) {
  console.error("\nfalló la compilación — arriba está el error");
  cerrar(codigoBuild);
}

console.log("\n──────────────────────────────────────────────");
console.log("  TaskFlow en modo demo → http://localhost:3000");
console.log("  entra con:  victor@ejemplo.com / contrasena");
console.log("  los datos viven en memoria: al cerrar, se van");
console.log("──────────────────────────────────────────────\n");

lanzar("npm", ["run", "start"], entorno, "next start");
