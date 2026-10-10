import { test, expect, type Page } from '@playwright/test';
import { contrastes } from './util';

// Lote D de la revisión del 8 de octubre de 2026: la interfaz, de punta a punta con la base de
// demostración. Cada prueba es un defecto de la revisión.
// Sin service worker: `page.route` no ve lo que el worker contesta, y aquí se simulan respuestas.
test.use({ serviceWorkers: 'block' });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('predictor.recorrido', '1'));
});

for (const ancho of [1280, 390]) {
  test(`D12: a ${ancho} px la píldora y la campana se montan una vez (una petición cada una)`, async ({ page }) => {
    await page.setViewportSize({ width: ancho, height: 900 });
    const pedidas: Record<string, number> = { '/api/estado': 0, '/api/bandeja/contador': 0 };
    page.on('request', (r) => {
      const p = new URL(r.url()).pathname;
      if (p in pedidas) pedidas[p]++;
    });
    await page.goto('/destacados');
    await expect(page.getByTestId('status-pill')).toHaveCount(1);
    await page.waitForLoadState('networkidle');
    expect(pedidas).toEqual({ '/api/estado': 1, '/api/bandeja/contador': 1 });
  });
}

test('D10: Escape cierra la píldora de estado y el foco vuelve a ella; con ella abierta los atajos no cambian de pestaña', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/destacados');
  const pildora = page.getByTestId('status-pill');
  await pildora.click();
  const dialogo = page.getByRole('dialog', { name: 'Estado de la app' });
  await expect(dialogo).toBeVisible();
  await expect(dialogo).toHaveAttribute('aria-modal', 'true');
  await page.keyboard.press('2');
  await expect(page).toHaveURL(/\/destacados/);
  await page.keyboard.press('Escape');
  await expect(dialogo).toBeHidden();
  await expect(pildora).toBeFocused();
});

test.describe('D13 (galería con datos de ejemplo)', () => {
  test.beforeAll(async ({ request }) => {
    expect((await request.patch('/api/features/interfaz.muestras', { data: { on: true } })).ok()).toBeTruthy();
  });
  test.afterAll(async ({ request }) => {
    await request.patch('/api/features/interfaz.muestras', { data: { on: null } });
  });
  test('D13: la tarjeta de Destacados lleva el porqué de la confianza plegado y «Seguir» no es otra estrella', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/_muestras');
    const tarjeta = page.getByTestId('muestra-tarjeta');
    await expect(tarjeta).toBeVisible();
    const porque = tarjeta.locator('details').filter({ hasText: 'Por qué esa confianza' });
    await expect(porque).toHaveCount(1);
    await expect(porque).not.toHaveAttribute('open', '');
    await expect(porque.getByText('ejemplo: ventaja por debajo del mínimo')).toBeHidden();
    await porque.locator('summary').click();
    await expect(porque.getByText('ejemplo: ventaja por debajo del mínimo')).toBeVisible();
    const seguir = tarjeta.getByRole('button', { name: /^Seguir:/ });
    await expect(seguir).toHaveAttribute('data-icono', 'campana');
  });
});

test('D8: un enlace con ?dia= conserva el día mientras cargan los partidos', async ({ page }) => {
  // Los partidos tardan: mientras cargan no hay días, y antes eso borraba el ?dia= del enlace
  // (tenis, fútbol, baloncesto, béisbol y NFL; el tenis es el que tiene datos en la semilla).
  await page.route('**/api/matches/upcoming**', async (ruta) => {
    await new Promise((ok) => setTimeout(ok, 2_000));
    await ruta.continue();
  });
  await page.goto('/tenis?dia=2030-01-05');
  await page.waitForTimeout(1_000);
  await expect(page).toHaveURL(/dia=2030-01-05/);
});

test('D8: al pasar de un partido a otro, la ficha no arrastra el resultado del anterior', async ({ page }) => {
  await page.route('**/api/resultado/football/**', async (ruta) => {
    if (ruta.request().url().includes('clave-a')) {
      await ruta.fulfill({ json: { casa: 'Arsenal', fuera: 'Chelsea', cuando: null, probabilidades: [0.5, 0.3, 0.2], resuelto: true, resultado: 'casa', marcador: '2-1', probabilidadDada: 0.5, acerto: true } });
    } else {
      await new Promise((ok) => setTimeout(ok, 5_000));
      await ruta.fulfill({ status: 404, json: { error: 'no' } });
    }
  });
  await page.goto('/partido/football/a?clave=clave-a');
  await expect(page.getByText('2-1')).toBeVisible();
  await page.evaluate(() => {
    window.history.pushState({}, '', '/partido/football/b?clave=clave-b');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page).toHaveURL(/\/partido\/football\/b/);
  await expect(page.getByText('2-1')).toBeHidden();
});

test('G11: el buscador atrapa el foco, bloquea el fondo y lo devuelve al botón al cerrar', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/destacados');
  const boton = page.getByRole('button', { name: 'Buscar' });
  await boton.click();
  const dialogo = page.getByRole('dialog', { name: /Buscar/ });
  await expect(dialogo).toBeVisible();
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    expect(await dialogo.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  }
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');
  await page.keyboard.press('Escape');
  await expect(dialogo).toBeHidden();
  await expect(boton).toBeFocused();
});

