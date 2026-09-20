/**
 * SÓLO PARA DESARROLLO. La app no importa nada de esta carpeta.
 *
 * Supabase de mentira: implementa lo justo de PostgREST y de GoTrue que usa
 * TaskFlow, encima de un Postgres de verdad (PGlite, que es Postgres compilado
 * a WebAssembly). Sirve para abrir la app con datos sin crear ninguna cuenta.
 *
 * La RLS es real: cada request corre como el rol `authenticated` con
 * `request.jwt.claims` puesto, así que un insert al que le falte `user_id` lo
 * rechaza Postgres igual que lo haría Supabase. Quien llega con el token de
 * servicio (`DEMO_SERVICE_KEY`) corre sin RLS, como la service role.
 *
 * Lo que NO reproduce: el resto de PostgREST (relaciones anidadas, RPC, filtros
 * que la app no usa), Realtime, Storage, y la confirmación de correo. Sirve
 * para ver y probar la app, no para confiar en que algo funcionará en producción
 * sin haberlo abierto contra el Supabase de verdad.
 */
import { PGlite } from "@electric-sql/pglite";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const SCHEMA = new URL("../../supabase/schema.sql", import.meta.url);
const PORT = Number(process.env.PORT || 7411);
const USER_EMAIL = "victor@ejemplo.com";
const USER_PASSWORD = "contrasena";

// El equivalente de la service role key. `start.mjs` genera uno al azar en cada
// arranque y se lo pasa a los dos lados; aquí no hay ninguno escrito. Quien
// llega con él salta la RLS, igual que en Supabase de verdad: es lo que hace
// que `/api/sync` (el reloj, que corre sin sesión) se pueda probar en el demo.
const SERVICE_KEY = process.env.DEMO_SERVICE_KEY || null;

// PostgREST entrega date/time/timestamptz como texto, no como objetos. PGlite
// los convierte a Date por defecto, y eso rompería comparaciones como
// `task.due_date === today`. Se devuelven crudos para que el harness mienta lo
// menos posible.
const RAW = (v) => v;
const db = await PGlite.create({
  parsers: {
    1082: RAW, // date
    1083: RAW, // time
    1114: RAW, // timestamp
    1184: RAW, // timestamptz
  },
});

// --- piezas que Supabase trae de fábrica -----------------------------------
await db.exec(`
  create schema if not exists auth;
  create table if not exists auth.users (
    id uuid primary key default gen_random_uuid(),
    email text unique
  );
  -- Igual que en Supabase: lee el "sub" del JWT que PostgREST pone por request.
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claims', true)::json->>'sub','')::uuid
  $$;
  create role authenticated;
`);

await db.exec(readFileSync(SCHEMA, "utf8").replace(/create extension if not exists "pgcrypto";/, ""));

await db.exec(`
  grant usage on schema public to authenticated;
  grant all on all tables in schema public to authenticated;
`);

const u = await db.query(`insert into auth.users (email) values ($1) returning id`, [USER_EMAIL]);
export const USER_ID = u.rows[0].id;
console.log(`usuario de prueba: ${USER_EMAIL} / ${USER_PASSWORD}  (${USER_ID})`);

// --- JWT de mentira (el cliente lo decodifica, no lo verifica) --------------
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function makeToken(sub) {
  const now = Math.floor(Date.now() / 1000);
  return [
    b64({ alg: "HS256", typ: "JWT" }),
    b64({ sub, email: USER_EMAIL, role: "authenticated", aud: "authenticated", iat: now, exp: now + 3600 }),
    "firma-de-mentira",
  ].join(".");
}
const userObject = (id) => ({
  id, aud: "authenticated", role: "authenticated", email: USER_EMAIL,
  email_confirmed_at: new Date().toISOString(), phone: "",
  confirmed_at: new Date().toISOString(), last_sign_in_at: new Date().toISOString(),
  app_metadata: { provider: "email", providers: ["email"] }, user_metadata: {},
  identities: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  is_anonymous: false,
});
const session = (id) => ({
  access_token: makeToken(id), token_type: "bearer", expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  refresh_token: "refresh-de-mentira", user: userObject(id),
});

// --- traducción de los filtros de PostgREST a SQL ---------------------------
const IDENT = /^[a-z_][a-z0-9_]*$/i;
const OPS = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=", like: "like", ilike: "ilike" };

