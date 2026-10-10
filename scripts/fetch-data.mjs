// Bajarse la base ya construida en vez de construirla.
//
// CLI:
//   npm run fetch-data              la baja si no hay ninguna
//   npm run fetch-data -- --force   reemplaza la que haya (guardando tus apuestas)
//
// ===========================================================================
// PARA QUÉ
// ===========================================================================
// `npm run update-all` tarda unos dos minutos y descarga un centenar de megas de
// archivos. El workflow nocturno ya hace ese trabajo una vez para todos y publica el
// resultado: 9 MB comprimidos. Un clon nuevo pasa de «cero datos» a «todo al día» en
// unos segundos.
//
// ===========================================================================
// LO QUE ESTE SCRIPT SE NIEGA A HACER
// ===========================================================================
// Machacar tu base sin avisar. Si ya hay una, no la toca — hay que pedirlo con --force.
//
// Y ni con --force se pierde el registro de apuestas. La base publicada se construye en
// un runner limpio, así que su tabla `bets` está VACÍA: instalarla encima de la tuya
// borraría tus apuestas, tus importes y tu histórico de aciertos, y los borraría en
// silencio, porque la app arrancaría perfectamente después. Así que --force copia tus
// tablas personales a la base nueva antes de dejarla en su sitio, y además guarda una
// copia de la vieja con fecha.
//
// ===========================================================================
// Y UNA DESCARGA A MEDIAS ES PEOR QUE NINGUNA
// ===========================================================================
// Un fichero SQLite truncado no da error al abrirse: da error mucho más tarde, con una
// consulta cualquiera y un mensaje que no señala a la descarga. Así que se comprueba el
// SHA-256 publicado, se descomprime a un temporal, se abre y se cuentan las filas ANTES
// de mover nada al sitio definitivo.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { copiaConsistente, hayHistoria, integridadDe, otraConexionAbierta, quitarLaterales } from './datos-estado.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
// El mismo DATA_DIR que el servidor (un despliegue lo tiene fuera del proyecto).
const DATA = process.env.DATA_DIR?.trim() || path.join(ROOT, 'data');
// Desde la Fase 2 la base publicada es history.db: solo historia, reconstruible. Tus
// apuestas, predicciones y precios viven en ledger.db y esta descarga no los toca.
const DB_PATH = path.join(DATA, 'history.db');
const LEGACY_DB_PATH = path.join(DATA, 'tennis.db');
const LEDGER_DB_PATH = path.join(DATA, 'ledger.db');

const REPO = process.env.DATA_REPO || 'Vict0rL1/s';
const TAG = process.env.DATA_TAG || 'data-latest';
// `DATA_BASE_URL` existe para poder probar el camino entero contra un servidor local,
// sin depender de que la release ya esté publicada. Sin él no habría forma de comprobar
// la validación ni el rescate de apuestas hasta después de haberlo desplegado.
const BASE = process.env.DATA_BASE_URL || `https://github.com/${REPO}/releases/download/${TAG}`;

const argv = process.argv.slice(2);
const force = argv.includes('--force');

/**
 * Las tablas que son TUYAS y no del deporte. Sobreviven a un --force.
 *
 * `bets` es la importante: tu dinero. Los `*_prediction_log` son el track record de la
 * app, que también es tuyo — mide cuánto ha acertado en TUS partidos vistos, y
 * reiniciarlo a cero cada vez que se refresca la base haría que nunca acumulara nada.
 */
const MINE = [
  'bets',
  'prediction_log',
  'fb_prediction_log',
  'bb_prediction_log',
  'bsb_prediction_log',
  'naf_prediction_log',
  'nhl_prediction_log',
  'ufc_prediction_log',
  // Lo que se MIDIÓ en tu instalación y no se puede volver a conseguir (lote B, B3): precios
  // observados por el refresco de fútbol, noticias con su fecha, alineaciones esperada y
  // confirmada, latencias, y los ids de tenis que la ingesta asigna y nunca reinicia.
  'fb_odds_history',
  'fb_news',
  'fb_lineups',
  'latency_samples',
  'player_ids',
];

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `${url} → HTTP ${res.status}. ` +
        (res.status === 404
          ? `¿Existe ya la release «${TAG}»? La crea el workflow «Datos» en su primera ejecución.`
          : ''),
    );
  }
  return res;
}

function rowCounts(file) {
  const db = new DatabaseSync(file);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  const counts = {};
  for (const t of ['matches', 'fb_matches', 'naf_games', 'player_ratings']) {
    counts[t] = tables.includes(t) ? db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n : 0;
  }
  db.close();
  return counts;
}

