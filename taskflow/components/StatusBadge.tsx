import type { Level } from "@/lib/health";

const TEXT: Record<Level, string> = { ok: "Al día", warn: "Revisar", error: "Falla", off: "Apagado" };

/** El estado con palabra, no sólo con color: así se lee igual sin distinguir colores. */
export function StatusBadge({ level }: { level: Level }) {
  return (
    <span className={"lvl " + level}>
      <i aria-hidden="true" />
      {TEXT[level]}
    </span>
  );
}