function buildWhere(params, args) {
  const clauses = [];
  for (const [key, raw] of params) {
    if (["select", "order", "limit", "offset", "on_conflict", "columns"].includes(key)) continue;
    if (!IDENT.test(key)) continue;
    const dot = raw.indexOf(".");
    const op = raw.slice(0, dot), value = raw.slice(dot + 1);
    if (op === "is") {
      clauses.push(`"${key}" is ${value === "null" ? "null" : value}`);
    } else if (op === "in") {
      const list = value.replace(/^\(|\)$/g, "").split(",").map((v) => v.replace(/^"|"$/g, ""));
      if (!list.length) { clauses.push("false"); continue; }
      clauses.push(`"${key}" in (${list.map((v) => { args.push(v); return `$${args.length}`; }).join(",")})`);
    } else if (OPS[op]) {
      args.push(value);
      clauses.push(`"${key}" ${OPS[op]} $${args.length}`);
    }
  }
  return clauses.length ? " where " + clauses.join(" and ") : "";
}

function buildOrder(params) {
  const spec = params.get("order");
  if (!spec) return "";
  const parts = spec.split(",").map((chunk) => {
    const [col, ...rest] = chunk.split(".");
    if (!IDENT.test(col)) return null;
    const dir = rest.includes("desc") ? "desc" : "asc";
    const nulls = rest.includes("nullsfirst") ? " nulls first" : rest.includes("nullslast") ? " nulls last" : "";
    return `"${col}" ${dir}${nulls}`;
  }).filter(Boolean);
  return parts.length ? " order by " + parts.join(", ") : "";
}

const readBody = (req) => new Promise((res) => {
  let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => res(raw));
});

/** Corre la consulta como el usuario del token, con RLS activa. */
async function asUser(sub, fn) {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub })]);
    await tx.exec(`set local role authenticated`);
    return fn(tx);
  });
}

/**
 * Corre la consulta sin RLS, como hace la service role.
 *
 * No es una excepción del harness: en Postgres el dueño de la tabla se salta
 * las políticas salvo que lleve `force row level security`, y el rol de
 * servicio de Supabase es justo eso. Por lo mismo, el código que use este
 * camino tiene que filtrar por `user_id` a mano.
 */
async function asService(fn) {
  return db.transaction(fn);
}

function tokenFrom(req) {
  return (req.headers.authorization || "").replace(/^Bearer /i, "");
}

function subFrom(req) {
  const token = tokenFrom(req);
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub;
  } catch {
    return null;
  }
}

// Supabase permite CORS desde cualquier origen; el navegador lo exige antes de
// dejar que la app le hable.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, prefer, x-client-info, accept, accept-profile, content-profile, range, x-supabase-api-version",
  "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, HEAD, OPTIONS",
  "access-control-expose-headers": "content-range, content-location",
  "access-control-max-age": "86400",
};

