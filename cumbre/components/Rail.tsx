"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import type { Counts } from "@/lib/data";
import { Toast, useToast } from "./Toast";

const VIEWS = [
  { href: "/hoy", label: "Hoy", glyph: "◎", key: "hoy" },
  { href: "/tareas", label: "Tareas", glyph: "☰", key: "tareas" },
  { href: "/semana", label: "Semana", glyph: "▤", key: "semana" },
  { href: "/notas", label: "Notas", glyph: "✎", key: "notas" },
  { href: "/rutinas", label: "Rutinas", glyph: "◇", key: "rutinas" },
  { href: "/ajustes", label: "Ajustes", glyph: "⚙", key: null },
] as const;

const THEME_LABEL = { system: "del sistema", light: "claro", dark: "oscuro" } as const;

export function Rail({ counts, email }: { counts: Counts; email: string }) {
  const path = usePathname();
  const { result, toast } = useToast();
  const [busy, setBusy] = useState(false);

  function cycleTheme() {
    let cur = "system";
    try {
      cur = localStorage.getItem("cumbre.theme") || "system";
    } catch {
      /* modo incógnito con el almacenamiento bloqueado */
    }
    const next = cur === "system" ? "light" : cur === "light" ? "dark" : "system";
    try {
      localStorage.setItem("cumbre.theme", next);
    } catch {
      /* ídem */
    }
    if (next === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", next);
    toast("Tema: " + THEME_LABEL[next as keyof typeof THEME_LABEL]);
  }

  return (
    <>
      <nav className="rail" aria-label="Secciones">
        <div className="brand">
          <b>Cumbre</b>
          <span>
            <i className="syncdot" />
            sincronizado
          </span>
        </div>

        {VIEWS.map((v) => {
          const active = path === v.href || path.startsWith(v.href + "/");
          const n = v.key ? counts[v.key] : 0;
          return (
            <Link
              key={v.href}
              href={v.href}
              className="navbtn"
              aria-current={active ? "page" : undefined}
            >
              <span className="g">{v.glyph}</span>
              {v.label}
              <span className="ct">{n > 0 ? n : ""}</span>
            </Link>
          );
        })}

        <div className="railfoot">
          <button className="linky" onClick={cycleTheme}>
            Cambiar tema
          </button>
          <Link className="linky" href="/ajustes">
            Importar calendario
          </Link>
          <form action="/auth/signout" method="post" onSubmit={() => setBusy(true)}>
            <button className="linky" type="submit" disabled={busy} title={email}>
              {busy ? "Saliendo…" : "Cerrar sesión"}
            </button>
          </form>
        </div>
      </nav>
      <Toast result={result} />
    </>
  );
}
