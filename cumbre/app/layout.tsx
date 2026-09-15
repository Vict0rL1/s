import type { Metadata, Viewport } from "next";
import { Archivo, Bricolage_Grotesque, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

/**
 * Las mismas tres tipografías del reference, pero servidas por Next desde el
 * propio dominio en vez de pedirlas a Google en cada carga.
 */
const body = Archivo({ subsets: ["latin"], display: "swap", variable: "--font-body" });
const disp = Bricolage_Grotesque({
  subsets: ["latin"],
  display: "swap",
  axes: ["opsz"],
  variable: "--font-disp",
});
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Cumbre",
  description: "Agenda, tareas, notas y rutinas — la app personal de Victor.",
  appleWebApp: { capable: true, title: "Cumbre", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F1F4F2" },
    { media: "(prefers-color-scheme: dark)", color: "#0D1311" },
  ],
};

/**
 * Aplica el tema guardado ANTES del primer pintado. Si esto corriera después
 * de la hidratación se vería un parpadeo blanco al abrir en modo oscuro.
 */
const THEME_SCRIPT = `try{var t=localStorage.getItem("cumbre.theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="es"
      className={`${body.variable} ${disp.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
