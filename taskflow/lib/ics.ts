/**
 * Importador de `.ics` — portado de `parseICS` en `reference/cumbre.html`.
 *
 * Es el respaldo de las fases 2 y 3: cuando Canvas o Google fallen, bajas el
 * archivo y lo subes a mano. Desde la fase 3, Google Calendar expande los
 * eventos recurrentes por su cuenta (`singleEvents=true`) y el expansor de
 * `RRULE` de aquí deja de usarse para esa fuente.
 *
 * Cambios respecto al original:
 *  - Devuelve instantes absolutos (ISO) en vez de "día local + minuto", porque
 *    `events.starts_at` es `timestamptz`. Una hora sin `TZID` ni `Z` se
 *    interpreta en la zona del usuario, no en la del servidor.
 *  - Genera un `external_id` estable a partir del UID del VEVENT, para que
 *    reimportar el mismo archivo no duplique filas.
 */

import { addDays, daysBetween, makeYmd, wallTimeToInstant, weekdayOf } from "./date";

export type IcsEvent = {
  title: string;
  /** Evento con hora. Excluyente con `allDayDate`. */
  startsAt: string | null;
  endsAt: string | null;
  /** Evento de día completo, "YYYY-MM-DD". Excluyente con `startsAt`. */
  allDayDate: string | null;
  externalId: string;
};

export type IcsOptions = {
  /** Nombre de la fuente ("Canvas SFU"). Entra en el `external_id`. */
  source: string;
  /** "YYYY-MM-DD" en la zona del usuario — centro de la ventana de importación. */
  today: string;
  timeZone: string;
  /** Días hacia atrás y hacia adelante que se importan. */
  daysBack?: number;
  daysAhead?: number;
};

function icsUnescape(v: string): string {
  return String(v)
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\;/g, ";")
    .replace(/\\\\/g, "\\");
}

/** Identificador corto y estable para cuando el VEVENT no trae UID. */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

type DT =
  | { kind: "date"; date: string }
  | { kind: "time"; date: string; instant: number };

/** DTSTART/DTEND/EXDATE -> día completo o instante absoluto. */
export function parseDT(val: string, params: Record<string, string>, timeZone: string): DT | null {
  const v = String(val).trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;

  const Y = +m[1], Mo = +m[2], D = +m[3];
  const date = makeYmd(Y, Mo, D);
  if (!date) return null;

  if (!m[4] || params.VALUE === "DATE") return { kind: "date", date };

  const H = +m[4], Mi = +m[5];
  let instant: number;
  if (m[7]) instant = Date.UTC(Y, Mo - 1, D, H, Mi);
  else if (params.TZID) instant = wallTimeToInstant(Y, Mo, D, H, Mi, params.TZID);
  // Hora "flotante": sin zona. El original usaba la del navegador; aquí la del
  // usuario, que es la misma que ve en pantalla.
  else instant = wallTimeToInstant(Y, Mo, D, H, Mi, timeZone);

  return { kind: "time", date, instant };
}

const BYDAY: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/** Expande un RRULE dentro de [winA, winB]. Devuelve días "YYYY-MM-DD". */
export function expandRRule(rule: string, first: string, winA: string, winB: string): string[] {
  const p: Record<string, string> = {};
  for (const kv of String(rule).split(";")) {
    const i = kv.indexOf("=");
    if (i > 0) p[kv.slice(0, i).toUpperCase()] = kv.slice(i + 1);
  }

  const freq = (p.FREQ || "").toUpperCase();
  const step = Math.max(1, parseInt(p.INTERVAL || "1", 10));
  const count = p.COUNT ? parseInt(p.COUNT, 10) : 0;
  const untilM = p.UNTIL ? String(p.UNTIL).match(/^(\d{4})(\d{2})(\d{2})/) : null;
  const until = untilM ? makeYmd(+untilM[1], +untilM[2], +untilM[3]) : null;
  const byday = p.BYDAY
    ? p.BYDAY.split(",")
        .map((x) => BYDAY[x.replace(/^[-+]?\d+/, "").toUpperCase()])
        .filter((x) => x != null)
    : null;

  if (!freq) return [first];

  const out: string[] = [];
  let cur = first, n = 0, guard = 0;

  while (guard++ < 800 && out.length < 400) {
    let cands: string[];
    if (freq === "WEEKLY" && byday && byday.length) {
      const monday = addDays(cur, -((weekdayOf(cur) + 6) % 7));
      cands = byday.map((w) => addDays(monday, (w + 6) % 7));
    } else {
      cands = [cur];
    }

    let stop = false;
    for (const c of cands) {
      if (c < first) continue;
      if (until && c > until) { stop = true; break; }
      n++;
      if (count && n > count) { stop = true; break; }
      if (c >= winA && c <= winB) out.push(c);
    }
    if (stop || cur > winB) break;

    if (freq === "DAILY") cur = addDays(cur, step);
    else if (freq === "WEEKLY") cur = addDays(cur, 7 * step);
    else if (freq === "MONTHLY") cur = addMonths(cur, step);
    else if (freq === "YEARLY") cur = addMonths(cur, 12 * step);
    else break;
  }

  return out.length ? out : [first];
}

