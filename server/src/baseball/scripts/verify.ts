// CLI: `npm run verify:bsb [-- --season 2011]`
//
// Re-runs the check that the run counter is right.
//
// The whole baseball model rests on a parser that counts runs off play-by-play
// text, because Retrosheet event files carry the starting pitchers but not the
// final score. A claim that such a parser is correct is worth nothing unless it
// can be re-run, so this is a command rather than a sentence in a document:
// parse a season of event files, compare every game against Retrosheet's own
// official game log, and print the disagreements.
//
// It is also the canary. The day the upstream format shifts, this is what says
// so — instead of the model quietly drifting half a run per game.

import { verifyAgainstGamelog } from '../ingest/retrosheet.ts';

async function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--season');
  const season = i >= 0 ? Number(argv[i + 1]) : 2011;

  console.log(`\n⚾ Verificando el contador de carreras contra el gamelog oficial de ${season}…`);
  const r = await verifyAgainstGamelog(season);

  if (r.checked === 0) {
    throw new Error(
      'No se pudo emparejar ningún partido. ¿La temporada pedida tiene gamelog de verificación? ' +
        '(el fichero de referencia es el de 2011)',
    );
  }

  const pct = (n: number) => ((n / r.checked) * 100).toFixed(2);
  console.log(`\n  partidos comparados:  ${r.checked}`);
  console.log(`  marcador exacto:      ${r.exact}  (${pct(r.exact)}%)`);
  console.log(`  abridores correctos:  ${r.pitchersOk}  (${pct(r.pitchersOk)}%)`);

  if (r.mismatches.length > 0) {
    console.log(`\n  ⚠️  ${r.mismatches.length} discrepancias:`);
    for (const m of r.mismatches.slice(0, 20)) console.log(`     ${m}`);
    if (r.mismatches.length > 20) console.log(`     … y ${r.mismatches.length - 20} más`);
    console.log(
      '\n  Un fallo aquí NO es cosmético: un error sistemático de una carrera en el 1% de\n' +
        '  los partidos desplaza todos los totales que produce el modelo.',
    );
    process.exitCode = 1;
    return;
  }
  console.log('\n✅ Todos los marcadores y todos los abridores coinciden con el registro oficial.\n');
}

main().catch((err) => {
  console.error('\n❌ verify:bsb falló:', err.message);
  process.exit(1);
});
