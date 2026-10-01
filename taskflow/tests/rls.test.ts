import { beforeAll, describe, expect, it } from "vitest";
import { type Db, asService, asUser, freshDb, newUser, rejects } from "./helpers/db";

/**
 * Aislamiento entre usuarios, contra el esquema real.
 *
 * La anon key es pública: cualquiera puede hablarle a PostgREST con ella. Lo
 * único que separa tus filas de las de otro es la RLS, así que se prueba tabla
 * por tabla y operación por operación.
 */

let db: Db;
let A: string;
let B: string;
const ids: Record<string, string> = {};

beforeAll(async () => {
  db = await freshDb();
  A = await newUser(db, "a@ejemplo.com");
  B = await newUser(db, "b@ejemplo.com");

  // Una fila de cada tabla para A, escrita como A: si esto no funcionara, la
  // app tampoco.
  await asUser(db, A, async (tx) => {
    const one = async (sql: string, params: unknown[] = []) =>
      (await tx.query<{ id: string }>(sql, params)).rows[0]?.id;

    ids.task = await one(`insert into tasks (user_id, title) values ($1, 'secreto de A') returning id`, [A]);
    ids.event = await one(
      `insert into events (user_id, title, all_day_date, source, external_id)
       values ($1, 'evento de A', '2026-10-01', 'ics', 'x') returning id`, [A]);
    ids.note = await one(`insert into notes (user_id, body) values ($1, 'nota de A') returning id`, [A]);
    ids.habit = await one(`insert into habits (user_id, name) values ($1, 'correr') returning id`, [A]);
    await tx.query(`insert into habit_log (habit_id, user_id, day) values ($1, $2, '2026-09-30')`, [ids.habit, A]);
    ids.block = await one(
      `insert into blocks (user_id, day, start_min, end_min, title, task_id)
       values ($1, '2026-09-30', 600, 660, 'bloque de A', $2) returning id`, [A, ids.task]);
    await tx.query(
      `insert into push_subscriptions (endpoint, user_id, p256dh, auth) values ('https://push/a', $1, 'k', 'a')`, [A]);
    await tx.query(`insert into sync_state (user_id, source, last_error) values ($1, 'canvas', 'error de A')`, [A]);
    await tx.query(`insert into digest_log (user_id, day, kind) values ($1, '2026-09-30', 'morning')`, [A]);
    await tx.query(`insert into telegram_chats (user_id, link_code) values ($1, 'codigo-de-a')`, [A]);
    await tx.query(`insert into activity_log (user_id, actor, kind, summary) values ($1, 'canvas', 'canvas.added', 'algo de A')`, [A]);
    await tx.query(`insert into gcal_links (user_id, refresh_token) values ($1, 'v1.cifrado.de.A')`, [A]);
  });

  // El perfil lo crea el trigger de registro; se comprueba que existe.
  const p = await asService(db, (tx) => tx.query(`select id from profiles where id = $1`, [A]));
  expect(p.rows).toHaveLength(1);
});

const TABLAS = [
  "tasks", "events", "notes", "habits", "habit_log", "blocks",
  "push_subscriptions", "sync_state", "digest_log", "telegram_chats", "activity_log", "gcal_links",
] as const;

describe("B no ve nada de A", () => {
  for (const t of TABLAS) {
    it(t, async () => {
      const r = await asUser(db, B, (tx) => tx.query(`select * from ${t}`));
      expect(r.rows).toHaveLength(0);
    });
  }

  it("profiles", async () => {
    const r = await asUser(db, B, (tx) => tx.query(`select * from profiles where id = $1`, [A]));
    expect(r.rows).toHaveLength(0);
  });

  it("sin sesión (anon) no se ve nada", async () => {
    for (const t of [...TABLAS, "profiles"]) {
      const r = await asUser(db, null, (tx) => tx.query(`select * from ${t}`));
      expect(r.rows, t).toHaveLength(0);
    }
  });
});