// G5: en español, ningún número con punto decimal ni «%» pegado, en ninguna pantalla de deporte
// ni en la ficha de un partido, con las tarjetas desplegadas (la «Lectura completa» la escribe el
// servidor). Un separador de miles («20.214») no es un decimal: tres cifras tras el punto y otra
// delante que no sea 0.
const DECIMAL_CON_PUNTO = /(?<![\w.,])(?:0\.\d+|\d+\.(?!\d{3}(?!\d))\d+)/;
const PORCIENTO_PEGADO = /\d%/;
async function lineasMalEscritas(page: import('@playwright/test').Page): Promise<string[]> {
  const texto = await page.locator('main').innerText();
  return texto.split('\n').filter((l) => DECIMAL_CON_PUNTO.test(l) || PORCIENTO_PEGADO.test(l));
}
async function desplegar(page: import('@playwright/test').Page) {
  const botones = page.locator('main [aria-expanded="false"]');
  const n = Math.min(await botones.count(), 4);
  for (let i = 0; i < n; i++) await botones.nth(0).click({ timeout: 2000 }).catch(() => undefined);
}

test('G5: un solo formato de número en español (coma decimal, «%» separado) en deportes y fichas', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const malas: string[] = [];
  for (const ruta of ['/futbol', '/baloncesto', '/beisbol', '/nfl', '/nhl', '/ufc', '/tenis', '/destacados']) {
    await page.goto(ruta);
    await page.waitForLoadState('networkidle');
    await desplegar(page);
    malas.push(...(await lineasMalEscritas(page)).map((l) => `${ruta}: ${l}`));
    const enlaces = page.locator('main a[href^="/partido/"]');
    const ficha = (await enlaces.count()) > 0 ? await enlaces.first().getAttribute('href') : null;
    if (ficha) {
      await page.goto(ficha);
      await page.waitForLoadState('networkidle');
      await desplegar(page);
      malas.push(...(await lineasMalEscritas(page)).map((l) => `${ficha}: ${l}`));
    }
  }
  expect(malas, malas.join('\n')).toEqual([]);
});

// G6 y G8: lo que la base de demostración no tiene y la real sí. «Hoy» con un partido ya empezado
// y nombres largos, y la campana con avisos sin leer, simulados con las formas reales de la API.
async function conDatosReales(page: Page) {
  const ahora = Date.now();
  const partido = (deporte: string, horas: number, nombre: string, favorito: string, p: number) => ({
    deporte, cuando: new Date(ahora + horas * 3_600_000).toISOString(), partido: nombre, favorito, probabilidad: p, precioReal: true, empezado: horas < 0,
  });
  await page.route('**/api/today', (r) =>
    r.fulfill({
      json: {
        partidos: [
          partido('nhl', -1, 'St. Louis Blues – Chicago Blackhawks', 'St. Louis Blues', 0.7),
          partido('baseball', -0.5, 'San Francisco Giants – Los Angeles Dodgers', 'Los Angeles Dodgers', 0.58),
          partido('basketball', 2, 'Minnesota Timberwolves – Oklahoma City Thunder', 'Oklahoma City Thunder', 0.66),
          partido('football', 3, 'Borussia Mönchengladbach – Bayer 04 Leverkusen', 'Bayer 04 Leverkusen', 0.61),
        ],
        nota: null,
      },
    }),
  );
  await page.route('**/api/bandeja/contador', (r) => r.fulfill({ json: { noLeidas: 3 } }));
  await page.addInitScript(() => localStorage.setItem('predictor.today.open', '1'));
}

for (const tema of ['claro', 'oscuro'] as const) {
  test(`G6: en tema ${tema}, el texto atenuado, las insignias y los contadores se leen (≥ 4,5:1 contando la opacidad)`, async ({ page }) => {
    await conDatosReales(page);
    await page.addInitScript((t) => localStorage.setItem('predictor.tema', t), tema);
    await page.setViewportSize({ width: 1280, height: 900 });
    const bajos: string[] = [];
    for (const ruta of ['/destacados', '/tenis']) {
      await page.goto(ruta);
      await page.waitForLoadState('networkidle');
      await expect(page.getByTestId('campana')).toBeVisible();
      const medidos = [
        ...(await contrastes(page, '[data-testid="campana"] span')),
        ...(await contrastes(page, 'section table td, section table td span')),
        ...(await contrastes(page, 'main button span.ml-1\\.5')),
        ...(await contrastes(page, '[data-testid="insignia-confianza"] span span')),
      ];
      expect(medidos.length, ruta).toBeGreaterThan(4);
      bajos.push(...medidos.filter((m) => m.ratio < 4.5).map((m) => `${ruta}: «${m.texto}» ${m.ratio}`));
    }
    expect(bajos, bajos.join('\n')).toEqual([]);
  });
}

test('G8: a 390 px la lista de «Hoy» cabe en su caja (nada cortado a la derecha)', async ({ page }) => {
  await conDatosReales(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/destacados');
  await page.waitForLoadState('networkidle');
  const tabla = page.locator('section table').first();
  await expect(tabla).toBeVisible();
  const medida = await tabla.evaluate((t) => {
    const caja = t.parentElement!;
    return { ancho: caja.scrollWidth, visible: caja.clientWidth, derecha: Math.max(...[...t.querySelectorAll('td')].map((td) => td.getBoundingClientRect().right)), borde: caja.getBoundingClientRect().right };
  });
  expect(medida.ancho, JSON.stringify(medida)).toBeLessThanOrEqual(medida.visible);
  expect(medida.derecha, JSON.stringify(medida)).toBeLessThanOrEqual(medida.borde + 0.5);
});
