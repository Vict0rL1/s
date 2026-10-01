import { ImageResponse } from "next/og";
import { ICON_BG, iconDataUri } from "@/lib/brand";

/** El ícono de "Agregar a pantalla de inicio" en iPhone: Safari no usa el SVG. */
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: 180, height: 180, display: "flex", alignItems: "center", justifyContent: "center", background: ICON_BG }}>
        <img src={iconDataUri()} width={150} height={150} alt="" />
      </div>
    ),
    size,
  );
}
