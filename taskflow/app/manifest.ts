import type { MetadataRoute } from "next";

/**
 * Lo que hace que "Instalar" / "Agregar a pantalla de inicio" la deje como una
 * app: nombre, íconos en los tamaños que piden Android y Chrome (192 y 512,
 * más uno maskable), y abrir directo en Hoy, sin la barra del navegador.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/hoy",
    name: "TaskFlow",
    short_name: "TaskFlow",
    description: "Agenda, tareas, notas y rutinas.",
    lang: "es",
    start_url: "/hoy",
    scope: "/",
    display: "standalone",
    // Oscuro, como la app por defecto: así la pantalla de carga no destella en blanco.
    background_color: "#121211",
    theme_color: "#121211",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Nueva tarea", short_name: "Tarea", url: "/hoy?capturar=tarea" },
      { name: "Nueva nota", short_name: "Nota", url: "/hoy?capturar=nota" },
      { name: "Semana", url: "/semana" },
    ],
  };
}