/** Copia tus tablas de una base a otra. Devuelve cuántas filas se salvaron. */
function carryOver(fromFile, toFile) {
  const db = new DatabaseSync(toFile);
  let moved = 0;
  try {
    // ATTACH y no leer-y-reinsertar a mano: así el esquema de cada tabla lo resuelve
    // SQLite y no hay que mantener una lista de columnas que se desincroniza en cuanto
    // alguien añade una.
    db.exec(`ATTACH DATABASE '${fromFile.replace(/'/g, "''")}' AS old`);
    const oldTables = new Set(
      db.prepare("SELECT name FROM old.sqlite_master WHERE type='table'").all().map((r) => r.name),
    );
    const newTables = new Set(
      db.prepare("SELECT name FROM main.sqlite_master WHERE type='table'").all().map((r) => r.name),
    );
    for (const t of MINE) {
      if (!oldTables.has(t) || !newTables.has(t)) continue;
      const n = db.prepare(`SELECT COUNT(*) AS n FROM old."${t}"`).get().n;
      if (n === 0) continue;
      db.exec(`INSERT OR REPLACE INTO main."${t}" SELECT * FROM old."${t}"`);
      console.log(`  · ${t}: ${n} fila(s) conservadas`);
      moved += n;
    }
    db.exec('DETACH DATABASE old');
  } finally {
    db.close();
  }
  return moved;
}

