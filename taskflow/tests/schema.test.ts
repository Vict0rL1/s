import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { asService, asUser, freshDb, newUser } from "./helpers/db";

const SCHEMA = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8")
  .replace(/create extension if not exists "pgcrypto";/, "");

/**
 * `schema.sql` se aplica a mano desde el SQL Editor, y Victor lo va a volver a
 * correr cada vez que haya una columna nueva. Tiene que poder correrse sobre
 * una base con datos sin romper nada ni perder filas.
 */
describe("schema.sql", () => {
  it("se puede aplicar dos veces sin perder datos", async () => {
    const db = await freshDb();
    const uid = await newUser(db, "victor@ejemplo.com");
    await asUser(db, uid, (tx) =>
      tx.query(`insert into tasks (user_id, title, done) values ($1, 'Problem set 4', true)`, [uid]));

    await db.exec(SCHEMA);
    await db.exec(SCHEMA);

    const r = await asService(db, (tx) =>
      tx.query<{ title: string; done: boolean }>(`select title, done from tasks where user_id = $1`, [uid]));
    expect(r.rows).toEqual([{ title: "Problem set 4", done: true }]);
  });

  it("toda tabla de public tiene la RLS encendida", async () => {
    const db = await freshDb();
    const r = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'`);
    expect(r.rows.length).toBeGreaterThan(5);
    for (const t of r.rows) expect(t.relrowsecurity, t.relname).toBe(true);
  });

  it("actualiza un sync_state viejo (source como enum) sin perder la fila", async () => {
    const RAW = (v: string) => v;
    const db = await PGlite.create({ parsers: { 1184: RAW } });
    await db.exec(`
      create schema auth;
      create table auth.users (id uuid primary key default gen_random_uuid(), email text);
      create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
      create role authenticated; create role anon;
      create type public.item_source as enum ('manual', 'canvas', 'gcal', 'ics');
      create table public.sync_state (
        user_id uuid not null references auth.users (id) on delete cascade,
        source public.item_source not null,
        last_synced_at timestamptz,
        last_error text,
        items_synced int not null default 0,
        primary key (user_id, source)
      );
    `);
    const u = await db.query<{ id: string }>(`insert into auth.users (email) values ('v@x') returning id`);
    const uid = u.rows[0].id;
    await db.query(
      `insert into sync_state (user_id, source, last_synced_at, items_synced) values ($1, 'canvas', '2026-09-30T10:00:00Z', 7)`,
      [uid],
    );

    await db.exec(SCHEMA);

    const r = await db.query<{ source: string; items_synced: number; last_success_at: string; t: string }>(
      `select source, items_synced, last_success_at, pg_typeof(source)::text as t from sync_state`,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ source: "canvas", items_synced: 7, t: "text" });
    // El sync de antes no dejó error: cuenta como último éxito.
    expect(r.rows[0].last_success_at).toContain("2026-09-30");

    // Y ya acepta las integraciones nuevas, pero no cualquier cosa.
    await db.query(`insert into sync_state (user_id, source) values ($1, 'cron')`, [uid]);
    await expect(db.query(`insert into sync_state (user_id, source) values ($1, 'cualquiera')`, [uid])).rejects.toThrow();
  });
});
