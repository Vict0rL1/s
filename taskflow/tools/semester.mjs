/**
 * El semestre de Victor — otoño 2026, tres cursos de SFU.
 *
 * Es la única copia de estos datos. La lee `tools/demo/seed.mjs` (para que
 * `npm run demo` muestre tu semestre de verdad y no datos inventados) y
 * `tools/make-ics.mjs` (para generar un `.ics` importable desde Ajustes).
 *
 * Todo sale de los tres programas del curso. Lo que el programa no dice, aquí
 * va en `null` y se marca como pendiente — no se inventa una hora ni una fecha.
 */

export const TZ = "America/Vancouver";

/** Primer y último día de clases del término. */
export const TERM = { start: "2026-09-08", end: "2026-12-08" };

/**
 * Días sin clase que afectan a todos los cursos.
 * SFU cierra; el programa de ECON 370 confirma el de Acción de Gracias.
 */
export const HOLIDAYS = {
  "2026-10-12": "Acción de Gracias",
  "2026-11-11": "Día del Recuerdo",
};

/** Ventana del examen final que publica el Registrar. La fecha exacta aún no existe. */
export const EXAM_WINDOW = { start: "2026-12-09", end: "2026-12-20" };

/*
 * weekday: 0 domingo … 6 sábado, igual que `Date#getUTCDay`.
 * start/end: "HH:MM" en hora local. `null` = el programa no lo dice todavía.
 * from/until: acotan la recurrencia cuando no empieza en la primera semana.
 * skip: fechas concretas en las que ese encuentro no ocurre.
 * priority: 1 alta, 2 media, 3 baja — la misma escala que usa la app.
 */
export const COURSES = [
  {
    code: "ECON 342",
    name: "International Trade",
    instructor: "Victor Aguiar Lozano",
    email: "vaguiarl@sfu.ca",
    meetings: [
      {
        kind: "clase",
        weekday: 2,
        start: "10:30",
        end: "12:20",
        location: "AQ 3003, Burnaby",
        from: "2026-09-15",
        until: "2026-12-01",
      },
      {
        // "Wednesday; section-specific time and room are listed in goSFU".
        kind: "tutorial",
        weekday: 3,
        start: null,
        end: null,
        location: "ver goSFU",
        // El curso empieza el 15 de septiembre, así que el miércoles anterior
        // no existe como tutorial.
        from: "2026-09-16",
        until: "2026-12-02",
      },
    ],
    deadlines: [
      { date: "2026-10-13", title: "Midterm 1 (25%)", note: "En clase", priority: 1 },
      { date: "2026-11-10", title: "Midterm 2 (25%)", note: "En clase", priority: 1 },
      {
        date: "2026-12-01",
        title: "Presentación del proyecto (15%)",
        note: "En la última clase regular",
        priority: 1,
      },
    ],
  },

  {
    code: "ECON 260",
    name: "Environmental Economics",
    instructor: "Michael Gilraine",
    email: "gilraine@sfu.ca",
    meetings: [
      {
        kind: "clase",
        weekday: 4,
        start: "10:30",
        end: "12:20",
        location: "K9500, East Theatre Annex",
        from: "2026-09-10",
        until: "2026-12-03",
      },
      {
        kind: "tutorial",
        weekday: 2,
        start: "09:30",
        end: "10:20",
        location: "AQ 3153",
        // Semana 1 no tiene tutorial, y por eso empieza en la semana 2.
        from: "2026-09-15",
        until: "2026-12-01",
        // Semana 7 es el repaso del midterm: tampoco hay tutorial.
        skip: ["2026-10-20"],
      },
      {
        kind: "oficina",
        weekday: 1,
        start: "13:30",
        end: "14:30",
        location: "WMC 3639",
        until: "2026-12-07",
      },
    ],
    deadlines: [
      { date: "2026-10-29", title: "Midterm (30%)", note: "En clase, 90 minutos", priority: 1 },
    ],
    // El programa asigna 4 problem sets, una tarea estadística y 4 sesiones de
    // R, pero no les pone fecha: salen en Canvas. No se inventan aquí.
    pending: [
      "4 problem sets (15%, cuentan los 3 mejores) — fechas en Canvas",
      "Tarea estadística (10%) — fecha en Canvas",
      "Participación de R (5%): semanas 3-6, hay que completar 3 de 4",
    ],
  },

  {
    code: "ECON 370",
    name: "Health Economics",
    instructor: "Helen Kissel",
    email: "helen_kissel@sfu.ca",
    meetings: [
      {
        // El programa lista los temas por lunes, pero nunca dice la hora.
        kind: "clase",
        weekday: 1,
        start: null,
        end: null,
        location: null,
        until: "2026-12-07",
      },
      {
        // "Weekly TA tutorials will be held on Mondays" — sin hora ni sala.
        kind: "tutorial",
        weekday: 1,
        start: null,
        end: null,
        location: "por confirmar",
        from: "2026-09-28",
        until: "2026-12-07",
      },
      {
        kind: "oficina",
        weekday: 1,
        start: "14:30",
        end: "16:30",
        location: "WC 2680",
        until: "2026-12-07",
      },
      {
        kind: "oficina",
        weekday: 5,
        start: "10:30",
        end: "12:30",
        location: "TA Eric Chow — sala por confirmar",
        from: "2026-09-18",
        until: "2026-12-04",
      },
    ],
    deadlines: [
      { date: "2026-09-21", title: "Encuesta del syllabus (1%)", note: "No se acepta tarde", priority: 2 },
      { date: "2026-10-26", title: "Midterm (30%)", note: "En clase", priority: 1 },
      { date: "2026-11-02", title: "Encuesta de mitad de semestre (1%)", note: "No se acepta tarde", priority: 2 },
      {
        date: "2026-11-09",
        title: "Propuesta del proyecto (8%)",
        note: "1-2 páginas. No se acepta tarde, y el tema debe coincidir con el final",
        priority: 1,
      },
      {
        date: "2026-12-07",
        title: "Proyecto final (20%)",
        note: "Máximo 8 páginas, con análisis costo/beneficio",
        priority: 1,
      },
    ],
  },
];

