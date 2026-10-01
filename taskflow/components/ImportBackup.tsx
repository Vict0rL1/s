"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";

type Count = { total: number; new: number; duplicates: number; invalid: number };
type Summary = {
  version: 1 | 2;
  exportedAt: string | null;
  tasks: Count; notes: Count; habits: Count; habit_log: Count; events: Count; blocks: Count;
};

const FILAS: [keyof Omit<Summary, "version" | "exportedAt">, string][] = [
  ["tasks", "Tareas"],
  ["notes", "Notas"],
  ["habits", "Rutinas"],
  ["habit_log", "Marcas de rutinas"],
  ["events", "Eventos"],
  ["blocks", "Bloques"],
];

/**
 * Importar un respaldo, en dos pasos: primero el resumen (qué es nuevo, qué ya
 * tienes, qué no se pudo leer), después la confirmación. Sólo agrega: nunca
 * cambia ni borra lo que ya está.
 */
export function ImportBackup() {
  const id = useId();
  const router = useRouter();
  const [backup, setBackup] = useState<unknown>(null);
  const [nombre, setNombre] = useState("");
  const [resumen, setResumen] = useState<Summary | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);

  async function enviar(mode: "preview" | "apply", data: unknown) {
    setOcupado(true);
    setMsg(null);
    try {
      const r = await fetch("/api/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode, backup: data }),
      });
      const json = await r.json();
      if (!json.ok) {
        setMsg({ ok: false, text: json.message || "No se pudo leer el respaldo" });
        setResumen(null);
        return;
      }
      setResumen(json.summary);
      if (json.applied) {
        const s: Summary = json.summary;
        const n = FILAS.reduce((a, [k]) => a + s[k].new, 0);
        setMsg({ ok: true, text: n ? `Listo: se agregaron ${n} elementos.` : "No había nada nuevo que agregar." });
        setBackup(null);
        router.refresh();
      }
    } catch {
      setMsg({ ok: false, text: "No se pudo hablar con el servidor" });
    } finally {
      setOcupado(false);
    }
  }

  async function elegir(f: File | undefined) {
    setResumen(null);
    setMsg(null);
    if (!f) return;
    setNombre(f.name);
    let data: unknown;
    try {
      data = JSON.parse(await f.text());
    } catch {
      setMsg({ ok: false, text: "Ese archivo no es un JSON válido." });
      return;
    }
    setBackup(data);
    await enviar("preview", data);
  }

  const nuevas = resumen ? FILAS.reduce((a, [k]) => a + resumen[k].new, 0) : 0;

  return (
    <div className="import">
      {/* El input va antes del label: así, con teclado, el foco del input
          (que está oculto) se dibuja en el label que se ve. */}
      <input
        id={id}
        className="sr"
        type="file"
        accept="application/json,.json"
        onChange={(e) => void elegir(e.target.files?.[0])}
      />
      <label className="btn line sm" htmlFor={id}>Importar respaldo…</label>
      {ocupado ? <p className="runmsg" role="status">Leyendo…</p> : null}
      {msg ? <p className={"runmsg" + (msg.ok ? "" : " bad")} role="status">{msg.text}</p> : null}

      {resumen && backup ? (
        <div className="importsum">
          <p className="propwhy">
            {nombre} · {resumen.version === 1 ? "formato anterior" : "versión 2"}
            {resumen.exportedAt ? ` · exportado el ${resumen.exportedAt.slice(0, 10)}` : ""}
          </p>
          <table>
            <thead>
              <tr><th scope="col">Qué</th><th scope="col">Nuevas</th><th scope="col">Ya las tienes</th><th scope="col">No se leen</th></tr>
            </thead>
            <tbody>
              {FILAS.filter(([k]) => resumen[k].total).map(([k, label]) => (
                <tr key={k}>
                  <th scope="row">{label}</th>
                  <td>{resumen[k].new}</td>
                  <td>{resumen[k].duplicates}</td>
                  <td>{resumen[k].invalid || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="propwhy">Sólo se agrega lo nuevo. Nada de lo que ya tienes cambia ni se borra.</p>
          <div className="propfoot">
            <button className="btn sm" type="button" disabled={ocupado || !nuevas} onClick={() => void enviar("apply", backup)}>
              {nuevas ? `Importar ${nuevas} elemento${nuevas > 1 ? "s" : ""}` : "Nada nuevo que importar"}
            </button>
            <button className="btn ghost sm" type="button" onClick={() => { setResumen(null); setBackup(null); }}>
              Cancelar
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
