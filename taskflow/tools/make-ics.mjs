/**
 * `npm run ics` — escribe `mi-semestre.ics` con las clases, tutorías, horas de
 * oficina y entregas de los tres cursos.
 *
 * Para qué: el demo se borra al cerrarse, pero este archivo no. Cuando tengas
 * Supabase andando, lo subes desde **Ajustes → Importar calendario** y tu
 * semestre queda dentro de la app de verdad. También se puede importar a
 * Google Calendar o a Apple Calendar, que entienden el mismo formato.
 *
 * Reimportarlo no duplica nada: cada evento lleva un UID estable y el
 * importador arma el `external_id` a partir de él.
 */
import { writeFileSync } from "node:fs";
import {
  COURSES,
  EXAM_WINDOW,
  meetingDates,
  meetingTitle,
  wallTimeToInstant,
} from "./semester.mjs";

const SALIDA = process.argv[2] || "mi-semestre.ics";

const utc = (iso) => iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const ymd = (d) => d.replace(/-/g, "");

/** Escapa los caracteres que en iCalendar separan campos. */
const esc = (s) =>
  String(s).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");

/**
 * Dobla las líneas a 75 octetos, que es lo que exige el RFC 5545.
 * Se cuenta en bytes, no en caracteres: los acentos ocupan dos y cortar a la
 * mitad de uno produce un archivo que algunos calendarios rechazan.
 */
function fold(line) {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const out = [];
  let inicio = 0;
  while (inicio < bytes.length) {
    const limite = out.length === 0 ? 75 : 74; // las continuaciones gastan un espacio
    let fin = Math.min(inicio + limite, bytes.length);
    // No cortar a mitad de un carácter multibyte.
    while (fin > inicio && fin < bytes.length && (bytes[fin] & 0xc0) === 0x80) fin--;
    out.push((out.length ? " " : "") + bytes.slice(inicio, fin).toString("utf8"));
    inicio = fin;
  }
  return out.join("\r\n");
}

const STAMP = utc(new Date().toISOString());
const lineas = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//TaskFlow//Semestre//ES",
  "CALSCALE:GREGORIAN",
  "METHOD:PUBLISH",
  "X-WR-CALNAME:Semestre SFU — otoño 2026",
];

/**
 * Recordatorio dentro del propio evento.
 *
 * Esto es lo que hace que Google Calendar (o el calendario del iPhone) avise
 * sin que haya que configurar nada a mano evento por evento — y sin depender
 * del cron de Vercel, que en el plan gratis sólo corre una vez al día.
 *
 * `trigger` es un intervalo ISO-8601 relativo al inicio. Negativo = antes.
 */
const alarma = (trigger, texto) => [
  "BEGIN:VALARM",
  "ACTION:DISPLAY",
  `TRIGGER:${trigger}`,
  `DESCRIPTION:${esc(texto)}`,
  "END:VALARM",
];

function evento({ uid, start, end, day, summary, location, description, alarms = [] }) {
  const v = ["BEGIN:VEVENT", `UID:${uid}`, `DTSTAMP:${STAMP}`];
  if (day) {
    // Un evento de día completo termina al día siguiente: DTEND es exclusivo.
    const siguiente = new Date(`${day}T00:00:00Z`);
    siguiente.setUTCDate(siguiente.getUTCDate() + 1);
    v.push(`DTSTART;VALUE=DATE:${ymd(day)}`);
    v.push(`DTEND;VALUE=DATE:${ymd(siguiente.toISOString().slice(0, 10))}`);
  } else {
    v.push(`DTSTART:${utc(start)}`, `DTEND:${utc(end)}`);
  }
  v.push(`SUMMARY:${esc(summary)}`);
  if (location) v.push(`LOCATION:${esc(location)}`);
  if (description) v.push(`DESCRIPTION:${esc(description)}`);
  for (const a of alarms) v.push(...a);
  v.push("END:VEVENT");
  lineas.push(...v);
}

let conHora = 0;
let diaCompleto = 0;

for (const course of COURSES) {
  const slug = course.code.toLowerCase().replace(/\s+/g, "");
  const quien = `${course.name} · ${course.instructor} (${course.email})`;

  for (const m of course.meetings) {
    const titulo = meetingTitle(course, m);
    for (const day of meetingDates(course, m)) {
      const uid = `${slug}-${m.kind}-${m.weekday}-${ymd(day)}@taskflow`;
      if (m.start && m.end) {
        evento({
          uid,
          start: wallTimeToInstant(day, m.start),
          end: wallTimeToInstant(day, m.end),
          summary: titulo,
          location: m.location,
          description: quien,
          alarms: m.kind === "oficina" ? [] : [alarma("-PT15M", `${titulo} en 15 minutos`)],
        });
        conHora++;
      } else {
        // Sin hora en el programa. Va como día completo para que aparezca en el
        // día correcto sin fingir un horario que nadie ha confirmado.
        evento({
          uid,
          day,
          summary: `${titulo} (falta la hora)`,
          location: m.location,
          description: `${quien}\nEl programa no da la hora. Confírmala en goSFU o en Canvas.`,
        });
        diaCompleto++;
      }
    }
  }

  for (const d of course.deadlines) {
    evento({
      uid: `${slug}-entrega-${ymd(d.date)}@taskflow`,
      day: d.date,
      summary: `${course.code}: ${d.title}`,
      description: [d.note, quien].filter(Boolean).join("\n"),
      alarms: [
        alarma("-PT6H", `Mañana: ${course.code} — ${d.title}`),
        alarma("PT9H", `Hoy: ${course.code} — ${d.title}`),
      ],
    });
    diaCompleto++;
  }
}

// El Registrar todavía no publica las fechas, así que en vez de inventarlas se
// marca el primer día de la ventana como recordatorio de ir a mirarlas.
evento({
  uid: `finales-${ymd(EXAM_WINDOW.start)}@taskflow`,
  day: EXAM_WINDOW.start,
  summary: "Empiezan los exámenes finales (fechas por confirmar)",
  description:
    `Ventana de exámenes: ${EXAM_WINDOW.start} a ${EXAM_WINDOW.end}.\n` +
    "Los finales de ECON 342, ECON 260 y ECON 370 caen aquí dentro; el " +
    "Registrar asigna día, hora y sala. Los tres programas piden estar en " +
    "Vancouver todo el periodo.",
});
diaCompleto++;

lineas.push("END:VCALENDAR");

writeFileSync(SALIDA, lineas.map(fold).join("\r\n") + "\r\n");
console.log(`${SALIDA}: ${conHora} eventos con hora y ${diaCompleto} de día completo.`);
console.log("Súbelo desde Ajustes → Importar calendario cuando tengas Supabase.");
