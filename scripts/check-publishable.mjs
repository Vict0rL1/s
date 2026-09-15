// ¿Se puede publicar esta base sin filtrar nada de nadie?
//
// CLI: `node scripts/check-publishable.mjs`
//
// ===========================================================================
// POR QUÉ ESTO EXISTE
// ===========================================================================
// El workflow de datos sube la base a una release de un repositorio PÚBLICO. Para datos
// deportivos está bien —son públicos de origen— y para el registro de apuestas de
// alguien estaría muy mal.
//
// En un runner limpio no hay apuestas, porque las apuestas solo las crea la persona en
// su máquina. Pero «no debería haber» no es una garantía. Bastaría un cambio futuro que
// restaurara una caché o copiara una base local al runner para publicar el historial de
// apuestas de alguien, y el fallo sería completamente silencioso: un fichero de 9 MB
// que se sube igual de bien con o sin esas filas dentro.
//
// Así que se comprueba antes de subir y se falla si hay algo. Una comprobación que corre
// siempre y no cuesta nada, contra un fallo que no se puede deshacer — una vez publicado,
// está publicado.
//
// ===========================================================================
// LO QUE NO HACE
// ===========================================================================
// No borra nada. Si encuentra datos personales, PARA y lo dice; no los limpia y sigue.
// Limpiar automáticamente convertiría «hay algo raro en esta base» en un aviso que nadie
// lee, y la pregunta de por qué había apuestas en el runner merece una respuesta.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(HERE, '..', 'data', 'tennis.db');

/**
 * Lo que no debe salir, y el motivo de cada cosa — que NO es el mismo.
 *
 * `bets` es privacidad de verdad: importes, beneficios y en qué acertó alguien con su
 * dinero. Publicarlo en un repositorio público es el fallo que este script existe para
 * impedir.
 *
 * Los `*_prediction_log` son otra cosa: el track record de la app. Publicarlos no
 * filtraría nada delicado —«el modelo dijo 62 % y acertó»— pero solo se escriben cuando
 * las rutas HTTP sirven una predicción, así que si están llenos en un runner es que esta
 * base NO es una construcción limpia. Bloquean por integridad, no por privacidad, y
 * decirlo con precisión importa: quien lea el error tiene que saber qué está mirando.
 */
const FORBIDDEN = [
  {
    table: 'bets',
    why: 'privacidad',
    message:
      'es el registro de apuestas de una persona (importes y beneficios). Esta base NO ' +
      'puede publicarse en un repositorio público.',
  },
  ...['prediction_log', 'fb_prediction_log', 'bb_prediction_log', 'bsb_prediction_log', 'naf_prediction_log'].map(
    (table) => ({
      table,
      why: 'integridad',
      message:
        'es el track record de la app y solo se escribe al servir predicciones por HTTP. ' +
        'Que tenga filas significa que esta base no es una construcción limpia: alguien ' +
        'arrancó la app sobre ella.',
    }),
  ),
];

/**
 * Tablas que TIENEN que traer datos. Una base «limpia» y una base vacía se publican
 * igual de bien, y la segunda rompe la app de quien la descargue.
 */
const REQUIRED = [
  { table: 'matches', min: 10_000 },
  { table: 'fb_matches', min: 10_000 },
  { table: 'naf_games', min: 5_000 },
  { table: 'player_ratings', min: 500 },
  { table: 'fb_team_ratings', min: 100 },
];

if (!fs.existsSync(DB_PATH)) {
  console.error(`✗ No hay base en ${DB_PATH}. Nada que publicar.`);
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH);
const tables = new Set(
  (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).map((r) => r.name),
);
const count = (t) =>
  tables.has(t) ? db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n : null;

const problems = [];

console.log('¿Se puede publicar esta base?\n');

// ---- Nada personal ----
console.log('Lo que NO debe salir:');
for (const { table, why, message } of FORBIDDEN) {
  const n = count(table);
  if (n == null) {
    console.log(`  · ${table.padEnd(22)} la tabla no existe`);
    continue;
  }
  console.log(`  ${n === 0 ? '✓' : '✗'} ${table.padEnd(22)} ${String(n).padStart(6)} filas  (${why})`);
  if (n > 0) problems.push(`[${why}] ${table} tiene ${n} fila(s): ${message}`);
}

// ---- Y datos de sobra ----
console.log('\nDatos que SÍ tiene que traer:');
for (const { table, min } of REQUIRED) {
  const n = count(table);
  const ok = n != null && n >= min;
  console.log(`  ${ok ? '✓' : '✗'} ${table.padEnd(22)} ${n ?? 'no existe'} (mínimo ${min})`);
  if (!ok) {
    problems.push(
      `${table} tiene ${n ?? 'la tabla ausente'} y debería tener al menos ${min}. ` +
        'Publicar una base a medias es peor que no publicar: quien la descargue no ' +
        'tiene forma de saber que le falta la mitad.',
    );
  }
}

console.log();
if (problems.length === 0) {
  const mb = (fs.statSync(DB_PATH).size / 1048576).toFixed(0);
  console.log(`✅ Publicable. ${mb} MB sin comprimir.`);
  process.exit(0);
}
console.log(`❌ NO publicable — ${problems.length} problema(s):\n`);
for (const p of problems) console.log(`  × ${p}`);
process.exitCode = 1;
