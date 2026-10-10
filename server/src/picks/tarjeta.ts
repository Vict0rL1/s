// La tarjeta de «Mi selección» como SVG (Fase 5.15), generada en el servidor con los mismos
// colores de datos. El navegador la pinta en un canvas y la guarda como PNG: aquí no hay
// rasterizador (sería una dependencia nativa) y el SVG ya es compartible tal cual.

import type { Combinada, Pata } from './parlay.ts';

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c] as string);
const pct = (p: number, d = 0) => `${(p * 100).toFixed(d).replace('.', ',')} %`;
const num = (x: number, d = 2) => x.toFixed(d).replace('.', ',');
const NOMBRE: Record<string, string> = { tennis: 'Tenis', football: 'Fútbol', basketball: 'Baloncesto', baseball: 'Béisbol', nfl: 'NFL', nhl: 'NHL', ufc: 'UFC' };

export function tarjetaSvg(patas: Pata[], c: Combinada, generado = new Date()): string {
  const ancho = 720;
  const filaAlto = 34;
  const alto = 170 + patas.length * filaAlto + 70;
  const filas = patas
    .map((p, i) => {
      const y = 150 + i * filaAlto;
      const fecha = new Date(p.cuando);
      const cuando = Number.isFinite(fecha.getTime()) ? fecha.toLocaleString('es', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC' : '';
      return `
  <g transform="translate(0 ${y})">
    <text x="32" y="0" fill="#9aa1ac" font-size="12">${esc(NOMBRE[p.sport] ?? p.sport)}${p.liga ? ` · ${esc(p.liga.toUpperCase())}` : ''} · ${esc(cuando)}</text>
    <text x="32" y="18" fill="#e8eaed" font-size="15" font-weight="600">${esc(p.seleccion)}</text>
    <text x="${ancho - 32}" y="18" fill="#e8eaed" font-size="15" text-anchor="end" font-variant-numeric="tabular-nums">${pct(p.p)}${p.cuota != null ? `  <tspan fill="#9aa1ac">@ ${num(p.cuota)}</tspan>` : ''}</text>
  </g>`;
    })
    .join('');
  const ventaja = c.ventaja;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${ancho}" height="${alto}" viewBox="0 0 ${ancho} ${alto}" font-family="'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif">
  <title>Mi selección: ${patas.length} partidos, probabilidad conjunta ${pct(c.conjunta, 1)}</title>
  <rect width="${ancho}" height="${alto}" rx="16" fill="#14161b"/>
  <text x="32" y="44" fill="#e8eaed" font-size="20" font-weight="600">Mi selección · Sports Predictor</text>
  <text x="32" y="66" fill="#7b828d" font-size="12">${esc(generado.toLocaleString('es', { timeZone: 'UTC' }))} UTC · ${patas.length} partidos</text>
  <text x="32" y="108" fill="#7b828d" font-size="11" letter-spacing="1">ACERTAR TODOS</text>
  <text x="32" y="134" fill="#e8eaed" font-size="26" font-weight="600" font-variant-numeric="tabular-nums">${pct(c.conjunta, c.conjunta < 0.1 ? 1 : 0)}</text>
  ${c.cuotaCombinada != null ? `<text x="${ancho - 32}" y="108" fill="#7b828d" font-size="11" letter-spacing="1" text-anchor="end">CUOTA COMBINADA · JUSTA · VENTAJA</text>
  <text x="${ancho - 32}" y="134" fill="#e8eaed" font-size="20" font-weight="600" text-anchor="end" font-variant-numeric="tabular-nums">${num(c.cuotaCombinada)} · ${c.cuotaJusta != null ? num(c.cuotaJusta) : '—'} · <tspan fill="${(ventaja ?? 0) >= 0 ? '#199e70' : '#d95926'}">${ventaja == null ? '—' : `${ventaja >= 0 ? '+' : '−'}${pct(Math.abs(ventaja), 1)}`}</tspan></text>` : ''}
  ${filas}
  <text x="32" y="${alto - 34}" fill="#5c636c" font-size="11">${esc(c.vinculos.length ? `Correlación descontada en ${c.vinculos.length} par(es).` : 'Sin vínculos medidos entre las patas.')} Estimación estadística, no una recomendación.</text>
  <text x="32" y="${alto - 18}" fill="#5c636c" font-size="11">${esc(c.etiqueta.slice(0, 120))}</text>
</svg>
`;
}
