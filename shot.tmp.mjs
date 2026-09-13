import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const page = await b.newPage({ viewport: { width: 1440, height: 1100 } });
const errores = [], fallos404 = [];
page.on('pageerror', e => errores.push('JS: ' + String(e).slice(0,140)));
page.on('console', m => { if (m.type() === 'error') errores.push('consola: ' + m.text().slice(0,140)); });
page.on('response', r => { if (r.status() >= 400) fallos404.push(`${r.status()} ${r.url().replace('http://localhost:7373','')}`); });

await page.goto('http://localhost:7373', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
for (const [emoji, nombre] of [['⚽','Fútbol'],['🏀','Baloncesto'],['⚾','Béisbol'],['🏈','NFL'],['🎾','Tenis'],['🎟','Apuestas']]) {
  try { await page.locator(`text=${emoji}`).first().click({ timeout: 6000 }); } catch { errores.push(`no pude abrir ${nombre}`); continue; }
  await page.waitForTimeout(2800);
  const r = await page.evaluate(() => ({
    texto: document.body.innerText.length,
    tarjetas: document.querySelectorAll('article').length,
    vacio: /No se pudo|error|Error/.test(document.body.innerText.slice(0, 3000)),
  }));
  console.log(`${nombre.padEnd(11)} ${String(r.texto).padStart(6)} car · ${r.tarjetas} tarjetas${r.vacio ? ' · ⚠ menciona error' : ''}`);
}
console.log('\nerrores JS/consola:', errores.length ? '\n  ' + [...new Set(errores)].join('\n  ') : '(ninguno)');
console.log('respuestas ≥400:', fallos404.length ? '\n  ' + [...new Set(fallos404)].slice(0,8).join('\n  ') : '(ninguna)');
await b.close();
