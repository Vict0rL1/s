// Los cinco deportes, en una sola tirada.
//
// CLI:
//   npm run update-all                  todo, con cuotas
//   npm run update-all -- --skip-odds   solo el histórico, sin gastar cuota
//   npm run update-all -- --only fb,bb  solo algunos deportes
//
// ===========================================================================
// POR QUÉ UN SCRIPT Y NO CINCO `&&` ENCADENADOS
// ===========================================================================
// Tres razones, y las tres son cosas que la cadena de `&&` hace mal:
//
//   1. UN FALLO NO PUEDE PARAR LOS DEMÁS. Con `&&`, si la fuente del béisbol está
//      caída, la NFL no se actualiza — y no porque le pase nada, sino porque iba
//      detrás. Aquí cada deporte es independiente: si uno falla, se anota y se sigue.
//
//   2. HAY QUE SABER QUÉ FALLÓ. Cinco comandos encadenados dejan un muro de salida y
//      un código de error. Al final de esto hay una tabla que dice cuál fue y por qué.
//
//   3. EL ORDEN NO ES INDIFERENTE. El fútbol va primero porque es el deporte con más
//      superficie (histórico, próximos, cuotas Y plantillas) y el que más tarda: si
//      algo va a fallar, mejor enterarse en el primer minuto que en el último.
//
// ===========================================================================
// LA CUOTA
// ===========================================================================
// «Actualizar todo» son cinco tiradas contra The Odds API, y el plan gratuito son 500
// peticiones AL MES. Correr esto varias veces al día lo quema en una semana.
//
// Por eso el resumen final dice cuánta cuota queda, y por eso `--skip-odds` está
// documentado arriba del todo: el histórico de resultados cambia una vez por jornada y
// no necesita precios. Las cuotas ya se refrescan solas mientras el servidor está
// arrancado, con una cadencia que se ajusta al tamaño del plan.

import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const skipOdds = argv.includes('--skip-odds');
const onlyArg = argv[argv.indexOf('--only') + 1];
const only =
  argv.includes('--only') && onlyArg && !onlyArg.startsWith('--')
    ? new Set(onlyArg.split(',').map((s) => s.trim()))
    : null;

/**
 * El orden importa: el fútbol primero porque es el más largo y el que más partes
 * tiene, así que un fallo suyo se ve antes.
 */
const SPORTS = [
  { id: 'fb', label: '⚽ Fútbol', script: 'update-data:fb' },
  { id: 'tennis', label: '🎾 Tenis', script: 'update-data' },
  { id: 'bb', label: '🏀 Baloncesto', script: 'update-data:bb' },
  { id: 'bsb', label: '⚾ Béisbol', script: 'update-data:bsb' },
  { id: 'naf', label: '🏈 NFL', script: 'update-data:naf' },
];

const chosen = only ? SPORTS.filter((s) => only.has(s.id)) : SPORTS;

if (chosen.length === 0) {
  console.error(
    `Ningún deporte coincide con --only "${onlyArg}".\n` +
      `Válidos: ${SPORTS.map((s) => s.id).join(', ')}`,
  );
  process.exit(1);
}

function run(script, args) {
  return new Promise((resolve) => {
    const child = spawn('npm', ['run', script, '--', ...args], {
      stdio: 'inherit',
      // `shell: true` en Windows, donde `npm` es un .cmd y spawn no lo encuentra si no.
      shell: process.platform === 'win32',
    });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

const started = Date.now();
console.log(
  `\n${'='.repeat(64)}\n` +
    `ACTUALIZANDO ${chosen.length} DEPORTE(S)` +
    (skipOdds ? ' · SIN CUOTAS (--skip-odds)' : ' · con cuotas') +
    `\n${'='.repeat(64)}`,
);
if (!skipOdds) {
  console.log(
    '\nCada deporte pide cuotas a The Odds API. Si solo quieres refrescar el\n' +
      'histórico de resultados, `npm run update-all -- --skip-odds` no gasta nada.',
  );
}

const results = [];
for (const sport of chosen) {
  const t0 = Date.now();
  console.log(`\n\n${'─'.repeat(64)}\n${sport.label}\n${'─'.repeat(64)}`);
  const code = await run(sport.script, skipOdds ? ['--skip-odds'] : []);
  results.push({ ...sport, code, seconds: (Date.now() - t0) / 1000 });
}

// ---- El resumen. Es el motivo de que esto sea un script ----
console.log(`\n\n${'='.repeat(64)}\nRESUMEN\n${'='.repeat(64)}`);
for (const r of results) {
  console.log(
    `  ${r.code === 0 ? '✅' : '❌'} ${r.label.padEnd(16)} ` +
      `${r.seconds.toFixed(0).padStart(4)} s` +
      (r.code === 0 ? '' : `  — falló (código ${r.code}); repítelo con \`npm run ${r.script}\``),
  );
}

const failed = results.filter((r) => r.code !== 0);
console.log(
  `\n  ${results.length - failed.length}/${results.length} correctos en ` +
    `${((Date.now() - started) / 1000).toFixed(0)} s.`,
);

if (failed.length > 0) {
  // Se sale con error para que un cron o un CI se entere, pero DESPUÉS de haberlo
  // intentado todo: parar en el primero habría dejado sin actualizar deportes que no
  // tenían ningún problema.
  console.log(
    '\n  Los que fallaron no impidieron a los demás actualizarse. Lo más habitual es\n' +
      '  que la fuente esté caída un rato: repite solo ese deporte más tarde.',
  );
  process.exitCode = 1;
} else {
  console.log('\n  Comprueba que los datos entraron bien con `npm run verify:data`.');
}
