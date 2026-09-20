import { describe, expect, it } from "vitest";
import {
  type CanvasCourse,
  type CanvasPlannerItem,
  type MapOptions,
  insertRow,
  mapPlannerItems,
  nextPageUrl,
  planSync,
  updatePatch,
} from "../lib/canvas";

const USER = "11111111-1111-4111-8111-111111111111";
const TZ = "America/Vancouver";

const AREAS = ["SFU", "FINSA", "Badminton", "Proyectos", "Personal"];
const OPTS: MapOptions = { areas: AREAS, timeZone: TZ, baseUrl: "https://canvas.sfu.ca/api/v1" };

const COURSES: CanvasCourse[] = [
  { id: 101, name: "ECON 103 D100", course_code: "ECON103" },
  { id: 202, name: "CMPT 225 D200", course_code: "CMPT225" },
];

/** Respuesta de `/planner/items` recortada a lo que el mapeo mira. */
const ITEMS: CanvasPlannerItem[] = [
  {
    course_id: 101,
    plannable_id: 5001,
    plannable_type: "assignment",
    // Las 23:59 del 18 en Vancouver son las 06:59 UTC del 19.
    plannable_date: "2026-09-19T06:59:00Z",
    plannable: { title: "Problem Set 4" },
    submissions: { submitted: false },
    html_url: "/courses/101/assignments/5001",
  },
  {
    course_id: 202,
    plannable_id: 5002,
    plannable_type: "quiz",
    plannable_date: "2026-09-22T17:00:00Z",
    plannable: { title: "Quiz 2" },
    submissions: { submitted: false },
    html_url: "/courses/202/quizzes/5002",
  },
  {
    course_id: 202,
    plannable_id: 5003,
    plannable_type: "discussion_topic",
    plannable_date: "2026-09-25T06:59:00Z",
    plannable: { title: "Semana 3 — discusión" },
    submissions: false, // Canvas manda `false` cuando no aplica
    html_url: "/courses/202/discussion_topics/5003",
  },
  {
    // Ya entregado: no es pendiente.
    course_id: 101,
    plannable_id: 5004,
    plannable_type: "assignment",
    plannable_date: "2026-09-10T06:59:00Z",
    plannable: { title: "Problem Set 3" },
    submissions: { submitted: true },
    html_url: "/courses/101/assignments/5004",
  },
  {
    // Tipo que no es un deadline.
    course_id: 101,
    plannable_id: 5005,
    plannable_type: "announcement",
    plannable_date: "2026-09-16T17:00:00Z",
    plannable: { title: "Aviso de clase" },
    html_url: "/courses/101/announcements/5005",
  },
  {
    // Segunda entrada del planner para un plannable que ya vino arriba.
    course_id: 101,
    plannable_id: 5001,
    plannable_type: "assignment",
    plannable_date: "2026-09-19T06:59:00Z",
    plannable: { title: "Problem Set 4" },
    submissions: { submitted: false },
    html_url: "/courses/101/assignments/5001",
  },
];

/* --------------------------------------------------- tabla `tasks` de mentira */

type Row = {
  user_id: string;
  external_id: string;
  source: string;
  title: string;
  area: string | null;
  due_date: string | null;
  due_time: string | null;
  body: string | null;
  external_url: string | null;
  done: boolean;
  priority: number;
  est_minutes: number | null;
  user_edited_at: string | null;
};

/**
 * Corre el sync contra una tabla en memoria, usando las mismas funciones que
 * usa el route handler. Lo único que no pasa por aquí es la red.
 */
function runSync(table: Map<string, Row>, items: CanvasPlannerItem[] = ITEMS) {
  const incoming = mapPlannerItems(items, COURSES, OPTS);
  const existing = [...table.values()].map((r) => ({
    external_id: r.external_id,
    user_edited_at: r.user_edited_at,
  }));
  const plan = planSync(incoming, existing);

  for (const task of plan.insert) {
    const row = insertRow(task, USER);
    // Los defaults del esquema.
    table.set(row.external_id, {
      ...row,
      done: false,
      priority: 3,
      est_minutes: null,
      user_edited_at: null,
    });
  }
  for (const task of plan.updateAll) {
    Object.assign(table.get(task.externalId)!, updatePatch(task, false));
  }
  for (const task of plan.updateSafe) {
    Object.assign(table.get(task.externalId)!, updatePatch(task, true));
  }

  return plan;
}

const snapshot = (table: Map<string, Row>) =>
  [...table.values()].sort((a, b) => a.external_id.localeCompare(b.external_id));