async function main() {
  fs.mkdirSync(DATA, { recursive: true });

  // Una instalación anterior a la Fase 2 tiene todo en tennis.db. Antes de descargar nada
  // hay que partirla (history.db + ledger.db): si no, la historia descargada quedaría al
  // lado de un tennis.db con las apuestas dentro y el servidor no sabría cuál es la buena.
  if (fs.existsSync(LEGACY_DB_PATH) && !fs.existsSync(DB_PATH) && !fs.existsSync(LEDGER_DB_PATH)) {
    throw new Error(
      `Hay una base antigua en ${path.relative(ROOT, LEGACY_DB_PATH)} que aún no se ha partido.\n` +
        '  Primero:  npm run db:migrate   (la parte en history.db + ledger.db sin perder nada;\n' +
        '            el original queda al lado como tennis.db.pre-split-<fecha>)\n' +
        '  Después:  npm run fetch-data',
    );
  }

  // Nada se reemplaza ni se aparta mientras otro proceso tenga la base abierta (B1): la conexión
  // vieja seguiría escribiendo en el fichero viejo y el siguiente checkpoint aplicaría su WAL al
  // nuevo. Se mira ANTES de descargar nada.
  if (fs.existsSync(DB_PATH) && (force || !hayHistoria(DB_PATH)) && otraConexionAbierta(DB_PATH)) {
    throw new Error(
      `${path.relative(ROOT, DB_PATH)} está abierta por otro proceso (el servidor en marcha, o npm run dev).\n` +
        '  Párala y vuelve a intentarlo: reemplazar la base bajo una conexión abierta la corrompe.',
    );
  }

  // Una base SIN FILAS (solo esquema: lo que deja db:migrate antes de bajar datos) cuenta como
  // ausente (A7). Se aparta con fecha, no se borra: nunca se destruye un fichero de data/.
  if (fs.existsSync(DB_PATH) && !hayHistoria(DB_PATH)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    for (const sufijo of ['', '-wal', '-shm']) {
      if (fs.existsSync(DB_PATH + sufijo)) fs.renameSync(DB_PATH + sufijo, `${DB_PATH}.sin-filas-${stamp}${sufijo}`);
    }
    console.log(`Hay un history.db sin filas (solo esquema): se aparta como history.db.sin-filas-${stamp} y se descarga la publicada.`);
  }

  const exists = fs.existsSync(DB_PATH);
  if (exists && !force) {
    const mb = (fs.statSync(DB_PATH).size / 1048576).toFixed(0);
    console.log(
      `Ya hay una base de historia en ${path.relative(ROOT, DB_PATH)} (${mb} MB). No se toca.\n\n` +
        '  · Para reemplazarla por la publicada:  npm run fetch-data -- --force\n' +
        '    (guarda una copia de la actual; tus apuestas están en ledger.db y no se tocan)\n' +
        '  · Para actualizarla tú mismo:          npm run update-all',
    );
    return;
  }

  console.log(`Descargando de ${REPO} (${TAG})…`);

  // El checksum primero: es pequeño, y si no está, la release no está completa.
  let expected = null;
  try {
    expected = (await (await download(`${BASE}/history.db.gz.sha256`)).text()).trim().split(/\s+/)[0];
  } catch {
    console.log('  (sin fichero de checksum publicado: se comprobará solo que la base abre)');
  }

  const gz = await download(`${BASE}/history.db.gz`);
  const tmpGz = `${DB_PATH}.download`;
  await pipeline(Readable.fromWeb(gz.body), fs.createWriteStream(tmpGz));

  const size = fs.statSync(tmpGz).size;
  console.log(`  ${(size / 1048576).toFixed(1)} MB descargados`);

  if (expected) {
    const got = crypto.createHash('sha256').update(fs.readFileSync(tmpGz)).digest('hex');
    if (got !== expected) {
      fs.rmSync(tmpGz, { force: true });
      throw new Error(
        `El checksum no cuadra.\n  esperado ${expected}\n  obtenido ${got}\n` +
          'La descarga llegó incompleta o corrupta. No se instala nada.',
      );
    }
    console.log('  ✓ SHA-256 correcto');
  }

  // A un temporal, no al sitio definitivo: si la validación falla, la base que había
  // sigue intacta.
  const tmpDb = `${DB_PATH}.new`;
  try {
    await pipeline(fs.createReadStream(tmpGz), zlib.createGunzip(), fs.createWriteStream(tmpDb));
  } catch (e) {
    // zlib dice «unexpected end of file» y nada más, que no señala a la descarga. Sin
    // esta traducción, el mensaje manda a buscar el fallo en el sitio equivocado.
    throw new Error(
      `El fichero descargado no se puede descomprimir (${e.message}). Llegó incompleto ` +
        'o no es un .gz. No se instala nada; vuelve a intentarlo.',
    );
  }
  fs.rmSync(tmpGz, { force: true });

  let counts;
  try {
    const integridad = integridadDe(tmpDb);
    if (integridad !== 'ok') throw new Error(`integrity_check: ${integridad}`);
    counts = rowCounts(tmpDb);
  } catch (e) {
    throw new Error(`La base descargada no se puede abrir: ${e.message}`);
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total < 10_000) {
    throw new Error(
      `La base descargada casi está vacía (${total} filas en las tablas principales). ` +
        'No se instala: una base a medias rompe la app sin decir por qué.',
    );
  }
  console.log(
    '  ✓ abre y trae datos: ' +
      Object.entries(counts)
        .map(([t, n]) => `${t} ${n.toLocaleString('es')}`)
        .join(' · '),
  );

  if (exists) {
    // Copia con fecha ANTES de tocar nada. Es lo que hace que --force sea reversible. Con
    // `VACUUM INTO` y no con una copia del fichero: así lleva también lo que estuviera en el WAL.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backup = `${DB_PATH}.backup-${stamp}`;
    if (otraConexionAbierta(DB_PATH)) throw new Error(`${path.relative(ROOT, DB_PATH)} se abrió por otro proceso mientras se descargaba. No se toca nada.`);
    const integridad = copiaConsistente(DB_PATH, backup);
    if (integridad !== 'ok') throw new Error(`La base actual no pasa integrity_check (${integridad}); no se reemplaza. La copia está en ${path.basename(backup)}.`);
    console.log(`\n  Copia de la anterior en ${path.basename(backup)} (completa, con lo que hubiera en el WAL)`);
    // Lo tuyo se conserva desde esa copia consistente. Si la base vieja aún tuviera tablas del
    // libro mayor (una instalación anterior a la Fase 2 partida a mano), igual.
    const moved = carryOver(backup, tmpDb);
    if (moved > 0) console.log(`  · ${moved} fila(s) de tus tablas conservadas`);
  }

  // Un -wal o -shm de la base anterior junto a la nueva sería un WAL ajeno: fuera antes del rename.
  quitarLaterales(DB_PATH);
  fs.renameSync(tmpDb, DB_PATH);
  console.log(
    `\n✅ Historia instalada en data/history.db (${(fs.statSync(DB_PATH).size / 1048576).toFixed(0)} MB). Tu ledger.db no se ha tocado.\n` +
      '   Las cuotas NO vienen dentro: las pide el servidor al arrancar, con tu clave.\n' +
      '   Comprueba que todo cuadra con `npm run verify:data`.',
  );
}

/**
 * Los temporales se borran SIEMPRE, salga bien o mal.
 *
 * La primera versión los borraba en cada camino de error a mano y se dejó dos: una
 * descarga truncada abandonaba un `.download` de medio mega y un `.new` a medias en
 * `data/`. No rompía nada, y eso es justo lo malo — la basura se acumula en silencio y
 * el `.new` a medio descomprimir se parece lo bastante a una base como para confundir a
 * quien la encuentre.
 */
function cleanup() {
  for (const f of [`${DB_PATH}.download`, `${DB_PATH}.new`]) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      // Si no se puede borrar, no es motivo para fallar por encima del error real.
    }
  }
}

main()
  .catch((e) => {
    console.error(`\n✗ ${e.message}`);
    process.exitCode = 1;
  })
  .finally(cleanup);
