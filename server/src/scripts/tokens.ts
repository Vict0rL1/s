// CLI: `npm run tokens` — cuántos tokens ha gastado el asistente de la app.
//
// Contesta a una pregunta concreta y limitada: lo que ha consumido el ENRUTADOR CON
// MODELO de esta aplicación. No sabe nada de ninguna otra cosa que hables con un modelo
// fuera de aquí, y lo dice, porque un contador que parece contarlo todo y solo cuenta una
// parte es peor que no tener ninguno.

import { usoTokens, reiniciarUso } from '../ask/llmUsage.ts';
import { env } from '../config.ts';

const C = { bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', amber: '\x1b[33m', off: '\x1b[0m' };

if (process.argv.includes('--reiniciar')) {
  reiniciarUso();
  console.log(`\n  ${C.green}✓${C.off} contador a cero.\n`);
  process.exit(0);
}

const u = usoTokens();
const mil = (n: number) => n.toLocaleString('es');

console.log(`\n${C.bold}Tokens gastados por el asistente de esta app${C.off}`);

if (!env.anthropicApiKey) {
  console.log(
    `\n  ${C.dim}No hay ANTHROPIC_API_KEY, así que el enrutador con modelo está apagado y\n` +
      `  no gasta nada. El asistente funciona igual: enruta con reglas.${C.off}`,
  );
}

if (u.llamadas === 0) {
  console.log(`\n  ${C.dim}Ninguna llamada registrada todavía.${C.off}\n`);
} else {
  console.log('');
  console.log(`  llamadas          ${mil(u.llamadas)}`);
  console.log(`  tokens de entrada ${mil(u.entrada)}`);
  console.log(`  tokens de salida  ${mil(u.salida)}`);
  console.log(`  ${C.bold}total             ${mil(u.entrada + u.salida)}${C.off}`);
  console.log(`  ${C.dim}media por pregunta ${Math.round((u.entrada + u.salida) / u.llamadas)}${C.off}`);
  if (u.desde) console.log(`  ${C.dim}desde ${new Date(u.desde).toLocaleString('es')}${C.off}`);

  if (u.coste !== null && u.precios) {
    console.log(
      `\n  coste estimado    ${u.coste.toFixed(4)}` +
        `  ${C.dim}(a ${u.precios.entrada}/M entrada y ${u.precios.salida}/M salida)${C.off}`,
    );
    console.log(
      `  ${C.dim}Es una ESTIMACIÓN con los precios que pusiste tú en el .env, no una\n` +
        `  medición: los tokens los cuenta el proveedor, el precio lo pones tú.${C.off}`,
    );
  } else {
    console.log(
      `\n  ${C.amber}Sin coste:${C.off} ${C.dim}los tokens son una medida, el precio no — depende del\n` +
        `  modelo, del plan y de la fecha. Si quieres verlo en dinero, pon en el .env:\n` +
        `    LLM_PRECIO_ENTRADA=<precio por millón>\n` +
        `    LLM_PRECIO_SALIDA=<precio por millón>${C.off}`,
    );
  }
}

console.log(
  `\n${C.dim}Esto cuenta SOLO lo que gasta esta aplicación. Lo que gastes hablando con un\n` +
    `modelo por tu cuenta no aparece aquí y no puede aparecer.${C.off}\n`,
);
