/**
 * SÓLO PARA DESARROLLO Y TESTS. La app no importa nada de esta carpeta.
 *
 * Supabase de mentira: implementa lo justo de PostgREST y de GoTrue que usa
 * TaskFlow, encima de un Postgres de verdad (PGlite, que es Postgres compilado
 * a WebAssembly).
 *
 * Es una función estilo `fetch` (Request → Response), no un servidor: el demo
 * la sirve por HTTP (`supabase.mjs`) y los tests se la pasan directo a
 * supabase-js como `global.fetch`, sin abrir ningún puerto.
 *
 * La RLS es real: cada request corre como el rol `authenticated` con
 * `request.jwt.claims` puesto, así que un insert al que le falte `user_id` lo
 * rechaza Postgres igual que lo haría Supabase. Quien llega con el token de
 * servicio corre sin RLS, como la service role.
 *
 * Lo que NO reproduce: el resto de PostgREST (relaciones anidadas, RPC, filtros
 * que la app no usa), Realtime, Storage, y la confirmación de correo. Sirve
 * para probar la app, no para confiar en que algo funcionará en producción
 * sin haberlo abierto contra el Supabase de verdad.
 */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const SCHEMA = new URL("../../supabase/schema.sql", import.meta.url);

export const DEMO_USER = { email: "victor@ejemplo.com", password: "contrasena" };

// PostgREST entrega date/time/timestamptz como texto, no como objetos. PGlite
// los convierte a Date por defecto, y eso rompería comparaciones como
// `task.due_date === today`. Se devuelven crudos para que el harness mienta lo
// menos posible.
const RAW = (v) => v;

const IDENT = /^[a-z_][a-z0-9_]*$/i;
const OPS = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=", like: "like", ilike: "ilike" };

class FilterError extends Error {}

/**
 * Un filtro de PostgREST (`eq.5`, `is.null`, `not.is.null`, `in.(a,b)`,
 * `fts(simple).palabra:*`) a SQL.
 *
 * Un operador que no conoce **revienta** en vez de saltarse: un harness que
 * ignora un filtro en silencio devuelve filas que Supabase no devolvería, y la
 * prueba pasa por la razón equivocada.
 */
function clause(key, raw, args) {
  const dot = raw.indexOf(".");
  const op = raw.slice(0, dot), value = raw.slice(dot + 1);
  if (op === "not") return `not (${clause(key, value, args)})`;
  if (op === "is") {
    if (!["null", "true", "false"].includes(value)) throw new FilterError(`is.${value}`);
    return `"${key}" is ${value}`;
  }
  if (op === "in") {
    const list = value.replace(/^\(|\)$/g, "").split(",").map((v) => v.replace(/^"|"$/g, ""));
    if (!list.length || (list.length === 1 && list[0] === "")) return "false";
    return `"${key}" in (${list.map((v) => { args.push(v); return `$${args.length}`; }).join(",")})`;
  }
  const fts = /^fts(?:\((\w+)\))?$/.exec(op);
  if (fts) {
    args.push(value);
    return `"${key}" @@ to_tsquery('${fts[1] || "simple"}', $${args.length})`;
  }
  if (OPS[op]) {
    args.push(value);
    return `"${key}" ${OPS[op]} $${args.length}`;
  }
  throw new FilterError(`${op} en ${key}`);
}

/** `or=(a.eq.1,b.is.null)` — sólo un nivel, que es lo que usa la app. */
function orClause(raw, args) {
  const inner = raw.replace(/^\(|\)$/g, "");
  const parts = [];
  let depth = 0, cur = "";
  for (const ch of inner) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; } else cur += ch;
  }
  if (cur) parts.push(cur);
  return "(" + parts.map((p) => {
    const dot = p.indexOf(".");
    const key = p.slice(0, dot);
    if (!IDENT.test(key)) throw new FilterError(`or: ${p}`);
    return clause(key, p.slice(dot + 1), args);
  }).join(" or ") + ")";
}

