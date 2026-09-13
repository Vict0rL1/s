// Un comando. Todo lo demás lo hace esto.
//
//   npm run go
//
// ===========================================================================
// QUÉ HACE, EN ORDEN
// ===========================================================================
//   1. Comprueba la versión de Node y para si no llega, con la solución escrita.
//   2. Se pone en la rama del proyecto si estás en otra.
//   3. Trae los cambios.
//   4. Instala dependencias SOLO si hacen falta.
//   5. Se asegura de que hay base de datos.
//   6. Arranca la app.
//
// ===========================================================================
// LA REGLA QUE GOBIERNA TODO LO DE ABAJO
// ===========================================================================
// UN PASO QUE FALLA NO PUEDE PARECER QUE FUE BIEN, Y UNO QUE FALLA SIN SER GRAVE NO
// PUEDE IMPEDIR QUE LA APP ARRANQUE.
//
// Son dos cosas y las dos importan. Sin la primera, «hazlo todo tú» se convierte en un
// script que se come los errores y deja una app rota sin decir por qué — que es peor que
// no tener script, porque ahora no sabes en qué paso mirar. Sin la segunda, quedarte sin
// internet en un avión te deja sin app, cuando la base y el modelo son locales y la app
// funcionaría perfectamente.
//
// Así que cada paso decide si es FATAL o si es un aviso:
//
//   fatal   → Node viejo, no hay base de datos y no se ha podido construir, npm install
//             falla. Sin eso no hay app y seguir sería fingir.
//   aviso   → sin red para hacer pull, cambios locales que impiden cambiar de rama, sin
//             clave de The Odds API. Se dice en su sitio y se sigue.
//
// ===========================================================================
// Y NO GASTA CUOTA
// ===========================================================================
// Ni una petición a The Odds API. Si hay que construir la base se hace con
// `--skip-odds`. Refrescar precios es una decisión con coste (500 al mes en el plan
// gratuito) y no puede esconderse dentro de «arráncame la app».

import { spawnSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRANCH = 'claude/tennis-prediction-app-jlhgxh';
const DB = path.join(ROOT, 'data', 'tennis.db');

// El aviso de «SQLite is an experimental feature» se silencia aquí y no con la bandera
// `--disable-warning`, para que el comando funcione igual en cualquier Node: una bandera
// desconocida no se ignora, aborta el proceso. Los demás avisos siguen saliendo.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name !== 'ExperimentalWarning') console.warn(`${w.name}: ${w.message}`);
});

const avisos = [];
/**
 * ¿Estamos DE VERDAD en la rama del proyecto al acabar el paso 2?
 *
 * Lo decide el paso de la rama y lo lee el del pull, y separarlo así no es ceremonia:
 * la primera versión hacía `git pull origin <rama-del-proyecto>` sin comprobarlo, así que
 * cuando no podía cambiar de rama —por tener cambios sin guardar— traía los commits del
 * proyecto ENCIMA de la rama en la que estuvieras. Un pull que mezcla dos historias sin
 * mencionarlo, dentro de un script cuyo trabajo es arrancar la app.
 */
let enLaRama = false;

// --- Presentación ---------------------------------------------------------
const C = { dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', off: '\x1b[0m' };
let paso = 0;
const titulo = (t) => console.log(`\n${C.bold}[${++paso}/6] ${t}${C.off}`);
const ok = (t) => console.log(`      ${C.green}✓${C.off} ${t}`);
const nota = (t) => console.log(`      ${C.dim}${t}${C.off}`);
const aviso = (t, comoArreglarlo) => {
  console.log(`      ${C.yellow}!${C.off} ${t}`);
  if (comoArreglarlo) console.log(`        ${C.dim}${comoArreglarlo}${C.off}`);
  avisos.push(t);
};

/** Para de verdad: dice qué pasó, cómo se arregla, y sale con error. */
function morir(que, comoArreglarlo) {
  console.error(`\n${C.red}✗ ${que}${C.off}`);
  if (comoArreglarlo) console.error(`\n${comoArreglarlo}\n`);
  process.exit(1);
}

/** Corre un comando enseñando su salida. Devuelve si fue bien, no lanza. */
function corre(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: false, ...opts });
  return r.status === 0;
}

