import type { MetadataRoute } from "next";

/** Para que "Agregar a pantalla de inicio" en el celular se vea como una app. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Cumbre",
    short_name: "Cumbre",
    description: "Agenda, tareas, notas y rutinas.",
    start_url: "/hoy",
    display: "standalone",
    background_color: "#F1F4F2",
    theme_color: "#141D1A",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