/* ------------------------------------------------------------------ fechas */

/** Suma días a "YYYY-MM-DD" en UTC, para no tropezar con el horario de verano. */
export function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const weekdayOf = (ymd) => new Date(`${ymd}T00:00:00Z`).getUTCDay();

/** Minutos al este de UTC para ese instante en esa zona. */
function tzOffsetMinutes(date, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    +parts.year,
    +parts.month - 1,
    +parts.day,
    +parts.hour % 24,
    +parts.minute,
    +parts.second,
  );
  return (asUtc - date.getTime()) / 60000;
}

/**
 * "2026-11-10" + "10:30" en Vancouver → el instante real en ISO.
 *
 * Importa hacerlo bien: el horario de verano termina el 1 de noviembre, así
 * que las clases de septiembre y octubre van en UTC-7 y las de noviembre y
 * diciembre en UTC-8. Fijar un `-07:00` a mano, como hacía el seed viejo,
 * corre una hora todo el último mes del semestre.
 */
export function wallTimeToInstant(ymd, hhmm, tz = TZ) {
  const [h, m] = hhmm.split(":").map(Number);
  const naive = Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10), h, m);
  let ts = naive;
  // Dos pasadas: la primera estima el desfase, la segunda lo corrige si el
  // resultado cayó del otro lado del cambio de hora.
  for (let i = 0; i < 2; i++) ts = naive - tzOffsetMinutes(new Date(ts), tz) * 60000;
  return new Date(ts).toISOString();
}

/* -------------------------------------------------------------- expansión */

/**
 * Convierte los encuentros semanales en fechas concretas del término.
 *
 * Se expande en vez de emitir `RRULE` porque así se pueden saltar los feriados
 * y las semanas sin tutorial, que es justo donde una regla de recurrencia
 * mentiría.
 */
export function meetingDates(course, meeting) {
  const desde = meeting.from && meeting.from > TERM.start ? meeting.from : TERM.start;
  const hasta = meeting.until && meeting.until < TERM.end ? meeting.until : TERM.end;
  const saltar = new Set(meeting.skip ?? []);
  const dates = [];
  for (let day = desde; day <= hasta; day = addDays(day, 1)) {
    if (weekdayOf(day) !== meeting.weekday) continue;
    if (HOLIDAYS[day] || saltar.has(day)) continue;
    dates.push(day);
  }
  return dates;
}

/** Título legible de un encuentro: "ECON 260 · tutorial". */
export function meetingTitle(course, meeting) {
  return meeting.kind === "clase"
    ? course.code
    : `${course.code} · ${meeting.kind === "oficina" ? "oficina" : "tutorial"}`;
}

/** Los encuentros a los que todavía les falta la hora. */
export function missingTimes() {
  const out = [];
  for (const course of COURSES) {
    for (const m of course.meetings) {
      if (m.start == null) out.push({ course: course.code, kind: m.kind, weekday: m.weekday });
    }
  }
  return out;
}