/**
 * Corre un comando y captura su salida, para preguntas cortas a git.
 *
 * OJO con el `trim()`: sirve para respuestas de una línea (un SHA, un nombre de rama) y
 * ESTROPEA cualquier salida de ancho fijo, porque se lleva el espacio inicial de la
 * primera línea y descoloca los cortes por posición. Ya rompió una vez el parseo de
 * `git status --porcelain`. Para preguntas de sí/no sobre ficheros, usa `corre` con
 * `git diff --quiet`.
 */
function captura(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? (r.stdout ?? '').trim() : null;
}

/**
 * Hasta cuándo llegan los resultados guardados, en una línea.
 *
 * Lee el último partido JUGADO de cada deporte y se queda con el más reciente. No es
 * `mtime` del fichero a propósito: actualizar y no recibir nada nuevo toca el fichero sin
 * mover los datos, y entonces `mtime` diría «hoy» de una base de hace un mes.
 *
 * Si no se puede leer, lo dice y sigue. Es una línea informativa: no arranca ni para nada,
 * y caerse aquí sería la peor relación posible entre coste y beneficio.
 */
function diasDeRetraso() {
  try {
    // `node:sqlite` se carga AQUÍ y no arriba. Con un `import` estático, un Node viejo
    // reventaría al analizar el fichero —antes de ejecutar una sola línea— y el control
    // de versión del paso 1, que existe justo para dar un mensaje claro en ese caso, no
    // llegaría a correr nunca. `createRequire` es síncrono, así que sirve dentro de esta
    // función sin volverla asíncrona.
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const db = new DatabaseSync(DB, { readOnly: true });
    // Cada deporte guarda la fecha a su manera: el tenis en YYYYMMDD y el resto en
    // YYYY-MM-DD. Se normaliza a YYYYMMDD para poder compararlas.
    const fuentes = [
      ['matches', "max(replace(tourney_date,'-',''))"],
      ['fb_matches', "max(replace(match_date,'-',''))"],
      ['bb_games', "max(replace(game_date,'-',''))"],
      ['bsb_games', "max(replace(game_date,'-',''))"],
      ['naf_games', "max(replace(game_date,'-',''))"],
    ];
    let ultima = null;
    for (const [tabla, expr] of fuentes) {
      try {
        const r = db.prepare(`SELECT ${expr} AS d FROM ${tabla}`).get();
        const d = r?.d ? String(r.d).slice(0, 8) : null;
        if (d && /^\d{8}$/.test(d) && (ultima === null || d > ultima)) ultima = d;
      } catch {
        // Una tabla que no existe todavía no es un problema: los otros deportes cuentan.
      }
    }
    db.close();
    if (!ultima) return 'sin resultados guardados todavía — npm run update-all -- --skip-odds';

    const y = Number(ultima.slice(0, 4));
    const m = Number(ultima.slice(4, 6));
    const dd = Number(ultima.slice(6, 8));
    const dias = Math.floor((Date.now() - Date.UTC(y, m - 1, dd)) / 86_400_000);
    const fecha = `${ultima.slice(0, 4)}-${ultima.slice(4, 6)}-${ultima.slice(6, 8)}`;
    // Cinco días: una jornada de liga cabe en menos, así que por debajo de eso no hay
    // nada que decirle a nadie.
    if (dias > 5) {
      return `resultados hasta ${fecha} (hace ${dias} días) — actualízalos con: npm run update-all -- --skip-odds`;
    }
    return `resultados hasta ${fecha}, al día`;
  } catch (e) {
    return `no he podido leer la fecha de los datos (${e instanceof Error ? e.message : e})`;
  }
}


