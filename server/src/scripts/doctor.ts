// CLI: `npm run doctor`
//
// ===========================================================================
// POR QUÉ EXISTE ESTE SCRIPT
// ===========================================================================
// "Me aparecen odds demo" es un síntoma con CINCO causas distintas, y desde fuera
// se parecen todas:
//
//   1. no hay `.env` en la raíz del proyecto (o está en OTRA carpeta),
//   2. lo hay, pero la línea de la clave está mal escrita (comillas, espacios,
//      `export` delante, saltos de línea de Windows),
//   3. la clave se lee bien pero The Odds API la rechaza (401),
//   4. la clave es válida pero el plan del mes está agotado,
//   5. todo está bien pero el servidor se arrancó ANTES de editar el `.env`, que
//      solo se lee al arrancar.
//
// Averiguar cuál de las cinco es requería cinco comprobaciones a mano, en el orden
// correcto, interpretando la salida de cada una. Eso es exactamente el tipo de cosa
// que debe hacer un programa: no hay ningún juicio que aportar, solo pasos.
//
// Así que esto los hace todos y termina diciendo UNA cosa: cuál es el problema y qué
// comando lo arregla. Si no hay problema, también lo dice, que es información igual
// de útil cuando lo que sospechas es lo contrario.
//
// ===========================================================================
// LO QUE ESTE SCRIPT NO HACE
// ===========================================================================
// NO escribe la clave por ti, y no es por pereza. Un script que edita el `.env` es
// un script que puede sobrescribir el que ya tenías, y la clave es el único dato de
// este proyecto que no se puede volver a generar solo. Diagnostica y te da el
// comando; ejecutarlo es tuyo.
//
// NO gasta cuota. La única llamada a la red es a `/v4/sports/`, que The Odds API
// documenta como gratuita: sirve precisamente para validar una clave sin pagar por
// ello. Sería absurdo que la herramienta que te dice si te queda plan te costase
// plan. Con `--sin-red` ni siquiera eso.

import fs from 'node:fs';
import path from 'node:path';
import { env, ROOT, DB_PATH } from '../config.ts';
import { getDb, getMeta } from '../db.ts';
import { ODDS_API_BASE } from '../oddsQuota.ts';
import { DEMO_SOURCE } from '../freshness.ts';

const NO_NET = process.argv.includes('--sin-red') || process.argv.includes('--no-net');

/** Cosas que hay que arreglar, en el orden en que hay que arreglarlas. */
const todo: { what: string; how: string[] }[] = [];
function problem(what: string, ...how: string[]): void {
  todo.push({ what, how });
}

const ok = (s: string) => console.log(`  [32m✓[0m ${s}`);
const bad = (s: string) => console.log(`  [31m✗[0m ${s}`);
const info = (s: string) => console.log(`    ${s}`);
function section(n: number, title: string): void {
  console.log(`\n[1m${n}. ${title}[0m`);
}

/**
 * La clave, censurada.
 *
 * Nunca se imprime entera: la salida de este script es lo que la gente pega en un
 * chat cuando pide ayuda, y una clave pegada en un chat es una clave quemada. Los
 * cuatro primeros y los cuatro últimos bastan para responder la única pregunta que
 * importa aquí, que es "¿es la que yo creo que es?".
 */
function mask(key: string): string {
  if (key.length <= 8) return '•'.repeat(key.length);
  return `${key.slice(0, 4)}${'•'.repeat(Math.min(key.length - 8, 24))}${key.slice(-4)}`;
}

// ===========================================================================
section(1, 'Dónde está el proyecto');
// ===========================================================================
console.log(`  raíz: ${ROOT}`);
const envPath = path.join(ROOT, '.env');
const hasEnvFile = fs.existsSync(envPath);
if (hasEnvFile) {
  ok(`.env encontrado en ${envPath}`);
} else {
  bad(`NO hay .env en ${envPath}`);
  info('La app lee el .env de la raíz del proyecto, la misma carpeta que package.json.');
  problem(
    'No existe el archivo .env donde la app lo busca',
    `cd ${ROOT}`,
    'cp .env.example .env',
    'nano .env      # pon tu clave en la línea ODDS_API_KEY=',
  );
}