const json = (res, code, body, headers = {}) => {
  res.writeHead(code, { "content-type": "application/json", ...CORS, ...headers });
  res.end(body === undefined ? "" : JSON.stringify(body));
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }

  try {
    // ---------------- auth ----------------
    if (path === "/auth/v1/token") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (body.email !== USER_EMAIL || body.password !== USER_PASSWORD) {
        return json(res, 400, { error: "invalid_grant", error_description: "Invalid login credentials" });
      }
      return json(res, 200, session(USER_ID));
    }
    if (path === "/auth/v1/signup") {
      return json(res, 200, session(USER_ID));
    }
    if (path === "/auth/v1/user") {
      const sub = subFrom(req);
      if (!sub) return json(res, 401, { message: "invalid claim: missing sub claim" });
      return json(res, 200, userObject(sub));
    }
    if (path === "/auth/v1/logout") return json(res, 204);

    // ---------------- rest ----------------
    if (path.startsWith("/rest/v1/")) {
      const table = path.slice("/rest/v1/".length);
      if (!IDENT.test(table)) return json(res, 404, { message: "no such table" });

      const servicio = Boolean(SERVICE_KEY) && tokenFrom(req) === SERVICE_KEY;
      const sub = servicio ? null : subFrom(req);
      if (!servicio && !sub) return json(res, 401, { message: "JWT required" });

      const prefer = String(req.headers.prefer || "");
      const wantsCount = /count=exact/.test(prefer);
      const wantsRows = /return=representation/.test(prefer) || req.method === "GET" || req.method === "HEAD";
      const single = String(req.headers.accept || "").includes("pgrst.object");

      const correr = servicio ? asService : (fn) => asUser(sub, fn);
      const out = await correr(async (tx) => {
        const args = [];
        const where = buildWhere(url.searchParams, args);

        if (req.method === "GET" || req.method === "HEAD") {
          const select = url.searchParams.get("select") || "*";
          const cols = select === "*" ? "*" :
            select.split(",").map((c) => c.trim().split(/[\s(]/)[0]).filter((c) => IDENT.test(c)).map((c) => `"${c}"`).join(", ");
          let count = null;
          if (wantsCount) {
            const c = await tx.query(`select count(*)::int n from public."${table}"${where}`, args);
            count = c.rows[0].n;
          }
          if (req.method === "HEAD") return { rows: [], count };
          const limit = url.searchParams.get("limit");
          const sql = `select ${cols || "*"} from public."${table}"${where}${buildOrder(url.searchParams)}` +
            (limit ? ` limit ${Number(limit)}` : "");
          const r = await tx.query(sql, args);
          return { rows: r.rows, count };
        }

        if (req.method === "POST") {
          const payload = JSON.parse((await readBody(req)) || "[]");
          const rows = Array.isArray(payload) ? payload : [payload];
          if (!rows.length) return { rows: [] };
          const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => IDENT.test(k));
          const values = [];
          const tuples = rows.map((r) => "(" + keys.map((k) => {
            values.push(r[k] === undefined ? null : r[k]);
            return `$${values.length}`;
          }).join(",") + ")");
          let sql = `insert into public."${table}" (${keys.map((k) => `"${k}"`).join(",")}) values ${tuples.join(",")}`;
          const conflicto = () =>
            (url.searchParams.get("on_conflict") || "").split(",").filter((c) => IDENT.test(c));
          if (/resolution=merge-duplicates/.test(prefer)) {
            const conflict = conflicto();
            const updatable = keys.filter((k) => !conflict.includes(k));
            sql += ` on conflict (${conflict.map((c) => `"${c}"`).join(",")}) do update set ` +
              (updatable.length ? updatable.map((k) => `"${k}" = excluded."${k}"`).join(", ") : `"${conflict[0]}" = excluded."${conflict[0]}"`);
          } else if (/resolution=ignore-duplicates/.test(prefer)) {
            // `upsert(..., { ignoreDuplicates: true })`. Con `return=representation`
            // devuelve SÓLO lo que se insertó de verdad, que es de lo que vive
            // la reserva de `digest_log`: lista vacía = otra corrida llegó antes.
            const conflict = conflicto();
            sql += conflict.length
              ? ` on conflict (${conflict.map((c) => `"${c}"`).join(",")}) do nothing`
              : " on conflict do nothing";
          }
          if (wantsRows) sql += " returning *";
          const r = await tx.query(sql, values);
          return { rows: wantsRows ? r.rows : [] };
        }

        if (req.method === "PATCH") {
          const patch = JSON.parse((await readBody(req)) || "{}");
          const keys = Object.keys(patch).filter((k) => IDENT.test(k));
          if (!keys.length) return { rows: [] };
          const sets = keys.map((k) => { args.push(patch[k]); return `"${k}" = $${args.length}`; });
          // OJO: los args del where ya están al principio; se reconstruye para
          // que la numeración quede en orden.
          const args2 = [];
          const setSql = keys.map((k) => { args2.push(patch[k]); return `"${k}" = $${args2.length}`; }).join(", ");
          const where2 = buildWhere(url.searchParams, args2);
          void sets;
          const sql = `update public."${table}" set ${setSql}${where2}` + (wantsRows ? " returning *" : "");
          const r = await tx.query(sql, args2);
          return { rows: wantsRows ? r.rows : [] };
        }

        if (req.method === "DELETE") {
          const sql = `delete from public."${table}"${where}` + (wantsRows ? " returning *" : "");
          const r = await tx.query(sql, args);
          return { rows: wantsRows ? r.rows : [] };
        }

        return { rows: [] };
      });

      const headers = {};
      if (out.count != null) headers["content-range"] = `0-${Math.max(0, out.count - 1)}/${out.count}`;
      if (req.method === "HEAD") { res.writeHead(200, { ...CORS, ...headers }); return res.end(); }
      if (single) {
        if (out.rows.length > 1) return json(res, 406, { message: "more than one row" }, headers);
        return json(res, 200, out.rows[0] ?? null, headers);
      }
      return json(res, req.method === "POST" ? 201 : 200, out.rows, headers);
    }

    json(res, 404, { message: "not found" });
  } catch (e) {
    console.error("[fake-supabase]", req.method, req.url, "→", e.message);
    json(res, 400, { message: e.message, code: "PGRST", details: null, hint: null });
  }
});

// Un puerto ocupado es el tropiezo más probable al arrancar el demo, y el
// volcado de Node que sale por defecto no le dice a nadie qué hacer.
server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`\nEl puerto ${PORT} ya está ocupado.`);
    console.error("Seguramente hay otro demo corriendo. Ciérralo (Ctrl+C en su");
    console.error(`ventana) o usa otro puerto:  DEMO_PORT=7412 npm run demo\n`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, "127.0.0.1", () => console.log(`fake supabase escuchando en http://127.0.0.1:${PORT}`));
export { db, server };
