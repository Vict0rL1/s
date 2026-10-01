"use client";

import { useEffect, useState } from "react";
import { minutesInTz } from "@/lib/date";

/**
 * La rayita de "ahora" en la agenda.
 *
 * Es cliente y se recalcula cada minuto porque el servidor sólo sabe la hora
 * del momento en que renderizó. Usa la zona del perfil, no la del dispositivo:
 * si abres la app desde otro huso, la agenda sigue siendo la de Vancouver.
 */
export function NowLine({
  tz,
  dayStart,
  dayEnd,
  hour,
}: {
  tz: string;
  dayStart: number;
  dayEnd: number;
  hour: number;
}) {
  const [min, setMin] = useState<number | null>(null);

  useEffect(() => {
    const tick = () => setMin(minutesInTz(tz));
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, [tz]);

  if (min == null || min < dayStart * 60 || min > dayEnd * 60) return null;

  return <div className="tlnow" style={{ top: ((min - dayStart * 60) / 60) * hour + 4 + "px" }} />;
}
