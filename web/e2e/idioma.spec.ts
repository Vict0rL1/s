import { test, expect as esperar } from '@playwright/test';

// Margen para todo el fichero: con dos workers, estas páginas (cada una pide su trozo de JS) pueden
// coincidir con el informe en PDF de producto.spec, que ocupa el servidor unos segundos.
const expect = esperar.configure({ timeout: 15_000 });

// La interfaz en inglés (seguimiento de la Fase 5.25): el texto sale del catálogo, no del
// componente. Lo que genera el servidor (razones, notas) sigue en español y no se comprueba aquí.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('predictor.recorrido', '1');
    localStorage.setItem('predictor.idioma', 'en');
  });
});

test('navegación, píldora de estado y analítica en inglés', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/destacados');
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');
  const barra = page.getByTestId('barra-inferior');
  for (const destino of ['Highlights', 'Sports', 'Bets', 'Trust']) await expect(barra).toContainText(destino);
  await page.locator('[data-testid=status-pill]:visible').click();
  const estado = page.getByRole('dialog', { name: 'App status' });
  await expect(estado).toBeVisible();
  await expect(estado).toContainText('Open diagnostics');
  await expect(estado).not.toContainText('Ver diagnóstico');
  await page.goto('/confianza');
  await expect(page.getByRole('heading', { name: 'Model analytics' })).toBeVisible();
  await expect(page.getByText('Accuracy by segment (live)')).toBeVisible();
});

test('motor en vivo del tenis en inglés', async ({ page }) => {
  test.slow();
  await page.goto('/tenis');
  await page.getByRole('button', { name: /Why\?|¿Por qué\?/ }).first().click();
  await expect(page.getByText('Live engine')).toBeVisible();
  await expect(page.getByLabel('Games 2')).toBeVisible();
  await expect(page.getByText("Today's serve points and live odds")).toBeVisible();
});

test('apuestas en inglés: registro, cartera y banco de papel', async ({ page }) => {
  await page.goto('/apuestas');
  await expect(page.getByRole('button', { name: '+ Record bet' })).toBeVisible();
  await expect(page.getByText('Portfolio exposure').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'The model betting on its own' })).toBeVisible();
  await page.getByRole('button', { name: '+ Record bet' }).click();
  await expect(page.getByRole('heading', { name: 'Record bet' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'By hand' })).toBeVisible();
  await expect(page.getByText('Registrar apuesta')).toHaveCount(0);
});

test('piezas comunes en inglés: cabecera, tabla de partidos y panel de discrepancias', async ({ page }) => {
  // El tenis es la pestaña con partidos en la base de demostración del e2e.
  await page.goto('/tenis');
  await expect(page.getByRole('button', { name: /Details|Hide details/ })).toBeVisible();
  await expect(page.getByText('The matches').first()).toBeVisible();
  await expect(page.getByText(/What the model sees as most likely|Where the model disagrees with the market/).first()).toBeVisible();
  await expect(page.getByText('Los partidos', { exact: true })).toHaveCount(0);
});

test('tenis en inglés: cabecera, tarjeta desplegada y clasificación por Elo', async ({ page }) => {
  test.slow();
  await page.goto('/tenis');
  await page.getByRole('button', { name: 'Details' }).click();
  await expect(page.getByText('Match predictions from surface Elo')).toBeVisible();
  await expect(page.getByText('Sort by:')).toBeVisible();
  await expect(page.getByText(/Elo ranking · /).first()).toBeVisible();
  await expect(page.getByText('Ordenar por:')).toHaveCount(0);
  await page.getByRole('button', { name: /Why\?/ }).first().click();
  await expect(page.getByText('Overall Elo').first()).toBeVisible();
  await expect(page.getByText('Points-model markets').first()).toBeVisible();
  await expect(page.getByText('Mercados del modelo de puntos')).toHaveCount(0);
});

test('fútbol y baloncesto en inglés: cabecera y aviso sin datos', async ({ page }) => {
  for (const [ruta, vacio] of [
    ['/futbol', 'No hay datos de fútbol todavía.'],
    ['/baloncesto', 'No hay datos de baloncesto todavía.'],
  ]) {
    await page.goto(ruta);
    await expect(page.getByTitle('Fetches upcoming games and their odds again')).toBeVisible();
    await expect(page.getByText(/No (football|basketball) data yet\.|All teams · |Run npm run update-data/).first()).toBeVisible();
    await expect(page.getByText(vacio)).toHaveCount(0);
    await expect(page.getByText('Vuelve a consultar')).toHaveCount(0);
  }
});

test('béisbol, NFL, NHL y UFC en inglés: cabecera y aviso sin datos', async ({ page }) => {
  for (const [ruta, titulo, vacio] of [
    ['/beisbol', 'Fetches upcoming games, their odds and the announced starters again', 'No hay datos de béisbol todavía.'],
    ['/nfl', 'Fetches upcoming games and their odds again', 'No hay datos de fútbol americano todavía.'],
    ['/nhl', 'Fetches upcoming games and their odds again', 'Todavía no hay datos de la NHL.'],
    ['/ufc', 'Fetch the upcoming fights and their odds again', 'Todavía no hay datos de la UFC.'],
  ]) {
    await page.goto(ruta);
    await expect(page.getByTitle(titulo)).toBeVisible();
    await expect(page.getByText(/No (baseball|American football|NHL) data yet\.|There is no UFC data yet\.|All teams · |Run npm run update-data/).first()).toBeVisible();
    await expect(page.getByText(vacio)).toHaveCount(0);
    await expect(page.getByText('Vuelve a consultar')).toHaveCount(0);
  }
});

test('destacados, página no encontrada y panel de preguntas en inglés', async ({ page }) => {
  test.slow();
  await page.goto('/destacados');
  await expect(page.getByRole('heading', { name: 'Highlights', level: 2 })).toBeVisible();
  await expect(page.getByText('How to read the list')).toBeVisible();
  await expect(page.getByText('Cómo leer la lista')).toHaveCount(0);
  await page.goto('/no-existe-esta-ruta');
  await expect(page.getByText('This page does not exist.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go to Highlights' })).toBeVisible();
  await page.goto('/tenis');
  await expect(page.getByRole('heading', { name: 'Ask the data' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ask', exact: true })).toBeVisible();
});
