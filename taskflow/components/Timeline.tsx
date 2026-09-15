import { deleteBlock } from "@/app/actions";
import { minsToHHMM, pad } from "@/lib/date";
import type { Block, DayEvent } from "@/lib/types";
import { NowLine } from "./NowLine";

/** Altura de una hora en píxeles. Tiene que coincidir con `.tlrow` en el CSS. */
const HOUR = 44;

type Placed = {
  key: string;
  start: number;
  end: number;
  top: number;
  height: number;
  cls: string;
  label: string;
  sub: string;
  blockId?: string;
};

function place(
  start: number,
  end: number,
  dayStart: number,
  dayEnd: number,
  rest: Omit<Placed, "top" | "height" | "start" | "end">,
): Placed | null {
  if (end <= dayStart * 60 || start >= dayEnd * 60) return null;
  return {
    ...rest,
    start,
    end,
    top: ((start - dayStart * 60) / 60) * HOUR + 4,
    height: Math.max(20, ((end - start) / 60) * HOUR - 3),
  };
}

export function Timeline({
  events,
  blocks,
  dayStart,
  dayEnd,
  tz,
}: {
  events: DayEvent[];
  blocks: Block[];
  dayStart: number;
  dayEnd: number;
  tz: string;
}) {
  const placed: Placed[] = [];

  for (const e of events) {
    if (e.start == null) continue;
    const p = place(e.start, e.end ?? e.start + 60, dayStart, dayEnd, {
      key: "e" + e.id,
      cls: "bk-ev",
      label: e.title,
      sub: e.courseRef ?? "",
    });
    if (p) placed.push(p);
  }

  for (const b of blocks) {
    const p = place(b.start_min, b.end_min, dayStart, dayEnd, {
      key: "b" + b.id,
      cls: b.kind === "descanso" ? "bk-rest" : "bk-task",
      label: b.title,
      sub: "",
      blockId: b.id,
    });
    if (p) placed.push(p);
  }

  const rows = [];
  for (let h = dayStart; h < dayEnd; h++) {
    rows.push(
      <div className="tlrow" key={h}>
        <span>{pad(h)}:00</span>
      </div>,
    );
  }

  return (
    <div className="tl">
      {rows}

      {placed.map((p) => (
        <div
          key={p.key}
          className={"blk " + p.cls}
          style={{ top: p.top + "px", height: p.height + "px" }}
        >
          {p.blockId ? (
            <form action={deleteBlock} className="inline">
              <input type="hidden" name="id" value={p.blockId} />
              <button type="submit" className="x" aria-label="Quitar bloque">
                ×
              </button>
            </form>
          ) : null}
          <b>{p.label}</b>
          <i>
            {minsToHHMM(p.start)}–{minsToHHMM(p.end)}
            {p.sub ? " · " + p.sub : ""}
          </i>
        </div>
      ))}

      <NowLine tz={tz} dayStart={dayStart} dayEnd={dayEnd} hour={HOUR} />
    </div>
  );
}
