"use client";

import { useActionState } from "react";
import { importIcs, saveAreas, saveHours, saveTimezone } from "@/app/actions";
import { pad } from "@/lib/date";
import { Toast } from "./Toast";

export function ImportIcs() {
  const [state, formAction, pending] = useActionState(importIcs, null);

  return (
    <>
      <form action={formAction}>
        <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--ink-2)" }}>
          Canvas y Google Calendar exportan el mismo formato <b>.ics</b>. Descarga el archivo y
          súbelo aquí — sirve de respaldo mientras las integraciones automáticas no estén listas.
        </p>

        <div className="field">
          <label htmlFor="srcName">Nombre de la fuente</label>
          <input type="text" id="srcName" name="name" placeholder="Canvas SFU" />
          <span className="fh">Reimportar con el mismo nombre reemplaza los eventos anteriores.</span>
        </div>

        <div className="field">
          <label htmlFor="icsFile">Archivo .ics</label>
          <input type="file" id="icsFile" name="file" accept=".ics,text/calendar" />
        </div>

        <div className="field">
          <label htmlFor="icsText">…o pega el contenido</label>
          <textarea id="icsText" name="text" placeholder="BEGIN:VCALENDAR…" />
        </div>

        <button className="btn" type="submit" disabled={pending}>
          {pending ? "Importando…" : "Importar eventos"}
        </button>
      </form>
      <Toast result={state} />
    </>
  );
}

export function AreasForm({ areas }: { areas: string[] }) {
  const [state, formAction, pending] = useActionState(saveAreas, null);

  return (
    <>
      <form action={formAction}>
        <div className="field">
          <label htmlFor="areasIn">Etiquetas para clasificar tareas</label>
          <input type="text" id="areasIn" name="areas" defaultValue={areas.join(", ")} />
          <span className="fh">
            Sepáralas con coma. Se usan con <b>#</b> en la captura rápida.
          </span>
        </div>
        <button className="btn line sm" type="submit" disabled={pending}>
          Guardar áreas
        </button>
      </form>
      <Toast result={state} />
    </>
  );
}

function hourOptions() {
  const out = [];
  for (let h = 0; h <= 24; h++) out.push(<option value={h} key={h}>{pad(h)}:00</option>);
  return out;
}

export function HoursForm({ dayStart, dayEnd }: { dayStart: number; dayEnd: number }) {
  const [state, formAction, pending] = useActionState(saveHours, null);

  return (
    <>
      <form action={formAction}>
        <div className="row">
          <div className="field" style={{ flex: 1, margin: 0 }}>
            <label htmlFor="dayStart">Desde</label>
            <select id="dayStart" name="day_start" defaultValue={dayStart}>
              {hourOptions()}
            </select>
          </div>
          <div className="field" style={{ flex: 1, margin: 0 }}>
            <label htmlFor="dayEnd">Hasta</label>
            <select id="dayEnd" name="day_end" defaultValue={dayEnd}>
              {hourOptions()}
            </select>
          </div>
        </div>
        <button className="btn line sm" type="submit" disabled={pending} style={{ marginTop: 12 }}>
          Guardar horario
        </button>
      </form>
      <Toast result={state} />
    </>
  );
}

export function TimezoneForm({ timezone }: { timezone: string }) {
  const [state, formAction, pending] = useActionState(saveTimezone, null);

  return (
    <>
      <form action={formAction}>
        <div className="field">
          <label htmlFor="tzIn">Zona horaria</label>
          <input type="text" id="tzIn" name="timezone" defaultValue={timezone} />
          <span className="fh">
            Todo lo que ves se convierte a esta zona, no a la del servidor. Ej.{" "}
            <b>America/Vancouver</b>.
          </span>
        </div>
        <button className="btn line sm" type="submit" disabled={pending}>
          Guardar zona
        </button>
      </form>
      <Toast result={state} />
    </>
  );
}
