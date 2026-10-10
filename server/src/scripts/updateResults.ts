// CLI: `npm run update-results` — los resultados de los cinco deportes de equipo, de
// una vez, y sin gastar ni un crédito de cuotas.
//
// Existe porque «¿Acertó?» enseñaba días vacíos y casi nunca era porque no hubiera
// partidos: era el archivo de resultados sin actualizar, y ponerlo al día exigía
// acordarse de cuatro comandos. Este los lanza en orden con `--skip-odds` (las cuotas
// las trae el servidor o `npm run odds`, que sí gastan) y al final dice cómo queda la
// semana.
//
// El tenis no entra: su archivo (Sackmann) llega con semanas de retraso y su
// actualización rehace la base de tenis entera; sigue siendo `npm run update-data`.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { historialReciente } from '../today.ts';
import { resolveFootballPredictions } from '../football/trackRecord.ts';
import { resolveGamePredictions } from '../basketball/trackRecord.ts';
import { resolveBaseballPredictions } from '../baseball/trackRecord.ts';
import { resolveNflPredictions } from '../nfl/trackRecord.ts';
import { resolveNhlPredictions } from '../nhl/trackRecord.ts';
import { resolveUfcPredictions } from '../ufc/trackRecord.ts';
import { empezarEjecucion, terminarEjecucion } from '../ingest/runs.ts';

const SERVIDOR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const C = { bold: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', amber: '\x1b[33m', off: '\x1b[0m' };

const PASOS = [
  { nombre: 'Fútbol', script: 'update-data:fb' },
  { nombre: 'Baloncesto', script: 'update-data:bb' },
  { nombre: 'Béisbol', script: 'update-data:bsb' },
  { nombre: 'NFL', script: 'update-data:naf' },
  { nombre: 'NHL', script: 'update-data:nhl' },
  { nombre: 'UFC', script: 'update-data:ufc' },
];

// Queda en ingestion_runs como `update-results`; cada deporte deja además la suya
// (update-data:fb…) desde su propio proceso.
const ejecucion = empezarEjecucion('update-results');
const fallidos: string[] = [];
for (const p of PASOS) {
  console.log(`\n${C.bold}▸ ${p.nombre}${C.off} ${C.dim}(npm run ${p.script} -- --skip-odds)${C.off}`);
  // Uno detrás de otro y cada uno en su proceso: si una fuente falla (sin red, un
  // formato que cambió), los otros tres se actualizan igual.
  const r = spawnSync('npm', ['run', p.script, '--', '--skip-odds'], { cwd: SERVIDOR, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) fallidos.push(p.nombre);
}

// Puntuar el registro en vivo con los resultados recién llegados. El servidor lo hace
// cada 30 minutos; sin esto, justo después de actualizar, «¿Acertó?» seguiría contando
// como «sin resultado» partidos que el archivo ya tiene.
const puntuadas: string[] = [];
for (const [nombre, f] of [['fútbol', resolveFootballPredictions], ['baloncesto', resolveGamePredictions], ['béisbol', resolveBaseballPredictions], ['NFL', resolveNflPredictions], ['NHL', resolveNhlPredictions], ['UFC', resolveUfcPredictions]] as const) {
  try {
    const n = f().resolved;
    if (n > 0) puntuadas.push(`${nombre} ${n}`);
  } catch (e) {
    console.log(`${C.amber}⚠ No se pudo puntuar ${nombre}: ${(e as Error).message}${C.off}`);
  }
}
if (puntuadas.length) console.log(`\nPredicciones en vivo puntuadas con los resultados nuevos: ${puntuadas.join(' · ')}.`);

const h = historialReciente(new Date(), 7);
console.log(`\n${C.bold}RESULTADOS${C.off}`);
for (const a of h.archivo) {
  const marca = a.sinResultado > 0 ? `${C.amber}⚠${C.off}` : `${C.green}✓${C.off}`;
  console.log(
    `${marca} ${a.deporte.padEnd(11)} archivo hasta ${a.hasta ?? '—'}` +
      (a.sinResultado > 0 ? ` · ${a.sinResultado} jugado(s) de los últimos 7 días siguen sin resultado` : ''),
  );
}
const r = h.resumen;
console.log(
  `\n«¿Acertó?» en los últimos 7 días: ${r.total === 0 ? 'ningún partido con resultado' : `${r.aciertos} de ${r.total}`}` +
    (r.tasa != null ? ` (${Math.round(r.tasa * 100)} %, esperaba ${Math.round((r.tasaEsperada ?? 0) * 100)} %)` : '') +
    ` · en vivo ${h.porOrigen['en vivo'].total}, reconstruidos ${h.porOrigen.reconstruida.total}`,
);
if (fallidos.length) {
  terminarEjecucion(ejecucion, { error: `fallaron: ${fallidos.join(', ')}` });
  console.log(`\n${C.red}✗ Falló: ${fallidos.join(', ')}.${C.off} Lo demás se actualizó. Revisa el mensaje de arriba de cada uno.`);
  process.exit(1);
}
terminarEjecucion(ejecucion, { rowsUpdated: puntuadas.length, detail: puntuadas.length ? `puntuadas: ${puntuadas.join(' · ')}` : 'sin predicciones nuevas que puntuar' });
console.log(`\n${C.dim}Si el servidor está arrancado, la pantalla lo verá al recargar.${C.off}`);