// Un `.env` en la carpeta de al lado es el fallo más común de todos, y es invisible:
// el archivo existe, tiene la clave correcta, y la app no lo lee jamás porque no está
// donde mira. Buscarlo cuesta cuatro `existsSync` y ahorra una tarde.
const elsewhere = [
  path.join(ROOT, '..', '.env'),
  path.join(ROOT, 'server', '.env'),
  path.join(ROOT, 'web', '.env'),
  path.join(process.cwd(), '.env'),
]
  .map((p) => path.resolve(p))
  .filter((p, i, a) => p !== path.resolve(envPath) && a.indexOf(p) === i && fs.existsSync(p));
for (const p of elsewhere) {
  bad(`hay OTRO .env en ${p} — la app NO lo lee`);
  if (!hasEnvFile) {
    info('Probablemente es el tuyo, con tu clave dentro. Muévelo:');
    problem(
      `Tu .env está en ${p}, pero la app lee ${envPath}`,
      `cp "${p}" "${envPath}"`,
    );
  }
}

// ===========================================================================
section(2, 'La clave dentro del .env');
// ===========================================================================
let raw = '';
if (hasEnvFile) {
  raw = fs.readFileSync(envPath, 'utf8');
  const line = raw.split(/\r?\n/).find((l) => /^\s*(export\s+)?ODDS_API_KEY\s*=/.test(l));
  if (!line) {
    bad('el .env existe pero no tiene ninguna línea ODDS_API_KEY=');
    problem(
      'Falta la línea de la clave en el .env',
      `echo 'ODDS_API_KEY=tu-clave-aqui' >> "${envPath}"`,
    );
  } else {
    // Se diagnostica la línea CRUDA, no lo que dotenv haya conseguido entender. Es
    // la diferencia entre "no funciona" y "no funciona PORQUE tiene comillas".
    const value = line.slice(line.indexOf('=') + 1);
    if (/^\s*export\s/.test(line)) {
      bad('la línea empieza por `export` — un .env no es un script de shell');
      problem('Quita el `export` del principio de la línea ODDS_API_KEY', `nano "${envPath}"`);
    }
    if (raw.includes('\r')) {
      bad('el archivo tiene saltos de línea de Windows (\\r\\n) y eso pega un \\r al final de la clave');
      problem(
        'El .env tiene saltos de línea de Windows',
        `tr -d '\\r' < "${envPath}" > "${envPath}.tmp" && mv "${envPath}.tmp" "${envPath}"`,
      );
    }
    if (/^\s*["']|["']\s*$/.test(value)) {
      bad('la clave está entre comillas — quítalas, van sin nada alrededor');
      problem('Quita las comillas de la clave', `nano "${envPath}"`);
    }
    if (value.trim().length === 0) {
      bad('la línea ODDS_API_KEY está vacía');
      problem('Escribe tu clave después del = en el .env', `nano "${envPath}"`);
    }
  }
}

// Y esto es lo que la app ve de verdad, después de que dotenv lo interprete.
const key = env.oddsApiKey;
const formatProblems = todo.length;
if (key) {
  // Un ✓ verde al lado de una clave que acabo de decir que está mal escrita sería
  // tranquilizador y falso. Cuando hay pegas de formato la línea es informativa: la
  // app lee ALGO, y eso es distinto de que ese algo sirva.
  (formatProblems > 0 ? info : ok)(`la app lee la clave: ${mask(key)}  (${key.length} caracteres)`);
  // 32 hex es el formato de The Odds API. No es una regla del universo, así que es un
  // aviso y no un error: si algún día cambian el formato, esto no debe bloquear a nadie.
  if (!/^[0-9a-f]{32}$/i.test(key)) {
    info('⚠ no tiene la pinta habitual de una clave de The Odds API (32 caracteres hex).');
    info('  Puede estar bien; si el paso 3 la rechaza, empieza por aquí.');
  }
} else {
  bad('la app NO ve ninguna clave — arrancará siempre en modo demostración');
}

// ===========================================================================
section(3, 'Qué dice The Odds API');
// ===========================================================================
let remaining: number | null = null;
if (!key) {
  info('sin clave que comprobar, me salto este paso');
} else if (NO_NET) {
  info('--sin-red: me salto la comprobación contra The Odds API');
} else {
  // /v4/sports/ es gratuita: valida la clave y devuelve las cabeceras de cuota sin
  // consumir ninguna petición. Es la llamada correcta para un diagnóstico.
  const url = `${ODDS_API_BASE}/sports/?apiKey=${encodeURIComponent(key)}`;
  try {
    const res = await fetch(url);
    if (res.status === 200) {
      remaining = Number(res.headers.get('x-requests-remaining'));
      const used = Number(res.headers.get('x-requests-used'));
      ok('la clave es válida');
      if (Number.isFinite(remaining) && Number.isFinite(used)) {
        info(`peticiones restantes este mes: ${remaining}   ·   usadas: ${used}`);
        if (remaining <= 0) {
          bad('el plan del mes está AGOTADO — por eso ves cuotas de demostración');
          problem(
            'La clave funciona pero no le quedan peticiones este mes',
            '# espera al reinicio mensual del plan, o sube de plan en the-odds-api.com',
          );
        } else if (remaining < 50) {
          info('⚠ quedan muy pocas: la app se reserva un margen y deja de refrescar sola.');
        }
      }
    } else if (res.status === 401) {
      bad('The Odds API RECHAZA la clave (401)');
      info('La clave se lee bien pero no es válida: caducada, revocada, o mal copiada.');
      problem(
        'The Odds API rechaza la clave (401)',
        '# entra en https://the-odds-api.com, copia la clave del panel,',
        `nano "${envPath}"`,
      );
    } else {
      const body = (await res.text()).slice(0, 200);
      bad(`The Odds API respondió ${res.status}`);
      info(body);
      // Sin esta entrada el script terminaba imprimiendo "Todo correcto" después de
      // haber enseñado un error en rojo tres líneas más arriba. Cualquier respuesta
      // que no sea 200 ni 401 deja la clave SIN VERIFICAR, y no verificada no es lo
      // mismo que buena.
      problem(
        `The Odds API respondió ${res.status} — no he podido verificar la clave`,
        '# no es un problema de tu .env: la clave se lee, pero la API no contesta 200.',
        '# vuelve a probar en un rato:',
        'npm run doctor',
      );
    }
  } catch (e) {
    bad(`no pude conectar con The Odds API: ${(e as Error).message}`);
    info('Esto es la red de tu máquina, no la clave. Mira si tienes internet o un proxy/VPN.');
    problem(
      'No hay conexión con The Odds API — la clave queda sin verificar',
      '# comprueba tu internet / VPN / proxy, y repite:',
      'npm run doctor',
    );
  }
}

// ===========================================================================
section(4, 'Qué hay guardado ahora mismo');
// ===========================================================================
if (!fs.existsSync(DB_PATH)) {
  bad(`no existe la base de datos (${DB_PATH})`);
  problem(
    'La base de datos no existe todavía',
    'npm run update-data:fb',
    'npm run update-data',
  );
} else {
  const db = getDb();
  // `price` es la columna que contiene un precio de casa de apuestas, y cada deporte
  // la llama distinto. Se mira LA COLUMNA y no solo el nombre del origen porque los
  // dos no dicen lo mismo: la NFL guarda su calendario con `source = 'schedule'`, que
  // es un origen perfectamente real — y sin un solo precio dentro. Clasificar por el
  // nombre del origen daba "32 partidos con cuotas REALES" para 32 filas con las
  // cuotas a NULL, que es justo la clase de mentira tranquilizadora que este script
  // existe para no contar.
  const sports: { name: string; table: string; meta: string; price: string; cmd: string }[] = [
    { name: 'Fútbol', table: 'fb_upcoming', meta: 'fb_odds_source', price: 'odds_home', cmd: 'npm run update-data:fb' },
    { name: 'Baloncesto', table: 'bb_upcoming', meta: 'bb_odds_source', price: 'home_odds', cmd: 'npm run update-data:bb' },
    { name: 'Béisbol', table: 'bsb_upcoming', meta: 'bsb_odds_source', price: 'odds_home', cmd: 'npm run update-data:bsb' },
    { name: 'NFL', table: 'naf_upcoming', meta: 'naf_odds_source', price: 'odds_home', cmd: 'npm run update-data:naf' },
    { name: 'Tenis', table: 'upcoming_matches', meta: 'odds_source', price: 'p1_odds', cmd: 'npm run update-data' },
  ];
  let anyDemo = false;
  for (const s of sports) {
    const r = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN source = ? THEN 1 ELSE 0 END) AS demo,
                SUM(CASE WHEN source <> ? AND ${s.price} IS NOT NULL THEN 1 ELSE 0 END) AS real,
                SUM(CASE WHEN ${s.price} IS NULL THEN 1 ELSE 0 END) AS noprice
         FROM ${s.table}`,
      )
      .get(DEMO_SOURCE, DEMO_SOURCE) as unknown as {
      total: number;
      demo: number | null;
      real: number | null;
      noprice: number | null;
    };
    const total = r.total;
    const demo = r.demo ?? 0;
    const real = r.real ?? 0;
    const noprice = r.noprice ?? 0;
    const when = getMeta(s.meta.replace('_source', '_refreshed_at')) ?? getMeta('odds_refreshed_at');
    const stamp = when ? new Date(when).toLocaleString('es-ES') : 'nunca';
    const name = s.name.padEnd(11);
    if (total === 0) {
      console.log(`  ${name} sin partidos guardados            (${s.cmd})`);
      continue;
    }
    // Las tres cuentas se describen por separado en vez de resumirse en una etiqueta:
    // "12 con precios reales, 8 sin precios" es una frase que se puede comprobar.
    const parts: string[] = [];
    if (real > 0) parts.push(`${real} con precios reales`);
    if (demo > 0) parts.push(`${demo} de DEMOSTRACIÓN`);
    if (noprice > 0 && demo === 0) parts.push(`${noprice} sin precios (solo calendario)`);
    const line = `${name} ${parts.join(' + ')} · ${stamp}`;
    if (demo > 0) {
      anyDemo = true;
      bad(line);
    } else if (real === 0) {
      // Ni inventados ni reales: hay partidos, no hay mercado con el que comparar.
      // No es un fallo de configuración, así que no entra en QUÉ HACER.
      console.log(`  ${line}`);
    } else {
      ok(line);
    }
  }
  if (anyDemo && key && remaining !== null && remaining > 0) {
    // Este es el quinto caso, y el más frustrante: todo correcto, datos viejos. Solo
    // se puede afirmar cuando la clave YA se ha validado contra la API en el paso 3.
    problem(
      'La clave funciona, pero lo guardado se descargó sin ella (o antes de ponerla)',
      'npm run update-data:fb',
      'npm run update-data:bb',
      'npm run update-data:bsb',
      'npm run update-data:naf',
      'npm run update-data',
    );
  }
}

// ===========================================================================
console.log('\n' + '─'.repeat(70));
// ===========================================================================
if (todo.length === 0) {
  console.log('[32m[1mTodo correcto.[0m');
  console.log('Si aun así ves cuotas de demostración en pantalla, es el caso 5: el');
  console.log('servidor lee el .env UNA VEZ, al arrancar. Párralo con Ctrl+C y:');
  console.log('\n  npm run dev\n');
} else {
  console.log(`[1mQUÉ HACER[0m  (${todo.length} cosa${todo.length > 1 ? 's' : ''} por arreglar, en este orden)\n`);
  todo.forEach((t, i) => {
    console.log(`[1m${i + 1}) ${t.what}[0m`);
    for (const line of t.how) console.log(`     ${line}`);
    console.log();
  });
  console.log('Y al terminar, reinicia el servidor — el .env solo se lee al arrancar:');
  console.log('\n  npm run dev\n');
}
// El código de salida permite encadenarlo: `npm run doctor && npm run dev`.
process.exit(todo.length === 0 ? 0 : 1);