// ===========================================================================
// 1. NODE
// ===========================================================================
// Primero porque es el único fallo que rompe TODO lo demás de formas que no señalan a la
// causa: `node:sqlite` no existe antes de 22.5 y el error que sale es un
// «Cannot find module 'node:sqlite'» que parece un problema de dependencias.
titulo('Versión de Node');
{
  // ESTE PASO TIENE QUE PODER EJECUTARSE CON EL NODE QUE SEA.
  //
  // La primera versión no podía. El script de npm era
  // `node --experimental-sqlite ... scripts/go.mjs`, y Node 20 RECHAZA esa bandera antes
  // de leer el fichero: `node: bad option: --experimental-sqlite`, código 9. O sea que
  // quien tuviera Node viejo —justo a quien va dirigido este mensaje— veía un error
  // cript\u00edptico de una bandera en vez de «hace falta 22.5, actualiza así». El control
  // estaba escrito y era inalcanzable.
  //
  // Por eso el script de npm ya no lleva `--experimental-sqlite` (en 22.5+ no hace falta:
  // `node:sqlite` se importa igual y solo emite un aviso, que se silencia abajo) y el
  // import de sqlite es perezoso. Comprobado contra un Node 20.20.2 de verdad.
  const [may, men] = process.versions.node.split('.').map(Number);
  if (may < 22 || (may === 22 && men < 5)) {
    morir(
      `Node ${process.versions.node}, y hace falta 22.5 o más nuevo.`,
      'La app usa `node:sqlite`, que no existe antes de 22.5. Con nvm:\n' +
        '    nvm install 22 && nvm use 22\n' +
        'O bájalo de https://nodejs.org (la versión LTS sirve).',
    );
  }
  ok(`Node ${process.versions.node}`);
}

// ===========================================================================
// 2. LA RAMA
// ===========================================================================
// La rama por defecto del repositorio es otro proyecto entero, así que un clon recién
// hecho NO tiene esta app. Cambiar de rama solo si no hay nada sin guardar: descartar
// trabajo de alguien para arrancarle la app sería un intercambio que este script no
// tiene derecho a hacer.
titulo('Rama del proyecto');
{
  const actual = captura('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (actual === null) {
    aviso('esto no parece un repositorio git; me salto la rama y el pull');
  } else if (actual === BRANCH) {
    enLaRama = true;
    ok(actual);
  } else {
    const sucio = captura('git', ['status', '--porcelain']);
    if (sucio) {
      aviso(
        `estás en «${actual}» y tienes cambios sin guardar, así que no cambio de rama`,
        `Guárdalos (git stash) y vuelve a correrlo, o cambia a mano: git checkout ${BRANCH}`,
      );
    } else if (corre('git', ['checkout', BRANCH])) {
      enLaRama = true;
      ok(`cambiado de «${actual}» a «${BRANCH}»`);
    } else {
      // Lo más probable: la rama no está en local todavía.
      if (corre('git', ['fetch', 'origin', BRANCH]) && corre('git', ['checkout', BRANCH])) {
        enLaRama = true;
        ok(`traída y puesta en «${BRANCH}»`);
      } else {
        aviso(`no he podido ponerme en «${BRANCH}»`, `Pruébalo a mano: git checkout ${BRANCH}`);
      }
    }
  }
}

