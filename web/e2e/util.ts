// Ayudas compartidas por los e2e (no es un fichero de tests).
import type { Page } from '@playwright/test';

/**
 * Los errores de la página: de consola y sin capturar. TODOS: antes se descartaba «Failed to load
 * resource», que es justo como sale un 500 de la API (E3 de la revisión del 8 de octubre).
 */
export function recogerErrores(page: Page): string[] {
  const errores: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errores.push(`${m.text()} ${m.location().url}`);
  });
  page.on('pageerror', (e) => errores.push(e.message));
  return errores;
}

/**
 * El contraste que se VE de cada elemento que casa con `selector` (G6 de la prueba en el
 * navegador): la tinta con la opacidad de sus antepasados, sobre la pila de fondos que tiene
 * debajo. axe deja como «incompleto» lo que lleva `opacity` o fondos `color-mix`, y así pasaban
 * las filas atenuadas de «Hoy» o los contadores al 60 %. Los colores se leen con un canvas, que
 * entiende `rgb()`, `color(srgb …)` y `oklch()` por igual.
 */
export async function contrastes(page: Page, selector: string): Promise<{ texto: string; ratio: number }[]> {
  return page.evaluate((sel) => {
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
    const rgba = (css: string): [number, number, number, number] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    };
    const sobre = (a: [number, number, number, number], b: [number, number, number]): [number, number, number] =>
      [0, 1, 2].map((i) => a[i] * a[3] + b[i] * (1 - a[3])) as [number, number, number];
    const lum = (c: [number, number, number]) => {
      const v = c.map((x) => {
        const s = x / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
    };
    return [...document.querySelectorAll<HTMLElement>(sel)]
      .filter((el) => el.offsetParent !== null && (el.textContent ?? '').trim() !== '')
      .map((el) => {
        let opacidad = 1;
        const capas: [number, number, number, number][] = [];
        let opaco = false;
        for (let e: HTMLElement | null = el; e; e = e.parentElement) {
          const cs = getComputedStyle(e);
          opacidad *= Number(cs.opacity);
          const bg = rgba(cs.backgroundColor);
          if (!opaco && bg[3] > 0) capas.push(bg);
          if (bg[3] >= 1) opaco = true;
        }
        let fondo: [number, number, number] = [255, 255, 255];
        for (const c of capas.reverse()) fondo = sobre(c, fondo);
        const tinta = rgba(getComputedStyle(el).color);
        const vista = sobre([tinta[0], tinta[1], tinta[2], tinta[3] * opacidad], fondo);
        const [a, b] = [lum(vista), lum(fondo)].sort((x, y) => y - x);
        return { texto: (el.textContent ?? '').trim().slice(0, 40), ratio: Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100 };
      });
  }, selector);
}
