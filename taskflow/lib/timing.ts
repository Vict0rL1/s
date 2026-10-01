import type { Task, TaskKind } from "./types";

/**
 * El cronómetro de las tareas, en puro: cuánto lleva y qué dicen los números.
 */

/**
 * Una sesión cuenta como mucho esto. Un cronómetro que se quedó corriendo toda
 * la noche no es trabajo: sin el tope, una sola tarea olvidada arruinaba las
 * estadísticas para siempre.
 */
export const MAX_SESSION_SEC = 6 * 3600;

/** Segundos de la sesión en marcha, con el tope. */
export function elapsedSec(startedAt: string, now: number): { sec: number; capped: boolean } {
  const t = Date.parse(startedAt);
  if (!Number.isFinite(t)) return { sec: 0, capped: false };
  const sec = Math.max(0, Math.round((now - t) / 1000));
  return sec > MAX_SESSION_SEC ? { sec: MAX_SESSION_SEC, capped: true } : { sec, capped: false };
}

/** Lo medido más lo que va de la sesión actual. */
export function trackedTotal(t: Pick<Task, "tracked_sec" | "track_started_at">, now: number): number {
  return t.tracked_sec + (t.track_started_at ? elapsedSec(t.track_started_at, now).sec : 0);
}

/** "1:05:09" o "12:30". */
export function fmtClockSec(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/* -------------------------------------------------------------- números */

/** Menos que esto medido no cuenta como muestra: fue un clic sin querer. */
const MIN_SAMPLE_SEC = 5 * 60;
const MIN_SAMPLES = 3;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export type EstimateStats = {
  samples: number;
  /** Minutos: lo que sueles estimar y lo que sueles tardar (medianas). */
  est: number;
  real: number;
  byKind: { kind: TaskKind; samples: number; est: number; real: number }[];
};

/**
 * Estimado frente a real, sobre las tareas terminadas que tienen las dos
 * cosas. Medianas, no promedios: una tarea que se fue de las manos no debe
 * torcer el "sueles". Con menos de 3 muestras no se dice nada.
 */
export function estimateStats(tasks: Task[]): EstimateStats | null {
  const muestras = tasks.filter((t) => t.done && t.est_minutes && t.tracked_sec >= MIN_SAMPLE_SEC);
  if (muestras.length < MIN_SAMPLES) return null;

  const porTipo = new Map<TaskKind, Task[]>();
  for (const t of muestras) if (t.kind) porTipo.set(t.kind, [...(porTipo.get(t.kind) ?? []), t]);

  return {
    samples: muestras.length,
    est: Math.round(median(muestras.map((t) => t.est_minutes!))),
    real: Math.round(median(muestras.map((t) => t.tracked_sec / 60))),
    byKind: [...porTipo]
      .filter(([, ts]) => ts.length >= MIN_SAMPLES)
      .map(([kind, ts]) => ({
        kind,
        samples: ts.length,
        est: Math.round(median(ts.map((t) => t.est_minutes!))),
        real: Math.round(median(ts.map((t) => t.tracked_sec / 60))),
      })),
  };
}

/** "Sueles estimar 60 min y tardar 82 min (37% más)." */
export function statsLine(s: { est: number; real: number }): string {
  const diff = s.est ? Math.round(((s.real - s.est) / s.est) * 100) : 0;
  const cola = Math.abs(diff) < 10 ? "bastante cerca" : diff > 0 ? `${diff}% más` : `${-diff}% menos`;
  return `Sueles estimar ${s.est} min y tardar ${s.real} min (${cola}).`;
}