// ===========================================================================
// 3. TRAER LOS CAMBIOS
// ===========================================================================
// `--ff-only`: si tus commits y los de la rama se han separado, esto NO inventa una
// fusión. Una fusión automática dentro de un script de arranque es la clase de cosa que
// produce un conflicto a las dos semanas y nadie recuerda de dónde salió.
titulo('Traer los cambios');
if (!enLaRama) {
  aviso(
    'me lo salto: no estás en la rama del proyecto',
    'Traer sus commits encima de otra rama mezclaría dos historias sin avisar.',
  );
} else {
  // ---------------------------------------------------------------------------
  // ANTES DE TIRAR: DEVOLVER LOS FICHEROS GENERADOS
  // ---------------------------------------------------------------------------
  // `npm install` reescribe `package-lock.json` —basta con que tu npm sea de otra
  // versión que el que lo generó— y a partir de ahí TODOS los pull se abortan con
  // «your local changes to the following files would be overwritten by merge». La app
  // se queda congelada en la versión que fuera, y el mensaje de git no dice que baste
  // con descartar un fichero que se regenera solo.
  //
  // Pasó de verdad y por eso está esto aquí. Solo se devuelve el LOCK: se regenera de
  // `package.json` en el paso siguiente y no contiene ninguna decisión de nadie. Ningún
  // otro fichero se toca, porque descartar cambios de alguien para poder arrancar una
  // app no es un intercambio que este script tenga derecho a hacer.
  //
  // Se le pregunta a git fichero por fichero con `diff --quiet` en vez de parsear
  // `git status --porcelain`. No es preferencia de estilo: la primera versión cortaba el
  // prefijo de estado con `slice(3)` sobre una salida a la que `captura()` ya le había
  // hecho `trim()`, y ese trim se come el espacio inicial de la PRIMERA línea — así que
  // « D data/raw/.gitkeep» se convertía en «ata/raw/.gitkeep», el `git checkout` fallaba
  // con una ruta inexistente y no se restauraba nada. El pull seguía abortando y el
  // script decía que había arreglado algo. Salió reproduciendo el fallo, no leyendo el
  // código.
  const generados = ['package-lock.json', 'data/raw/.gitkeep'];
  const sucios = generados.filter(
    (f) => !corre('git', ['diff', '--quiet', 'HEAD', '--', f], { stdio: 'ignore' }),
  );
  if (sucios.length > 0) {
    if (corre('git', ['checkout', '--', ...sucios], { stdio: 'ignore' })) {
      nota(`devuelto a su versión del repo: ${sucios.join(', ')} (se regenera solo)`);
    }
  }

  const antes = captura('git', ['rev-parse', 'HEAD']);
  let hecho = false;
  // Los fallos de red se reintentan; los de git (divergencia) no, porque reintentar no
  // los arregla.
  for (const espera of [0, 2, 4, 8, 16]) {
    if (espera) {
      nota(`reintento en ${espera}s…`);
      spawnSync(process.execPath, ['-e', `setTimeout(()=>{}, ${espera * 1000})`]);
    }
    const r = spawnSync('git', ['pull', '--ff-only', 'origin', BRANCH], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    if (r.status === 0) {
      hecho = true;
      break;
    }
    const err = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    // DOS FALLOS DISTINTOS QUE NO SE PUEDEN MEZCLAR. La versión anterior los metía en la
    // misma condición porque el texto de git dice «local changes» en los dos, y entonces
    // a quien solo tenía un fichero modificado le decía que su copia «se había separado
    // de la rama» — un diagnóstico equivocado que manda a mirar el historial cuando el
    // problema es un fichero.
    const ficheros = [...err.matchAll(/^\t(.+)$/gm)].map((m) => m[1].trim());
    if (/would be overwritten by (merge|checkout)|Please commit your changes/i.test(err)) {
      aviso(
        `tienes cambios locales en ${ficheros.length ? ficheros.join(', ') : 'algún fichero'} y el pull no puede pisarlos`,
        ficheros.length
          ? `Si no son tuyos a propósito: git checkout -- ${ficheros.join(' ')}\n        Si sí lo son: gu\u00e1rdalos con git stash y vuelve a correrlo.`
          : 'Guárdalos con git stash, o descártalos con git checkout -- <fichero>.',
      );
      break;
    }
    if (/not possible to fast-forward|diverg/i.test(err)) {
      aviso(
        'tu copia se ha separado de la rama y no la fusiono por mi cuenta',
        'Mira qué tienes de más con: git log --oneline origin/' + BRANCH + '..HEAD',
      );
      break;
    }
    if (!/could not resolve|timed out|network|connection|unable to access/i.test(err)) {
      aviso('el pull ha fallado', err.trim().split('\n').slice(-2).join(' '));
      break;
    }
  }
  if (hecho) {
    const despues = captura('git', ['rev-parse', 'HEAD']);
    if (antes === despues) ok('ya estabas al día');
    else {
      const n = captura('git', ['rev-list', '--count', `${antes}..${despues}`]);
      ok(`${n} commit(s) nuevos — ${captura('git', ['log', '--oneline', '-1'])}`);
    }
  } else if (avisos.length === 0) {
    aviso('sin conexión: sigo con lo que hay en disco', 'La app funciona sin internet.');
  }
}

// ===========================================================================
// 4. DEPENDENCIAS
// ===========================================================================
// Solo cuando hacen falta. `npm install` en una instalación al día tarda unos segundos y
// no hace nada, pero esos segundos se pagan en CADA arranque y el paso se vuelve ruido
// que nadie lee — y el objetivo es que estos seis renglones se lean.
titulo('Dependencias');
{
  const lock = path.join(ROOT, 'package-lock.json');
  const marca = path.join(ROOT, 'node_modules', '.package-lock.json');
  const hayModulos = fs.existsSync(path.join(ROOT, 'node_modules'));
  const desfasado =
    !hayModulos ||
    !fs.existsSync(marca) ||
    fs.statSync(lock).mtimeMs > fs.statSync(marca).mtimeMs;

  if (!desfasado) {
    ok('al día');
  } else {
    nota(hayModulos ? 'el lock ha cambiado, reinstalando…' : 'primera instalación, esto tarda…');
    if (!corre('npm', ['install'])) {
      morir(
        'npm install ha fallado.',
        'Suele ser la versión de Node o una carpeta node_modules a medias. Prueba:\n' +
          '    rm -rf node_modules && npm install',
      );
    }
    ok('instaladas');
  }
}

// ===========================================================================
// 5. LA BASE DE DATOS
// ===========================================================================
// Sin datos no hay app, así que este paso SÍ es fatal. Y tiene dos caminos porque la
// descarga rápida depende de una release publicada que puede no existir todavía: el
// workflow «Datos» la crea, y hasta que alguien lo lance por primera vez no hay nada que
// bajar. Un script que solo intentara la descarga diría «no existe» y se rendiría,
// cuando la base se puede construir desde las fuentes.
titulo('Base de datos');
{
  if (fs.existsSync(DB)) {
    const mb = (fs.statSync(DB).size / 1024 / 1024).toFixed(0);
    ok(`ya está (${mb} MB)`);
    // Y CUÁNDO es, que es la parte que no se ve. Una base de hace tres semanas abre
    // igual, predice igual y no se queja: enseña resultados de hace tres semanas con la
    // misma seguridad que los de ayer. El fichero tiene fecha de modificación, pero esa
    // dice cuándo se escribió, no hasta cuándo llegan los partidos — y son cosas
    // distintas en cuanto alguien corre una actualización que no trae nada nuevo.
    nota(diasDeRetraso());
  } else {
    nota('no hay base. Intento la descarga rápida (9 MB)…');
    if (corre('npm', ['run', 'fetch-data'])) {
      ok('descargada');
    } else {
      console.log('');
      aviso(
        'la descarga rápida no está disponible (nadie ha publicado la release «data-latest» todavía)',
        'La construyo desde las fuentes. Tarda unos dos minutos y baja ~100 MB. No gasta cuota.',
      );
      if (!corre('npm', ['run', 'update-all', '--', '--skip-odds'])) {
        morir(
          'no he podido construir la base de datos.',
          'Sin datos la app no arranca. Con conexión, prueba a mano:\n' +
            '    npm run update-all -- --skip-odds\n' +
            'Si no tienes conexión ahora, hay un juego de demostración:\n' +
            '    npm run seed',
        );
      }
      if (!fs.existsSync(DB)) {
        morir(
          'la construcción terminó pero no hay fichero de base de datos.',
          'Mira la salida de arriba: algún deporte habrá fallado. Detalle con:\n' +
            '    npm run doctor',
        );
      }
      ok('construida');
    }
  }
}

// ===========================================================================
// 6. ARRANCAR
// ===========================================================================
titulo('Arrancando la app');
{
  // La clave no es obligatoria y la app funciona sin ella, pero con cuotas de
  // demostración. Decirlo AQUÍ y no al principio: es lo último que se lee antes de que
  // la app tome la pantalla, así que es donde se recuerda.
  const env = path.join(ROOT, '.env');
  const tieneClave =
    fs.existsSync(env) && /^\s*ODDS_API_KEY\s*=\s*\S+/m.test(fs.readFileSync(env, 'utf8'));
  if (!tieneClave) {
    aviso(
      'sin ODDS_API_KEY: las cuotas serán de demostración',
      'Para cuotas reales, pon tu clave en el fichero .env:  ODDS_API_KEY=tu-clave\n' +
        '        (npm run doctor te dice si funciona, sin gastar cuota)',
    );
  }

  if (avisos.length > 0) {
    console.log(`\n      ${C.yellow}${avisos.length} aviso(s) arriba${C.off} — la app arranca igual.`);
  }
  console.log(`\n${C.dim}      Ctrl+C para pararla.${C.off}`);

  const hijo = spawn('npm', ['run', 'dev'], { cwd: ROOT, stdio: 'inherit', shell: false });
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => hijo.kill(s));
  hijo.on('exit', (code) => process.exit(code ?? 0));
}
