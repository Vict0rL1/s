import { ImageResponse } from "next/og";
import { ICON_BG, iconDataUri } from "@/lib/brand";

/**
 * Los íconos PNG del manifest: 192 y 512 (los que piden Android y Chrome para
 * "instalar"), y uno "maskable" con margen, para que Android pueda recortarlo
 * en círculo sin comerse el dibujo. Se generan una vez, al compilar.
 *
 * Terminan en `.png` a propósito: el proxy deja pasar sin sesión todo lo que
 * termina así, y el navegador pide estos íconos sin cookies.
 */
export const dynamic = "force-static";

export function generateStaticParams() {
  return [{ file: "icon-192.png" }, { file: "icon-512.png" }, { file: "maskable-512.png" }];
}

export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const m = /^(icon|maskable)-(192|512)\.png$/.exec(file);
  if (!m) return new Response("No existe", { status: 404 });

  const size = Number(m[2]);
  const maskable = m[1] === "maskable";
  // La zona segura de un ícono maskable es el círculo del 80% central.
  const dibujo = maskable ? Math.round(size * 0.66) : size;

  return new ImageResponse(
    (
      <div
        style={{
          width: size, height: size, display: "flex", alignItems: "center", justifyContent: "center",
          background: maskable ? ICON_BG : "transparent",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- dentro de ImageResponse no hay <Image> */}
        <img src={iconDataUri()} width={dibujo} height={dibujo} alt="" />
      </div>
    ),
    { width: size, height: size },
  );
}