describe("sync de Canvas", () => {
  // El caso que pide CLAUDE.md.
  it("correr el sync dos veces sobre la misma respuesta deja exactamente las mismas filas", () => {
    const table = new Map<string, Row>();

    const first = runSync(table);
    const afterFirst = snapshot(table);

    const second = runSync(table);
    const afterSecond = snapshot(table);

    expect(afterSecond).toEqual(afterFirst);
    expect(table.size).toBe(3); // los 3 pendientes, sin duplicados

    expect(first.insert).toHaveLength(3);
    expect(second.insert).toHaveLength(0); // la segunda vez no hay nada nuevo
    expect(second.updateAll).toHaveLength(3);
  });

  // El "listo cuando" de PLAN.md.
  it("borrar un deadline y volver a sincronizar lo trae igual, sin duplicar", () => {
    const table = new Map<string, Row>();
    runSync(table);
    const before = snapshot(table);

    table.delete("canvas:assignment:5001");
    expect(table.size).toBe(2);

    runSync(table);
    expect(snapshot(table)).toEqual(before);
  });

  it("filtra por tipo, ignora lo ya entregado y colapsa entradas repetidas", () => {
    const rows = mapPlannerItems(ITEMS, COURSES, OPTS);
    expect(rows.map((r) => r.externalId)).toEqual([
      "canvas:assignment:5001",
      "canvas:discussion_topic:5003",
      "canvas:quiz:5002",
    ]);
  });

  it("convierte la fecha a la zona del perfil, no a la del servidor", () => {
    const [ps4] = mapPlannerItems(ITEMS, COURSES, OPTS);
    // 2026-09-19T06:59Z son las 23:59 del 18 en Vancouver.
    expect(ps4.dueDate).toBe("2026-09-18");
    expect(ps4.dueTime).toBe("23:59:00");
  });

  it("clasifica en un área del perfil y guarda el curso en el cuerpo", () => {
    const rows = mapPlannerItems(ITEMS, COURSES, OPTS);
    expect(rows.every((r) => r.area === "SFU")).toBe(true);
    expect(rows.find((r) => r.externalId === "canvas:quiz:5002")?.body).toBe("CMPT 225 D200");
  });

  it("cruza los cursos aunque Canvas mande los IDs como texto", () => {
    // Con el header `json+canvas-string-ids` los IDs llegan así.
    const stringCourses = COURSES.map((c) => ({ ...c, id: String(c.id) }));
    const stringItems = ITEMS.map((i) => ({
      ...i,
      course_id: i.course_id == null ? i.course_id : String(i.course_id),
    }));

    const rows = mapPlannerItems(stringItems, stringCourses, OPTS);
    expect(rows.find((r) => r.externalId === "canvas:quiz:5002")?.body).toBe("CMPT 225 D200");
    // Y da exactamente lo mismo que con IDs numéricos.
    expect(rows).toEqual(mapPlannerItems(ITEMS, COURSES, OPTS));
  });

  it("vuelve absolutos los html_url relativos", () => {
    const [ps4] = mapPlannerItems(ITEMS, COURSES, OPTS);
    expect(ps4.externalUrl).toBe("https://canvas.sfu.ca/courses/101/assignments/5001");
  });
});

describe("la regla dura: el sync no pisa una edición manual", () => {
  it("una fila tocada a mano conserva done, priority, area y est_minutes", () => {
    const table = new Map<string, Row>();
    runSync(table);

    // Victor la marca hecha, le sube la prioridad, la mueve de área y la estima.
    const row = table.get("canvas:assignment:5001")!;
    Object.assign(row, {
      done: true,
      priority: 1,
      area: "Proyectos",
      est_minutes: 90,
      user_edited_at: "2026-09-16T10:00:00Z",
    });

    // Y en Canvas le cambian el título y le mueven la fecha.
    const moved: CanvasPlannerItem[] = ITEMS.map((i) =>
      i.plannable_id === 5001 && i.plannable_type === "assignment"
        ? { ...i, plannable: { title: "Problem Set 4 (v2)" }, plannable_date: "2026-09-26T06:59:00Z" }
        : i,
    );
    const plan = runSync(table, moved);

    expect(plan.updateSafe.map((t) => t.externalId)).toEqual(["canvas:assignment:5001"]);

    const after = table.get("canvas:assignment:5001")!;
    // Lo que el sync sí puede refrescar:
    expect(after.title).toBe("Problem Set 4 (v2)");
    expect(after.due_date).toBe("2026-09-25");
    // Lo que no toca jamás:
    expect(after.done).toBe(true);
    expect(after.priority).toBe(1);
    expect(after.area).toBe("Proyectos");
    expect(after.est_minutes).toBe(90);
  });

  it("una fila que nadie tocó sí se refresca entera", () => {
    const table = new Map<string, Row>();
    runSync(table);

    const renamed: CanvasPlannerItem[] = ITEMS.map((i) =>
      i.plannable_id === 5002 ? { ...i, plannable: { title: "Quiz 2 (reprogramado)" } } : i,
    );
    const plan = runSync(table, renamed);

    expect(plan.updateSafe).toHaveLength(0);
    expect(table.get("canvas:quiz:5002")!.title).toBe("Quiz 2 (reprogramado)");
  });

  it("el sync nunca escribe done ni priority", () => {
    const keys = new Set([
      ...Object.keys(insertRow(mapPlannerItems(ITEMS, COURSES, OPTS)[0], USER)),
      ...Object.keys(updatePatch(mapPlannerItems(ITEMS, COURSES, OPTS)[0], false)),
    ]);
    expect(keys.has("done")).toBe(false);
    expect(keys.has("priority")).toBe(false);
    expect(keys.has("est_minutes")).toBe(false);
    expect(keys.has("user_edited_at")).toBe(false);
  });
});

describe("paginación", () => {
  it("sigue el rel=next del header Link", () => {
    const header =
      '<https://canvas.sfu.ca/api/v1/planner/items?page=1>; rel="current",' +
      '<https://canvas.sfu.ca/api/v1/planner/items?page=2>; rel="next",' +
      '<https://canvas.sfu.ca/api/v1/planner/items?page=9>; rel="last"';
    expect(nextPageUrl(header)).toBe("https://canvas.sfu.ca/api/v1/planner/items?page=2");
  });

  it("devuelve null en la última página", () => {
    expect(nextPageUrl('<https://canvas.sfu.ca/api/v1/planner/items?page=9>; rel="last"')).toBe(null);
    expect(nextPageUrl(null)).toBe(null);
    expect(nextPageUrl("")).toBe(null);
  });
});
