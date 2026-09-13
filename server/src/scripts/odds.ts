// CLI: `npm run odds`
//
// ===========================================================================
// UN COMANDO PARA «QUIERO LAS CUOTAS REALES»
// ===========================================================================
// Ya existían `update-all` y `doctor`, y ninguno contesta esa frase:
//
//   · `update-all` reingiere el HISTÓRICO de los cinco deportes —un centenar de megas y
//     dos minutos— para acabar refrescando las cuotas al final. Si lo único que ha
//     cambiado es que ahora hay una clave en el `.env`, ese histórico ya estaba bien y se
//     vuelve a bajar entero para nada.
//   · `doctor` diagnostica pero no arregla, a propósito.
//
// Esto hace la parte que falta: pedir las cuotas de los cinco deportes y decir, deporte a
// deporte, si han llegado y —cuando no— POR QUÉ no, con la causa que la propia ingesta
// registra (ver `oddsReason.ts`).
//
// ===========================================================================
// LO QUE CUESTA, DICHO ANTES DE GASTARLO
// ===========================================================================
// Cinco peticiones del plan, una por deporte. Con el plan gratuito de 500 al mes eso es
// el 1 %. Se dice al empezar y se recuerda al terminar cuántas quedan, porque el número
// de peticiones es el único recurso de este proyecto que se agota de verdad.

import { env } from '../config.ts';
import { refreshOdds as refreshTennis } from '../ingest/odds.ts';
import { refreshFootballOdds } from '../football/ingest/odds.ts';
import { refreshBasketballOdds } from '../basketball/ingest/odds.ts';
import { refreshBaseballOdds } from '../baseball/ingest/odds.ts';
import { refreshOdds as refreshNfl } from '../nfl/ingest/odds.ts';
import { readOddsReason, REASON_TEXT, type SportPrefix } from '../oddsReason.ts';
import { getQuota } from '../oddsQuota.ts';

