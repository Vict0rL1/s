import { describe, expect, it } from "vitest";
import { parseInput, nextWeekday } from "../lib/parse";
import { weekdayOf } from "../lib/date";

const AREAS = ["SFU", "FINSA", "Badminton", "Proyectos", "Personal"];

// Martes. Fijo, para que los "próximo viernes" del test no dependan del día
// en que se corra la suite.
const MARTES = "2026-09-15";

const parse = (raw: string, today = MARTES) => parseInput(raw, { areas: AREAS, today });

describe("parseInput", () => {
  // El caso que pide CLAUDE.md.
  it("saca área, próximo viernes, hora y duración de una captura completa", () => {
    expect(weekdayOf(MARTES)).toBe(2); // el ancla es martes

    const p = parse("Problem set 4 #SFU vie 3pm 90m");

    expect(p.title).toBe("Problem set 4");
    expect(p.area).toBe("SFU");
    expect(p.due).toBe("2026-09-18"); // el viernes siguiente
    expect(weekdayOf(p.due!)).toBe(5);
    expect(p.start).toBe(15 * 60);
    expect(p.dur).toBe(90);
  });

  it("resuelve el área por prefijo, sin acentos y sin importar mayúsculas", () => {
    expect(parse("Entrenar #badmin").area).toBe("Badminton");
    expect(parse("Repasar #sfu").area).toBe("SFU");
    expect(parse("Correo @personal").area).toBe("Personal");
  });

  it("deja el área tal cual si no coincide con ninguna del perfil", () => {
    expect(parse("Llamar al banco #tramites").area).toBe("tramites");
  });

  it("lee la prioridad en palabra o en número", () => {
    expect(parse("Cerrar informe !alta").prio).toBe(1);
    expect(parse("Cerrar informe !2").prio).toBe(2);
    expect(parse("Cerrar informe !baja").prio).toBe(3);
    expect(parse("Cerrar informe").prio).toBe(0);
  });

  it("entiende duraciones en horas y en minutos", () => {
    expect(parse("Estudiar 2h").dur).toBe(120);
    expect(parse("Estudiar 1.5h").dur).toBe(90);
    expect(parse("Estudiar 1,5 horas").dur).toBe(90);
    expect(parse("Estudiar 45 min").dur).toBe(45);
  });

  it("entiende horas en 12 y en 24", () => {
    expect(parse("Clase 9am").start).toBe(9 * 60);
    expect(parse("Clase 12pm").start).toBe(12 * 60);
    expect(parse("Clase 12am").start).toBe(0);
    expect(parse("Clase 7:30pm").start).toBe(19 * 60 + 30);
    expect(parse("Clase 15:45").start).toBe(15 * 60 + 45);
  });

  it("entiende fechas relativas en español", () => {
    expect(parse("Comprar café hoy").due).toBe(MARTES);
    expect(parse("Comprar café mañana").due).toBe("2026-09-16");
    expect(parse("Comprar café manana").due).toBe("2026-09-16");
    expect(parse("Comprar café pasado").due).toBe("2026-09-17");
  });

  it("entiende fechas con mes y en dd/mm", () => {
    expect(parse("Renovar visa 22 oct").due).toBe("2026-10-22");
    expect(parse("Renovar visa 22 de octubre").due).toBe("2026-10-22");
    expect(parse("Renovar visa 3/10").due).toBe("2026-10-03");
  });

  it("manda al año siguiente una fecha que ya pasó", () => {
    expect(parse("Cumpleaños 2 feb").due).toBe("2027-02-02");
  });

  it("un día de la semana que es hoy significa el de la semana que viene", () => {
    expect(parse("Junta martes").due).toBe("2026-09-22");
    expect(nextWeekday(2, MARTES)).toBe("2026-09-22");
  });

  it("ignora una fecha que no existe en vez de correrla al mes siguiente", () => {
    const p = parse("Entregar 31 feb");
    expect(p.due).toBe(null);
    expect(p.title).toBe("Entregar 31 feb");
  });

  it("deja de título sólo lo que no consumió", () => {
    const p = parse("  Leer   cap 4   #SFU  !alta   vie  45m  ");
    expect(p.title).toBe("Leer cap 4");
    expect(p.area).toBe("SFU");
    expect(p.prio).toBe(1);
    expect(p.due).toBe("2026-09-18");
    expect(p.dur).toBe(45);
  });

  it("no inventa nada cuando la captura es sólo texto", () => {
    expect(parse("Pensar en el proyecto")).toEqual({
      title: "Pensar en el proyecto",
      area: "",
      due: null,
      start: null,
      dur: 0,
      prio: 0,
    });
  });
});