/** Suma meses conservando el día; si el día no existe, cae al último del mes. */
function addMonths(ymd: string, n: number): string {
  const y = +ymd.slice(0, 4), mo = +ymd.slice(5, 7), d = +ymd.slice(8, 10);
  const total = (y * 12 + (mo - 1)) + n;
  const ny = Math.floor(total / 12), nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return makeYmd(ny, nm, Math.min(d, last))!;
}

export function parseICS(text: string, opts: IcsOptions): IcsEvent[] {
  const { source, timeZone, today } = opts;
  const winA = addDays(today, -(opts.daysBack ?? 45));
  const winB = addDays(today, opts.daysAhead ?? 210);

  // Desdobla las líneas partidas (RFC 5545: continuación = salto + espacio).
  const lines = String(text).replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");

  const out: IcsEvent[] = [];
  const seen = new Set<string>();
  type Cur = { ex: string[]; sum?: string; uid?: string; s?: DT; e?: DT; rrule?: string };
  let cur: Cur | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (/^BEGIN:VEVENT/i.test(line)) { cur = { ex: [] }; continue; }

    if (/^END:VEVENT/i.test(line)) {
      if (cur && cur.s) {
        const start = cur.s;
        const dates = cur.rrule ? expandRRule(cur.rrule, start.date, winA, winB) : [start.date];
        const uid = cur.uid || hash((cur.sum || "") + "|" + start.date);
        const title = cur.sum || "(sin título)";

        // Duración en minutos, para trasladarla a cada repetición.
        const durMin =
          start.kind === "time" && cur.e && cur.e.kind === "time"
            ? Math.max(15, Math.round((cur.e.instant - start.instant) / 60000))
            : 60;

        for (const day of dates) {
          if (cur.ex.includes(day)) continue;
          if (day < winA || day > winB) continue;

          const externalId = `ics:${source}:${uid}` + (cur.rrule ? `:${day}` : "");
          if (seen.has(externalId)) continue;
          seen.add(externalId);

          if (start.kind === "date") {
            out.push({ title, startsAt: null, endsAt: null, allDayDate: day, externalId });
          } else {
            // Desplaza el instante original tantos días como diga la repetición.
            const shift = daysBetween(start.date, day) * 86400000;
            const s = start.instant + shift;
            out.push({
              title,
              startsAt: new Date(s).toISOString(),
              endsAt: new Date(s + durMin * 60000).toISOString(),
              allDayDate: null,
              externalId,
            });
          }
        }
      }
      cur = null;
      continue;
    }

    if (!cur) continue;

    const i = line.indexOf(":");
    if (i < 0) continue;
    const left = line.slice(0, i), val = line.slice(i + 1);
    const parts = left.split(";");
    const name = parts[0].toUpperCase();
    const params: Record<string, string> = {};
    for (const x of parts.slice(1)) {
      const j = x.indexOf("=");
      if (j > 0) params[x.slice(0, j).toUpperCase()] = x.slice(j + 1).replace(/^"|"$/g, "");
    }

    if (name === "SUMMARY") cur.sum = icsUnescape(val);
    else if (name === "UID") cur.uid = val.trim().slice(0, 120);
    else if (name === "DTSTART") cur.s = parseDT(val, params, timeZone) ?? undefined;
    else if (name === "DTEND") cur.e = parseDT(val, params, timeZone) ?? undefined;
    else if (name === "RRULE") cur.rrule = val;
    else if (name === "EXDATE") {
      for (const v of val.split(",")) {
        const d = parseDT(v, params, timeZone);
        if (d) cur.ex.push(d.date);
      }
    }
  }

  return out;
}

/** "Canvas SFU" -> etiqueta corta y limpia para guardar en `events.course_ref`. */
export function cleanSourceName(name: string): string {
  return (name || "Calendario").trim().replace(/[:|]/g, "-").slice(0, 40) || "Calendario";
}
