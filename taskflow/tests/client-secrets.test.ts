import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Ningún secreto puede llegar al navegador.
 *
 * Next mete en el bundle del cliente todo lo que un componente "use client"
 * importa, directa o indirectamente. Esta prueba recorre ese grafo desde cada
 * archivo cliente y falla si alcanza:
 *
 *  - un módulo marcado `server-only` (env.server, el cliente admin, telegram…);
 *  - cualquier lectura de `process.env.X` que no sea `NEXT_PUBLIC_*`.
 *
 * `server-only` ya rompe el build en ese caso; esto lo dice antes, con el
 * camino exacto de imports, y cubre también el `process.env` suelto que
 * `server-only` no vigila. La comprobación sobre el bundle compilado está en
 * `tools/check-client-secrets.mjs`.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", ".next", "tests", "tools", "reference", "supabase"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const IMPORT = /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null; // paquete de node_modules
  for (const ext of ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx"]) {
    const p = base + ext;
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

/** Imports de valor (los `import type` se borran al compilar y no viajan). */
function valueImports(file: string, src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(IMPORT)) {
    if (/^(?:import|export)\s+type\s/.test(m[0])) continue;
    const r = resolveImport(file, m[1] ?? m[2]);
    if (r) out.push(r);
  }
  return out;
}

const directive = (name: string) => (src: string) =>
  new RegExp(`^\\s*(?:\\/\\/[^\\n]*\\n|\\/\\*[\\s\\S]*?\\*\\/\\s*)*["']${name}["']`).test(src);
const isClient = directive("use client");
/**
 * Un archivo "use server" es una frontera: el cliente que lo importa recibe
 * referencias a las acciones, no su código. Lo de adentro no viaja.
 */
const isServerActions = directive("use server");
const isServerOnly = (src: string) => /import\s+["']server-only["']/.test(src);
const privateEnv = (src: string) =>
  [...src.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]).filter((n) => !n.startsWith("NEXT_PUBLIC_") && n !== "NODE_ENV");

const files = walk(ROOT);
const source = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
const clientEntries = files.filter((f) => isClient(source.get(f)!));

describe("lo que llega al navegador", () => {
  it("hay componentes cliente que revisar, y la frontera de las acciones se reconoce", () => {
    expect(clientEntries.length).toBeGreaterThan(5);
    expect(isServerActions(source.get(join(ROOT, "app/actions.ts"))!)).toBe(true);
  });

  for (const entry of clientEntries) {
    it(relative(ROOT, entry), () => {
      // BFS guardando el camino, para que el error diga POR DÓNDE se coló.
      const seen = new Map<string, string[]>([[entry, [entry]]]);
      const queue = [entry];
      while (queue.length) {
        const f = queue.shift()!;
        const src = source.get(f) ?? readFileSync(f, "utf8");
        const path = seen.get(f)!.map((x) => relative(ROOT, x)).join(" → ");

        expect(isServerOnly(src), `módulo de servidor en el bundle del cliente: ${path}`).toBe(false);
        expect(privateEnv(src), `variable secreta leída desde el cliente: ${path}`).toEqual([]);

        if (isServerActions(src)) continue;
        for (const dep of valueImports(f, src)) {
          if (!seen.has(dep)) {
            seen.set(dep, [...seen.get(f)!, dep]);
            queue.push(dep);
          }
        }
      }
    });
  }

  it("los módulos con secretos están marcados server-only", () => {
    for (const f of ["lib/env.server.ts", "lib/supabase/admin.ts", "lib/telegram.ts", "lib/push.ts", "lib/ai.ts", "lib/log.ts"]) {
      expect(isServerOnly(readFileSync(join(ROOT, f), "utf8")), f).toBe(true);
    }
  });

  it("ninguna variable secreta lleva el prefijo NEXT_PUBLIC_", () => {
    const example = readFileSync(join(ROOT, ".env.example"), "utf8");
    const publicas = [...example.matchAll(/^(NEXT_PUBLIC_[A-Z0-9_]+)=/gm)].map((m) => m[1]);
    for (const n of publicas) expect(n, n).not.toMatch(/SECRET|PRIVATE|SERVICE_ROLE|TOKEN|API_KEY/);
  });
});