const C = { bold: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', amber: '\x1b[33m', off: '\x1b[0m' };

const DEPORTES: { nombre: string; prefijo: SportPrefix; run: () => Promise<{ source: string; count: number }> }[] = [
  { nombre: 'Fútbol', prefijo: 'fb_', run: refreshFootballOdds },
  { nombre: 'Baloncesto', prefijo: 'bb_', run: refreshBasketballOdds },
  { nombre: 'Béisbol', prefijo: 'bsb_', run: refreshBaseballOdds },
  {
    nombre: 'NFL',
    prefijo: 'naf_',
    // La NFL es la excepción: no inventa cuotas nunca. Su `refreshOdds` devuelve
    // CUÁNTOS partidos consiguió precio, y cero no significa «demostración» sino «no
    // hay línea publicada» — su calendario sigue siendo real. Por eso se adapta aquí en
    // vez de cambiar su firma: el resto del proyecto depende de que devuelva un número.
    run: async () => {
      const n = await refreshNfl();
      return { source: n > 0 ? 'live' : 'schedule', count: n };
    },
  },
  { nombre: 'Tenis', prefijo: '', run: refreshTennis },
];

console.log(`\n${C.bold}Pidiendo cuotas reales a The Odds API${C.off}`);

if (!env.oddsApiKey) {
  // Antes de gastar un segundo: sin clave esto no puede funcionar, y seguir adelante
  // para acabar diciendo cinco veces «no hay clave» es hacerle perder el tiempo a
  // alguien que ya tiene un problema.
  console.error(
    `\n${C.red}✗ No hay ODDS_API_KEY.${C.off}\n\n` +
      'Sin clave no hay cuotas reales que pedir. Ponla en el fichero .env de la raíz:\n\n' +
      "    echo 'ODDS_API_KEY=tu-clave' >> .env\n\n" +
      'y vuelve a correr esto. `npm run doctor` comprueba que la clave funciona sin gastar\n' +
      'ni una petición.\n',
  );
  process.exit(1);
}

console.log(`${C.dim}Cuesta 5 peticiones de tu plan, una por deporte.${C.off}\n`);

const resultados: {
  nombre: string; ok: boolean; linea: string; causa: string | null; detalle: string; nada?: boolean;
}[] = [];

for (const d of DEPORTES) {
  // El nombre se imprime DESPUÉS de correr, no antes. Las ingestas escriben sus propios
  // avisos en stderr mientras trabajan, y con el nombre ya escrito esos avisos caían en
  // medio de la línea y la partían en dos.
  try {
    const r = await d.run();
    const { reason, detail } = readOddsReason(d.prefijo);
    const vivo = r.source === 'live';
    resultados.push({
      nombre: d.nombre,
      ok: vivo,
      linea: vivo ? `${r.count} partidos con cuotas REALES` : `${r.count} de demostración`,
      causa: vivo ? null : (reason ?? null),
      detalle: detail,
      // La NFL sin línea publicada no entra en «qué hacer»: no hay nada que arreglar.
      // Sus partidos siguen siendo reales, solo que sin precio — y meterla en la lista
      // de problemas mandaría a buscar una avería que no existe.
      nada: r.source === 'schedule',
    });
    const nombre = `  ${d.nombre.padEnd(11)}`;
    console.log(
      vivo
        ? `${nombre} ${C.green}✓${C.off} ${r.count} partidos con cuotas reales`
        : r.source === 'schedule'
          ? `${nombre} ${C.amber}·${C.off} sin línea publicada (el calendario sigue siendo real)`
          : `${nombre} ${C.amber}·${C.off} ${r.count} de demostración`,
    );
    if (!vivo && reason) {
      console.log(`${' '.repeat(14)}${C.dim}↳ ${REASON_TEXT[reason]}${C.off}`);
      if (detail) console.log(`${' '.repeat(16)}${C.dim}${detail.slice(0, 160)}${C.off}`);
    }
  } catch (e) {
    // Un deporte que revienta NO puede parar a los otros cuatro: cada uno habla con un
    // endpoint distinto del proveedor y el fallo de uno no dice nada de los demás.
    const msg = (e as Error).message;
    resultados.push({ nombre: d.nombre, ok: false, linea: 'error', causa: 'error', detalle: msg });
    console.log(`  ${d.nombre.padEnd(11)} ${C.red}✗${C.off} error: ${msg.slice(0, 90)}`);
  }
}

// ===========================================================================
// EL VEREDICTO
// ===========================================================================
// Una sola frase al final, porque es lo único que se lee cuando el comando tarda.
const conCuotas = resultados.filter((r) => r.ok);
const q = getQuota();

console.log('\n' + '─'.repeat(62));
if (conCuotas.length === DEPORTES.length) {
  console.log(`${C.green}${C.bold}✓ Los cinco deportes tienen cuotas reales.${C.off}`);
} else if (conCuotas.length > 0) {
  console.log(
    `${C.amber}${C.bold}Parcial:${C.off} ${conCuotas.length} de ${DEPORTES.length} con cuotas reales ` +
      `(${conCuotas.map((r) => r.nombre).join(', ')}).`,
  );
} else {
  console.log(`${C.red}${C.bold}Ningún deporte ha conseguido cuotas reales.${C.off}`);
}

// Y qué hacer con los que no, agrupado por causa: cinco líneas iguales no ayudan, y las
// causas piden cosas distintas — una se arregla y otra solo se espera.
const sinCuotas = resultados.filter((r) => !r.ok && !r.nada);
if (sinCuotas.length > 0) {
  const porCausa = new Map<string, string[]>();
  for (const r of sinCuotas) {
    const k = r.causa ?? 'desconocida';
    porCausa.set(k, [...(porCausa.get(k) ?? []), r.nombre]);
  }
  console.log('');
  for (const [causa, nombres] of porCausa) {
    console.log(`  ${C.bold}${nombres.join(', ')}${C.off}`);
    switch (causa) {
      case 'sin_eventos':
        console.log(`    ${C.dim}No hay ningún partido con precio publicado. NO es un fallo:`);
        console.log(`    entre jornadas y entre torneos es lo normal. Vuelve a probar en unos días.${C.off}`);
        break;
      case 'sin_ligas':
        console.log(`    ${C.dim}El proveedor no ofrece ninguna de las ligas configuradas ahora mismo.`);
        console.log(`    Si la liga SÍ está en juego, es que le cambió la clave de deporte:`);
        console.log(`    compara la lista de arriba con los oddsSportKeys de config/*.json.${C.off}`);
        break;
      case 'fuente_falla':
        console.log(`    ${C.dim}El proveedor no contestó. Si el detalle dice 401, la clave no vale;`);
        console.log(`    si dice 429 o la cuota está a 0, es el plan del mes. \`npm run doctor\`${C.off}`);
        break;
      case 'sin_clave':
        console.log(`    ${C.dim}Falta ODDS_API_KEY en el .env de la raíz.${C.off}`);
        break;
      default:
        console.log(`    ${C.dim}Sin causa registrada. \`npm run doctor\` lo desglosa.${C.off}`);
    }
  }
}

if (q.remaining != null) {
  console.log(`\n${C.dim}Peticiones restantes este mes: ${q.remaining}${C.off}`);
}
console.log(`${C.dim}Reinicia la app para verlas: npm run go${C.off}\n`);

// Sale con error solo si NINGUNO lo consiguió. Un parcial es un resultado legítimo —
// tener cuotas de tres deportes y no de los otros dos suele ser el calendario, no un
// fallo— y devolver error ahí rompería cualquier script que encadene esto.
if (conCuotas.length === 0) process.exit(1);
