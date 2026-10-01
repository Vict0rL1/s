/**
 * El origen público de la app, el que ve el navegador. En Vercel el origen
 * interno de la petición no es el dominio de verdad: hay que mirar el host
 * reenviado. Para OAuth importa al carácter: la URL de vuelta tiene que ser
 * idéntica a la registrada en Google y a la que se usó al pedir el permiso.
 */
export function publicOrigin(req: Request): string {
  const host = req.headers.get("x-forwarded-host");
  if (host && process.env.NODE_ENV !== "development") {
    return `${req.headers.get("x-forwarded-proto") ?? "https"}://${host}`;
  }
  return new URL(req.url).origin;
}
