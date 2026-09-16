// SÓLO PARA DESARROLLO. Siembra el modo demo con el semestre real de Victor,
// leído de `tools/semester.mjs`. Los datos viven en memoria y se van al cerrar.
import {
  COURSES,
  EXAM_WINDOW,
  TZ,
  addDays,
  meetingDates,
  meetingTitle,
  missingTimes,
  wallTimeToInstant,
} from "../semester.mjs";

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

// El día de hoy en Vancouver, no en la zona del servidor. Antes estaba fijo en
// una fecha de septiembre, así que el demo envejecía: "Hoy" mostraba un día que
// ya había pasado.
const HOY = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());

// PostgREST pone NULL donde falte una clave en un insert múltiple, así que
// todas las filas tienen que traer el mismo juego de columnas.
const task = (o) => ({
  user_id: me, title: "", area: null, body: null, due_date: null, due_time: null,
  est_minutes: null, priority: 3, done: false, done_at: null, focus_day: null,
  user_edited_at: null, ...o,
});

/* ------------------------------------------------------------------ tareas */

const tareas = [];

for (const course of COURSES) {
  for (const d of course.deadlines) {
    tareas.push(task({
      title: `${course.code}: ${d.title}`,
      area: "SFU",
      body: d.note ?? null,
      due_date: d.date,
      priority: d.priority ?? 2,
    }));
  }
  // Lo que el programa menciona pero no fecha. Entra sin `due_date` para que no
  // finja un vencimiento que nadie ha publicado.
  for (const pendiente of course.pending ?? []) {
    tareas.push(task({ title: `${course.code}: ${pendiente}`, area: "SFU", priority: 2 }));
  }
}

tareas.push(
  task({
    title: "Mirar las fechas de los finales cuando salgan",
    area: "SFU",
    body: `Ventana ${EXAM_WINDOW.start} a ${EXAM_WINDOW.end}. Las publica el Registrar.`,
    due_date: EXAM_WINDOW.start,
    priority: 2,
  }),
  task({ title: "Confirmar hora y sala del tutorial de ECON 342 en goSFU", area: "SFU", priority: 1 }),
  task({ title: "Confirmar la hora de la clase y del tutorial de ECON 370", area: "SFU", priority: 1 }),
  task({ title: "Instalar R y RStudio para ECON 260", area: "SFU", est_minutes: 30, priority: 2 }),
  task({ title: "Revisar cartera del mes", area: "FINSA", est_minutes: 45, priority: 2 }),
  task({ title: "Reservar cancha", area: "Badminton", priority: 3 }),
  task({ title: "Llamar al dentista", area: "Personal", priority: 3 }),
);

await post("tasks", tareas);

/* ------------------------------------------------------------------- notas */

await post("notes", [
  { user_id: me, body: "ECON 370: el tema de la propuesta (9 nov) tiene que ser el mismo del proyecto final (7 dic). Si lo cambio, hay que mandarle un correo a Kissel al menos una semana antes.", pinned: true },
  { user_id: me, body: "ECON 260: de los 4 problem sets sólo cuentan los 3 mejores, y no se aceptan tarde. La tarea estadística sí se acepta tarde, pero con 20% por día.", pinned: true },
  { user_id: me, body: "ECON 342 no permite IA en trabajo entregado sin permiso escrito. ECON 370 sí la permite para investigar, declarándola. Son políticas distintas — no mezclarlas.", pinned: false },
  { user_id: me, body: "ECON 370 exige calculadora NO programable (sin IA, sin teléfono). ECON 260 sólo dice \"se permite calculadora\". El midterm de ECON 260 es a libro cerrado y sin apuntes.", pinned: false },
]);

/* ----------------------------------------------------------------- rutinas */

const habits = await post("habits", [
  { user_id: me, name: "Leer / estudiar 1 h", days: [1, 2, 3, 4, 5], sort_order: 0 },
  { user_id: me, name: "Entrenar", days: [1, 3, 5, 6], sort_order: 1 },
  { user_id: me, name: "Revisar mercados", days: [1, 2, 3, 4, 5], sort_order: 2 },
  { user_id: me, name: "Cerrar el día en TaskFlow", days: [0, 1, 2, 3, 4, 5, 6], sort_order: 3 },
]);

const log = [];
for (let i = 0; i < 12; i++) {
  const day = addDays(HOY, -i);
  const wd = new Date(`${day}T00:00:00Z`).getUTCDay();
  for (const h of habits) {
    if (!h.days.includes(wd)) continue;
    if (i === 0 && h.name === "Entrenar") continue;         // hoy aún pendiente
    if (i === 4 && h.name === "Revisar mercados") continue; // un hueco, para ver la racha cortada
    log.push({ habit_id: h.id, user_id: me, day });
  }
}
await post("habit_log", log);

/* ---------------------------------------------------------------- eventos */

const eventos = [];

for (const course of COURSES) {
  const slug = course.code.toLowerCase().replace(/\s+/g, "");
  for (const m of course.meetings) {
    const titulo = meetingTitle(course, m);
    for (const day of meetingDates(course, m)) {
      const base = {
        user_id: me,
        title: titulo,
        location: m.location,
        course_ref: course.code,
        source: "ics",
        external_id: `ics:Semestre:${slug}:${m.kind}:${m.weekday}:${day}`,
      };
      if (m.start && m.end) {
        eventos.push({
          ...base,
          starts_at: wallTimeToInstant(day, m.start),
          ends_at: wallTimeToInstant(day, m.end),
          all_day_date: null,
        });
      } else {
        // Sin hora en el programa: va como día completo, no con una inventada.
        eventos.push({
          ...base,
          title: `${titulo} (falta la hora)`,
          starts_at: null,
          ends_at: null,
          all_day_date: day,
        });
      }
    }
  }

  for (const d of course.deadlines) {
    eventos.push({
      user_id: me,
      title: `${course.code}: ${d.title}`,
      location: null,
      course_ref: course.code,
      source: "canvas",
      external_id: `canvas:deadline:${slug}:${d.date}`,
      starts_at: null,
      ends_at: null,
      all_day_date: d.date,
    });
  }
}

await post("events", eventos);

/* ----------------------------------------------------------------- bloques */

// Un par de bloques de hoy, para que la agenda no se vea sólo con clases.
await post("blocks", [
  { user_id: me, day: HOY, start_min: 14 * 60, end_min: 15 * 60 + 30, title: "Leer para ECON 342", kind: "tarea" },
  { user_id: me, day: HOY, start_min: 15 * 60 + 30, end_min: 15 * 60 + 45, title: "Descanso", kind: "descanso" },
]);

const faltan = missingTimes();
if (faltan.length) {
  const dias = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
  console.log("\nSin hora en el programa (salen como día completo):");
  for (const f of faltan) console.log(`  · ${f.course} ${f.kind}, los ${dias[f.weekday]}`);
}

console.log("\nlisto — entra con victor@ejemplo.com / contrasena");
