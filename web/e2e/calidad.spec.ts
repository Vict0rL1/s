import { test, expect, type Page } from '@playwright/test';
import { recogerErrores } from './util';
import { es } from '../src/i18n/es';

// Lote E de la revisión del 8 de octubre de 2026: las pruebas que habrían cazado los defectos de
// los lotes A–D. Cada una se pasó contra el código de antes de su arreglo (docs/plans/fixes-E.md).
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('predictor.recorrido', '1'));
});

test.describe('sin service worker (se simulan respuestas)', () => {
  test.use({ serviceWorkers: 'block' });
  test('E3: un 500 de la API sale en los errores que recogen los e2e', async ({ page }) => {
    await page.route('**/api/top-picks**', (r) => r.fulfill({ status: 500, json: { error: 'fallo simulado' } }));
    const errores = recogerErrores(page);
    await page.goto('/destacados');
    await page.waitForLoadState('networkidle');
    expect(errores.some((e) => /500/.test(e) && /top-picks/.test(e)), errores.join('\n')).toBe(true);
  });
});

test('E4: arranque en frío sin conexión: la app pinta con lo guardado y lo dice', async ({ browser }) => {
  const ctx = await browser.newContext({ serviceWorkers: 'allow', locale: 'es-ES' });
  const page = await ctx.newPage();
  await page.addInitScript(() => localStorage.setItem('predictor.recorrido', '1'));
  await page.goto('/destacados');
  await page.waitForFunction(async () => !!(await navigator.serviceWorker.ready).active);
  // Ahora el worker controla la página: la recarga guarda el armazón, los ficheros y la API.
  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('tablist', { name: 'Deportes' }).first()).toBeVisible();
  // Sin red de verdad: `setOffline` no corta las peticiones del propio service worker, así que
  // además se aborta todo lo que salga del contexto (también lo del worker).
  await ctx.setOffline(true);
  await ctx.route('**/*', (r) => r.abort('internetdisconnected'));
  const fria = await ctx.newPage();
  await fria.goto('/destacados');
  await expect(fria.getByRole('tablist', { name: 'Deportes' }).first()).toBeVisible({ timeout: 15_000 });
  await expect(fria.getByTestId('sin-conexion')).toBeVisible();
  await ctx.close();
});

// E8: ninguna clave sin traducir en pantalla, en ninguna ruta: ni del catálogo ni de la política.
const RUTAS = ['/destacados', '/futbol', '/baloncesto', '/beisbol', '/nfl', '/nhl', '/ufc', '/tenis', '/apuestas', '/apuestas/laboratorio', '/apuestas/lineas', '/bandeja', '/informes', '/confianza', '/confianza/archivo', '/confianza/diagnostico', '/ajustes', '/glosario', '/no-existe', '/partido/football/no-existe', '/liga/football/epl', '/jugador/atp/1'];

async function clavesEnPantalla(page: Page, claves: Set<string>): Promise<string[]> {
  // Lo que va en <code> es un identificador a propósito (nombres de interruptores, comandos).
  const texto = await page.evaluate(() => {
    const copia = document.body.cloneNode(true) as HTMLElement;
    copia.querySelectorAll('code').forEach((c) => c.remove());
    document.body.appendChild(copia);
    copia.style.cssText = 'position:absolute;left:-99999px;top:0';
    const t = copia.innerText;
    copia.remove();
    return t;
  });
  const fichas = texto.split(/\s+/).map((x) => x.replace(/^[«"'(¿¡]+|[»"'):;,.!?…]+$/g, ''));
  return [...new Set(fichas.filter((x) => claves.has(x)))];
}

test('E8: ninguna clave cruda (catálogo o política) en ninguna ruta', async ({ page, request }) => {
  test.setTimeout(180_000);
  const claves = new Set(Object.keys(es));
  const politica = (await (await request.get('/api/policy')).json()) as { vigente: { config: Record<string, Record<string, unknown>> } };
  for (const [grupo, valores] of Object.entries(politica.vigente.config)) for (const k of Object.keys(valores)) claves.add(`${grupo}.${k}`);
  expect(claves.size).toBeGreaterThan(1000);
  for (const ancho of [1280, 390]) {
    await page.setViewportSize({ width: ancho, height: 900 });
    for (const ruta of RUTAS) {
      await page.goto(ruta);
      await page.waitForLoadState('networkidle');
      expect(await clavesEnPantalla(page, claves), `${ruta} a ${ancho} px`).toEqual([]);
    }
  }
});
