/**
 * Un Postgres de verdad (PGlite) con `supabase/schema.sql` aplicado, para
 * probar lo que sólo existe dentro de la base: la RLS, las claves únicas, los
 * `ON CONFLICT`. Lo de Supabase que el esquema da por hecho (`auth.users`,
 * `auth.uid()`, los roles) se imita con lo mínimo, igual que en el demo.
 */
import { readFileSync } from "node:fs";
import { PGlite, type Transaction } from "@electric-sql/pglite";

const SCHEMA = readFileSync(new URL("../../supabase/schema.sql", import.meta.url), "utf8");

// Como PostgREST: fechas y horas como texto, no como `Date`.
const RAW = (v: string) => v;

export type Db = PGlite;
export type Tx = Transaction;

export async function freshDb(): Promise<Db> {
  const db = await PGlite.create({ parsers: { 1082: RAW, 1083: RAW, 1114: RAW, 1184: RAW } });
  await db.exec(`
    create schema if not exists auth;
    create table if not exists auth.users (
      id uuid primary key default gen_random_uuid(),
      email text unique
    );
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claims', true)::json->>'sub','')::uuid
    $$;
    create role authenticated;
    create role anon;
  `);
  await db.exec(SCHEMA.replace(/create extension if not exists "pgcrypto";/, ""));
  // Supabase concede todo a estos roles y deja que la RLS decida. Igual aquí:
  // si una prueba pasa, es por la política, no por un permiso que falta.
  await db.exec(`
    grant usage on schema public, auth to authenticated, anon;
    grant all on all tables in schema public to authenticated, anon;
    grant all on all sequences in schema public to authenticated, anon;
  `);
  return db;
}

export async function newUser(db: Db, email: string): Promise<string> {
  const r = await db.query<{ id: string }>(`insert into auth.users (email) values ($1) returning id`, [email]);
  return r.rows[0].id;
}

/** Corre `fn` como ese usuario, con la RLS encendida. */
export function asUser<T>(db: Db, uid: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(uid ? { sub: uid } : {})]);
    await tx.exec(`set local role ${uid ? "authenticated" : "anon"}`);
    return fn(tx);
  });
}

/** Corre `fn` sin RLS, como la service role. */
export function asService<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(fn);
}

/** `true` si la consulta revienta (la RLS rechaza un insert con un error, no con 0 filas). */
export async function rejects(p: Promise<unknown>): Promise<boolean> {
  try {
    await p;
    return false;
  } catch {
    return true;
  }
}