function buildWhere(params, args) {
  const clauses = [];
  for (const [key, raw] of params) {
    if (["select", "order", "limit", "offset", "on_conflict", "columns"].includes(key)) continue;
    if (key === "or") { clauses.push(orClause(raw, args)); continue; }
    if (!IDENT.test(key)) continue;
    clauses.push(clause(key, raw, args));
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

// Supabase permite CORS desde cualquier origen; el navegador lo exige antes de
// dejar que la app le hable.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, prefer, x-client-info, accept, accept-profile, content-profile, range, x-supabase-api-version",
  "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, HEAD, OPTIONS",
  "access-control-expose-headers": "content-range, content-location",
  "access-control-max-age": "86400",
};

const json = (code, body, headers = {}) =>
  new Response(code === 204 || body === undefined ? null : JSON.stringify(body), {
    status: code,
    headers: { "content-type": "application/json", ...CORS, ...headers },
  });

// --- JWT de mentira (el cliente lo decodifica, no lo verifica) --------------
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

/**
 * Levanta un Postgres en memoria con el esquema de la app y devuelve el
 * manejador. `users` son las cuentas que existen desde el arranque.
 *
 * @param {{ serviceKey?: string | null, users?: { email: string, password: string }[] }} [opts]
 */
export async function createFakeSupabase({ serviceKey = null, users = [DEMO_USER] } = {}) {
  const db = await PGlite.create({
    parsers: {
      1082: RAW, // date
      1083: RAW, // time
      1114: RAW, // timestamp
      1184: RAW, // timestamptz
      // PostgREST manda `numeric` como número de JSON; PGlite, como texto.
      1700: (v) => (v == null ? v : Number(v)),
    },
  });

  // --- piezas que Supabase trae de fábrica ---------------------------------
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
    grant all on all sequences in schema public to authenticated;
  `);

  const cuentas = new Map(); // email -> { id, password }
  const porId = new Map(); // id -> email
  for (const u of users) {
    const r = await db.query(`insert into auth.users (email) values ($1) returning id`, [u.email]);
    cuentas.set(u.email, { id: r.rows[0].id, password: u.password });
    porId.set(r.rows[0].id, u.email);
  }

  function tokenFor(sub) {
    const now = Math.floor(Date.now() / 1000);
    return [
      b64({ alg: "HS256", typ: "JWT" }),
      b64({ sub, email: porId.get(sub), role: "authenticated", aud: "authenticated", iat: now, exp: now + 3600 }),
      "firma-de-mentira",
    ].join(".");
  }
  const userObject = (id) => ({
    id, aud: "authenticated", role: "authenticated", email: porId.get(id),
    email_confirmed_at: new Date().toISOString(), phone: "",
    confirmed_at: new Date().toISOString(), last_sign_in_at: new Date().toISOString(),
    app_metadata: { provider: "email", providers: ["email"] }, user_metadata: {},
    identities: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    is_anonymous: false,
  });
  const session = (id) => ({
    access_token: tokenFor(id), token_type: "bearer", expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: "refresh-de-mentira", user: userObject(id),
  });

  /** Corre la consulta como el usuario del token, con RLS activa. */
  const asUser = (sub, fn) =>
    db.transaction(async (tx) => {
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub })]);
      await tx.exec(`set local role authenticated`);
      return fn(tx);
    });

  /**
   * Corre la consulta sin RLS, como hace la service role.
   *
   * No es una excepción del harness: en Postgres el dueño de la tabla se salta
   * las políticas salvo que lleve `force row level security`, y el rol de
   * servicio de Supabase es justo eso. Por lo mismo, el código que use este
   * camino tiene que filtrar por `user_id` a mano.
   */
  const asService = (fn) => db.transaction(fn);

  const tokenFrom = (req) => (req.headers.get("authorization") || "").replace(/^Bearer /i, "");
  function subFrom(req) {
    try {
      const sub = JSON.parse(Buffer.from(tokenFrom(req).split(".")[1], "base64url").toString()).sub;
      return porId.has(sub) ? sub : null;
    } catch {
      return null;
    }
  }

  /** Cuántas veces se pidió cada ruta. Para tests que cuentan viajes. */
  const hits = new Map();

  async function handle(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    try {
      // ---------------- auth ----------------
      if (path === "/auth/v1/token") {
        const body = JSON.parse((await req.text()) || "{}");
        const c = cuentas.get(body.email);
        if (!c || c.password !== body.password) {
          return json(400, { error: "invalid_grant", error_description: "Invalid login credentials" });
        }
        return json(200, session(c.id));
      }
      if (path === "/auth/v1/signup") {
        const body = JSON.parse((await req.text()) || "{}");
        const c = cuentas.get(body.email) ?? [...cuentas.values()][0];
        return json(200, session(c.id));
      }
      if (path === "/auth/v1/user") {
        const sub = subFrom(req);
        if (!sub) return json(401, { message: "invalid claim: missing sub claim" });
        return json(200, userObject(sub));
      }
      if (path === "/auth/v1/logout") return json(204);

      // ---------------- rest ----------------
      if (path.startsWith("/rest/v1/")) {
        const table = path.slice("/rest/v1/".length);
        if (!IDENT.test(table)) return json(404, { message: "no such table" });

        const servicio = Boolean(serviceKey) && tokenFrom(req) === serviceKey;
        const sub = servicio ? null : subFrom(req);
        if (!servicio && !sub) return json(401, { message: "JWT required" });

        const prefer = String(req.headers.get("prefer") || "");
        const wantsCount = /count=exact/.test(prefer);
        const wantsRows = /return=representation/.test(prefer) || req.method === "GET" || req.method === "HEAD";
        const single = String(req.headers.get("accept") || "").includes("pgrst.object");
        const bodyText = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();

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
            const offset = url.searchParams.get("offset");
            const sql = `select ${cols || "*"} from public."${table}"${where}${buildOrder(url.searchParams)}` +
              (limit ? ` limit ${Number(limit)}` : "") +
              (offset ? ` offset ${Number(offset)}` : "");
            const r = await tx.query(sql, args);
            return { rows: r.rows, count };
          }

          if (req.method === "POST") {
            const payload = JSON.parse(bodyText || "[]");
            const rows = Array.isArray(payload) ? payload : [payload];
            if (!rows.length) return { rows: [] };
            const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => IDENT.test(k));
            const values = [];
            const tuples = rows.map((r) => "(" + keys.map((k) => {
              const v = r[k] === undefined ? null : r[k];
              values.push(v !== null && typeof v === "object" && !Array.isArray(v) ? JSON.stringify(v) : v);
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
            const patch = JSON.parse(bodyText || "{}");
            const keys = Object.keys(patch).filter((k) => IDENT.test(k));
            if (!keys.length) return { rows: [] };
            // Los args del SET van primero; el where se arma después para que
            // la numeración de los parámetros quede en orden.
            const args2 = [];
            const setSql = keys.map((k) => {
              const v = patch[k];
              args2.push(v !== null && typeof v === "object" && !Array.isArray(v) ? JSON.stringify(v) : v);
              return `"${k}" = $${args2.length}`;
            }).join(", ");
            const where2 = buildWhere(url.searchParams, args2);
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
        if (req.method === "HEAD") return new Response(null, { status: 200, headers: { ...CORS, ...headers } });
        if (single) {
          if (out.rows.length > 1) return json(406, { message: "more than one row" }, headers);
          return json(200, out.rows[0] ?? null, headers);
        }
        return json(req.method === "POST" ? 201 : 200, out.rows, headers);
      }

      return json(404, { message: "not found" });
    } catch (e) {
      if (!process.env.VITEST) console.error("[fake-supabase]", req.method, req.url, "→", e.message);
      return json(400, { message: e.message, code: e.code || "PGRST", details: null, hint: null });
    }
  }

  return {
    db,
    handle,
    /** Para supabase-js: `createClient(url, key, { global: { fetch: fake.fetch } })`. */
    fetch: (input, init) => handle(input instanceof Request && !init ? input : new Request(input, init)),
    userId: (email) => cuentas.get(email)?.id,
    tokenFor,
    hits,
  };
}