describe("B no puede tocar las filas de A", () => {
  it("update y delete no afectan ninguna fila", async () => {
    for (const t of TABLAS) {
      const upd = await asUser(db, B, (tx) =>
        tx.query(`update ${t} set user_id = $1 where user_id = $2`, [B, A]));
      expect(upd.affectedRows, `update ${t}`).toBe(0);
      const del = await asUser(db, B, (tx) => tx.query(`delete from ${t} where user_id = $1`, [A]));
      expect(del.affectedRows, `delete ${t}`).toBe(0);
    }
    const prof = await asUser(db, B, (tx) =>
      tx.query(`update profiles set timezone = 'UTC' where id = $1`, [A]));
    expect(prof.affectedRows).toBe(0);

    // Y todo sigue ahí.
    const n = await asService(db, (tx) => tx.query(`select 1 from tasks where user_id = $1`, [A]));
    expect(n.rows).toHaveLength(1);
  });

  it("no puede insertar filas a nombre de A", async () => {
    expect(await rejects(asUser(db, B, (tx) =>
      tx.query(`insert into tasks (user_id, title) values ($1, 'intruso')`, [A])))).toBe(true);
    expect(await rejects(asUser(db, B, (tx) =>
      tx.query(`insert into notes (user_id, body) values ($1, 'intruso')`, [A])))).toBe(true);
    expect(await rejects(asUser(db, B, (tx) =>
      tx.query(`insert into digest_log (user_id, day, kind) values ($1, '2026-10-01', 'night')`, [A])))).toBe(true);
    // Ni plantar su propio permiso de Google en la cuenta de A.
    expect(await rejects(asUser(db, B, (tx) =>
      tx.query(`insert into gcal_links (user_id, refresh_token) values ($1, 'v1.de.B.x')`, [A])))).toBe(true);
  });

  /**
   * La clave de `habit_log` es (habit_id, day). Si B pudiera escribir una fila
   * propia con el `habit_id` de A, ocuparía ese día y A ya no podría marcar su
   * rutina — sin ver siquiera la fila que se lo impide.
   */
  it("no puede registrar días en la rutina de A", async () => {
    const intento = asUser(db, B, (tx) =>
      tx.query(`insert into habit_log (habit_id, user_id, day) values ($1, $2, '2026-10-02')`, [ids.habit, B]));
    expect(await rejects(intento)).toBe(true);

    // A sí puede marcar ese día.
    await asUser(db, A, (tx) =>
      tx.query(`insert into habit_log (habit_id, user_id, day) values ($1, $2, '2026-10-02')`, [ids.habit, A]));
  });

  it("no puede colgar un bloque suyo de una tarea de A", async () => {
    const intento = asUser(db, B, (tx) =>
      tx.query(
        `insert into blocks (user_id, day, start_min, end_min, title, task_id)
         values ($1, '2026-09-30', 600, 660, 'x', $2)`, [B, ids.task]));
    expect(await rejects(intento)).toBe(true);

    // Sin tarea, o con una suya, sí.
    await asUser(db, B, (tx) =>
      tx.query(`insert into blocks (user_id, day, start_min, end_min, title) values ($1, '2026-09-30', 600, 660, 'x')`, [B]));
  });

  it("no puede apropiarse de la suscripción push de A", async () => {
    const intento = asUser(db, B, (tx) =>
      tx.query(
        `insert into push_subscriptions (endpoint, user_id, p256dh, auth) values ('https://push/a', $1, 'k', 'b')
         on conflict (endpoint) do update set user_id = excluded.user_id, auth = excluded.auth`, [B]));
    expect(await rejects(intento)).toBe(true);
    const r = await asService(db, (tx) =>
      tx.query<{ user_id: string }>(`select user_id from push_subscriptions where endpoint = 'https://push/a'`));
    expect(r.rows[0].user_id).toBe(A);
  });
});
