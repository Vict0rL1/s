// SÓLO PARA DESARROLLO. Datos de ejemplo para el modo demo.
const BASE = process.env.DEMO_URL || "http://127.0.0.1:7411";
const login = await (await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "victor@ejemplo.com", password: "contrasena" }),
})).json();
const T = login.access_token;
const me = login.user.id;
const H = { "content-type": "application/json", authorization: `Bearer ${T}`, prefer: "return=representation" };

const post = async (table, rows) => {
  const r = await fetch(`${BASE}/rest/v1/${table}`, { method: "POST", headers: H, body: JSON.stringify(rows) });
  const body = await r.json();
  if (!r.ok) { console.error(`✗ ${table}:`, body.message); process.exit(1); }
  console.log(`✓ ${table}: ${body.length}`);
  return body;
};

const HOY = "2026-09-15";        // martes
const d = (n) => { const x = new Date(Date.UTC(2026, 8, 15) + n * 86400000); return x.toISOString().slice(0, 10); };

// PostgREST pone NULL donde falte una clave en un insert múltiple, así que
// todas las filas tienen que traer el mismo juego de columnas.
const task = (o) => ({
  user_id: me, title: "", area: null, due_date: null, due_time: null,
  est_minutes: null, priority: 3, done: false, done_at: null, focus_day: null,
  user_edited_at: null, ...o,
});

await post("tasks", [
  task({ title: "Entregar reporte de laboratorio", area: "SFU", due_date: d(-2), priority: 1, user_edited_at: new Date().toISOString() }),
  task({ title: "Problem set 4", area: "SFU", due_date: HOY, due_time: "23:59:00", est_minutes: 90, priority: 1, focus_day: HOY }),
  task({ title: "Revisar cartera del mes", area: "FINSA", due_date: HOY, est_minutes: 45, priority: 2, focus_day: HOY }),
  task({ title: "Leer cap 4 de econometría", area: "SFU", due_date: d(3), est_minutes: 60, priority: 2 }),
  task({ title: "Reservar cancha", area: "Badminton", due_date: d(5), priority: 3 }),
  task({ title: "Rediseñar el portafolio", area: "Proyectos", due_date: d(20), est_minutes: 240, priority: 3 }),
  task({ title: "Llamar al dentista", area: "Personal", priority: 3 }),
  task({ title: "Comprar cuadernos", area: "Personal", priority: 3 }),
  task({ title: "Quiz 1 de estadística", area: "SFU", due_date: d(-4), done: true, done_at: new Date().toISOString(), priority: 2 }),
  task({ title: "Actualizar hoja de vida", area: "Proyectos", done: true, done_at: new Date().toISOString(), priority: 3 }),
]);

await post("notes", [
  { user_id: me, body: "Idea: agrupar las tareas por energía, no sólo por área. Las de concentración alta en la mañana.", pinned: true },
  { user_id: me, body: "Preguntarle al profe por la rúbrica del proyecto final.", pinned: false },
  { user_id: me, body: "Playlist para estudiar: lo instrumental funciona, lo cantado no.", pinned: false },
]);

const habits = await post("habits", [
  { user_id: me, name: "Leer / estudiar 1 h", days: [1, 2, 3, 4, 5], sort_order: 0 },
  { user_id: me, name: "Entrenar", days: [1, 3, 5, 6], sort_order: 1 },
  { user_id: me, name: "Revisar mercados", days: [1, 2, 3, 4, 5], sort_order: 2 },
  { user_id: me, name: "Cerrar el día en TaskFlow", days: [0, 1, 2, 3, 4, 5, 6], sort_order: 3 },
]);

// Marcas de los últimos días, para que se vean rachas y puntitos
const log = [];
for (let i = 0; i < 12; i++) {
  const day = d(-i);
  const wd = new Date(Date.UTC(2026, 8, 15) - i * 86400000).getUTCDay();
  for (const h of habits) {
    if (!h.days.includes(wd)) continue;
    if (i === 0 && h.name === "Entrenar") continue;        // hoy aún pendiente
    if (i === 4 && h.name === "Revisar mercados") continue; // un hueco, para ver la racha cortada
    log.push({ habit_id: h.id, user_id: me, day });
  }
}
await post("habit_log", log);

await post("blocks", [
  { user_id: me, day: HOY, start_min: 9 * 60, end_min: 10 * 60 + 30, title: "Problem set 4", kind: "tarea" },
  { user_id: me, day: HOY, start_min: 10 * 60 + 30, end_min: 10 * 60 + 45, title: "Descanso", kind: "descanso" },
  { user_id: me, day: HOY, start_min: 14 * 60, end_min: 15 * 60, title: "Revisar cartera", kind: "tarea" },
]);

// Eventos: clases con hora y un deadline de día completo
const iso = (day, h, m) => new Date(`${day}T${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:00-07:00`).toISOString();
await post("events", [
  { user_id: me, title: "ECON 103 D100", starts_at: iso(HOY, 11, 30), ends_at: iso(HOY, 12, 20), all_day_date: null, course_ref: "ECON 103 D100", source: "ics", external_id: "ics:Canvas SFU:econ:1" },
  { user_id: me, title: "CMPT 225 D200", starts_at: iso(HOY, 16, 0), ends_at: iso(HOY, 17, 20), all_day_date: null, course_ref: "CMPT 225 D200", source: "ics", external_id: "ics:Canvas SFU:cmpt:1" },
  { user_id: me, title: "ECON 103 D100", starts_at: iso(d(2), 11, 30), ends_at: iso(d(2), 12, 20), all_day_date: null, course_ref: "ECON 103 D100", source: "ics", external_id: "ics:Canvas SFU:econ:2" },
  { user_id: me, title: "Entrega: proyecto de CMPT", starts_at: null, ends_at: null, all_day_date: d(3), course_ref: "CMPT 225 D200", source: "canvas", external_id: "canvas:assignment:9001" },
]);

console.log("\nlisto — entra con victor@ejemplo.com / contrasena");
