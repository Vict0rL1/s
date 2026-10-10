// Contraste WCAG entre colores hex (G6 de la prueba en el navegador, 9 de octubre). Sin React:
// lo usan los colores de club (lib/teamColors.ts) y los tests de los tokens del tema.

/** Luminancia relativa de un hex (#rrggbb). */
export function luminancia(hex: string): number {
  const h = hex.replace('#', '');
  const v = (i: number) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * v(0) + 0.7152 * v(2) + 0.0722 * v(4);
}

/** La razón de contraste entre dos hex: de 1 a 21. */
export function contraste(a: string, b: string): number {
  const [x, y] = [luminancia(a), luminancia(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

/** `hex` al `alfa` (0–1) encima de `fondo`: el color que se ve. */
export function sobre(hex: string, alfa: number, fondo: string): string {
  const a = hex.replace('#', '');
  const b = fondo.replace('#', '');
  const ch = (i: number) =>
    Math.round(parseInt(a.slice(i, i + 2), 16) * alfa + parseInt(b.slice(i, i + 2), 16) * (1 - alfa))
      .toString(16)
      .padStart(2, '0');
  return `#${ch(0)}${ch(2)}${ch(4)}`;
}
