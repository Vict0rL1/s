/**
 * `npm run check:secrets` — compila la app con un valor centinela en cada
 * variable secreta y busca esos valores en todo lo que se le manda al
 * navegador (`.next/static`) y en las páginas prerenderizadas.
 *
 * Es la prueba de verdad de que ningún secreto llega al cliente: no mira el
 * código fuente, mira lo que Next produjo. `tests/client-secrets.test.ts`
 * revisa el grafo de imports; esto revisa el resultado.
 *
 * Los centinelas se inventan en cada corrida y no son secretos de nadie.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SECRETS = [
  "CANVAS_TOKEN",
  "SUPABASE_SERVICE_ROLE_KEY",
  "CRON_SECRET",
  "VAPID_PRIVATE_KEY",
  "ANTHROPIC_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "GOOGLE_CLIENT_SECRET",
];

const centinelas = Object.fromEntries(
  SECRETS.map((n) => [n, `CENTINELA_${n}_${randomBytes(6).toString("hex")}`]),
);

const env = {
  ...process.env,
  ...centinelas,
  // Lo público también tiene que estar, para que el build tome los caminos
  // "configurado" y no se salte nada.
  NEXT_PUBLIC_SUPABASE_URL: "https://centinela.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-publica-de-prueba",
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: "BPublicaDePrueba",
  CANVAS_BASE_URL: "https://canvas.prueba/api/v1",
};

console.log("Compilando con valores centinela…");
const build = spawnSync("npx", ["next", "build"], { env, stdio: ["ignore", "ignore", "inherit"] });
if (build.status !== 0) {
  console.error("El build falló; no se pudo comprobar nada.");
  process.exit(build.status ?? 1);
}

function* files(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else yield p;
  }
}

// Lo que el navegador puede pedir: los estáticos y el HTML/RSC prerenderizado.
const revisar = [
  ...files(".next/static"),
  ...[...files(".next/server/app")].filter((f) => /\.(html|rsc|body|meta)$/.test(f)),
];

let fugas = 0;
for (const f of revisar) {
  const txt = readFileSync(f, "utf8");
  for (const [nombre, valor] of Object.entries(centinelas)) {
    if (txt.includes(valor)) {
      console.error(`✗ ${nombre} aparece en ${f}`);
      fugas++;
    }
  }
}

console.log(`${revisar.length} archivos revisados.`);
if (fugas) {
  console.error(`${fugas} fuga(s). Algún secreto llega al navegador.`);
  process.exit(1);
}
console.log("✓ Ningún secreto en lo que llega al navegador.");
