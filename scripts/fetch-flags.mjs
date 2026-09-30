// Las banderas, una vez, al repo.
//
// ===========================================================================
// POR QUÉ SE DESCARGAN Y SE COMMITEAN EN VEZ DE ENLAZARLAS A UN CDN
// ===========================================================================
// Enlazar `https://flagcdn.com/w40/es.png` desde el `<img>` es una línea de código y
// cero bytes en el repo. Y tiene tres problemas que se pagan justo cuando molesta:
//
//   1. LA APP DEJA DE FUNCIONAR SIN INTERNET. El resto no lo necesita: la base es local
//      y el modelo también, así que un avión o una wifi de hotel no rompen nada. Pintar
//      las banderas desde fuera introduciría la primera dependencia de red para ver una
//      pantalla que ya está calculada.
//
//   2. NADIE COMPRUEBA UN CDN QUE FALLA DENTRO DE UN AÑO. Si el host cambia el esquema
//      de URLs o se apaga, las banderas desaparecen y no salta ningún check, porque el
//      fallo pasa en el navegador de quien mira, no en la build.
//
//   3. NO SE PUEDE VERIFICAR AL ESCRIBIRLO. Con los ficheros en `public/`, `verify:data`
//      puede afirmar que TODOS los países de la base tienen su bandera en disco. Con una
//      URL remota, lo más que se puede afirmar es que la cadena está bien formada, que es
//      precisamente el error que se quiere cazar: `RSA` → `rs.svg` está perfectamente
//      bien formada y es la bandera de Serbia.
//
// El coste son 1,4 MB de SVG en el repo, que el navegador pide en diferido y cachea.
// El reparto es muy desigual y vale saberlo: la MEDIANA es de 743 bytes, pero seis
// banderas con escudo de armas detallado (Serbia 180 KB, Bolivia 104, México 84, España
// 80, El Salvador 76, Montenegro 56) se llevan 580 KB entre ellas. A 11 píxeles de alto
// ese detalle no se ve, así que son bytes desperdiciados — pero solo se piden cuando en
// pantalla hay alguien de ese país, y una vez pedidos se quedan en la caché. Si algún
// día molesta, lo que hay que hacer es pasarles `svgo` al bajarlas, no cambiar de fuente.
//
// ===========================================================================
// LA FUENTE
// ===========================================================================
// `lipis/flag-icons`, licencia MIT. Se usa por dos razones concretas: está en
// raw.githubusercontent.com (el único host alcanzable desde el entorno donde se escribió
// esto, así que se pudo comprobar bandera a bandera) y nombra los ficheros por ISO-3166
// alpha-2, que es exactamente la clave que devuelve `countries.ts`.
//
// Las banderas nacionales no llevan copyright; la licencia cubre estos dibujos concretos
// en SVG. El fichero LICENSE se guarda al lado de las banderas, que es lo que pide.
//
// CLI:
//   node scripts/fetch-flags.mjs            baja las que falten
//   node scripts/fetch-flags.mjs --force    vuelve a bajarlas todas

import { mkdir, writeFile, readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outDir = join(root, 'web', 'public', 'flags');

const BASE = 'https://raw.githubusercontent.com/lipis/flag-icons';
/**
 * Una etiqueta fija, no `main`.
 *
 * Con `main`, dos personas que corran esto en fechas distintas se bajan dibujos
 * distintos y el diff del repo cambia sin que nadie haya tocado nada. Con la versión
 * clavada, el resultado es el mismo hoy y en dos años, y subirla es una decisión visible
 * en un commit.
 *
 * Para actualizarla: mira la `version` de
 * https://raw.githubusercontent.com/lipis/flag-icons/main/package.json, pon aquí `v` + esa
 * versión y corre el script con `--force`.
 */
const REF = 'v7.5.0';

const force = process.argv.includes('--force');

/** Los ISO-2 que hacen falta, leídos de la ÚNICA tabla que los define. */
async function wanted() {
  const raw = await readFile(join(root, 'config', 'countries.json'), 'utf8');
  const table = JSON.parse(raw);
  const codes = Object.values(table).map((c) => c.iso2);
  // La tabla es el juego completo del COI: si de repente son cuatro, alguien la ha
  // vaciado o la ha movido, y bajar cuatro banderas «con éxito» sería el peor resultado
  // posible — la pantalla se quedaría casi entera sin banderas y el script diría que sí.
  if (codes.length < 150) {
    throw new Error(
      `config/countries.json solo tiene ${codes.length} países y la tabla completa pasa ` +
        'de 200. Algo la ha truncado.',
    );
  }
  for (const c of codes) {
    if (!/^[a-z]{2}$/.test(c)) {
      throw new Error(`"${c}" no es un ISO-3166 alpha-2 en minúscula.`);
    }
  }
  // Las que no son países del COI y hacen falta para las cabeceras de liga: la UE (la
  // Euroliga y la Champions juegan bajo ella) y las naciones británicas, que en el COI
  // no existen por separado pero son el «país» de la Premier. La lista gemela vive en
  // `EXTRA_FLAGS` de web/src/lib/countries.ts.
  const extras = ['eu', 'gb-eng', 'gb-sct', 'gb-wls'];
  return [...new Set([...codes, ...extras])].sort();
}

async function download(iso2) {
  const url = `${BASE}/${REF}/flags/4x3/${iso2}.svg`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${iso2}: HTTP ${res.status} en ${url}`);
  }
  const svg = await res.text();
  if (!svg.startsWith('<svg')) {
    throw new Error(`${iso2}: la respuesta no es un SVG (empieza por "${svg.slice(0, 20)}")`);
  }
  await writeFile(join(outDir, `${iso2}.svg`), svg);
  return svg.length;
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const codes = await wanted();
  console.log(`${codes.length} banderas en la tabla · destino web/public/flags/\n`);

  let bajadas = 0;
  let saltadas = 0;
  let bytes = 0;
  const fallos = [];

  for (const iso2 of codes) {
    const path = join(outDir, `${iso2}.svg`);
    if (!force && existsSync(path)) {
      saltadas++;
      bytes += (await stat(path)).size;
      continue;
    }
    try {
      bytes += await download(iso2);
      bajadas++;
      if (bajadas % 25 === 0) process.stdout.write(`  ${bajadas} bajadas…\n`);
    } catch (e) {
      fallos.push(String(e instanceof Error ? e.message : e));
    }
  }

  // La licencia va al lado de lo que cubre, no en un README que nadie abre.
  const licPath = join(outDir, 'LICENSE.txt');
  if (force || !existsSync(licPath)) {
    const res = await fetch(`${BASE}/${REF}/LICENSE`);
    if (res.ok) await writeFile(licPath, await res.text());
  }

  const files = (await readdir(outDir)).filter((f) => f.endsWith('.svg'));
  console.log(
    `\n${bajadas} bajadas · ${saltadas} ya estaban · ${files.length} SVG en disco · ` +
      `${(bytes / 1024).toFixed(0)} KB`,
  );

  if (fallos.length > 0) {
    // Un 404 aquí casi siempre significa un ISO-2 mal escrito en la tabla, y eso es un
    // país que se pintaría sin bandera para siempre. Se falla, no se avisa.
    console.error(`\n✗ ${fallos.length} banderas no se pudieron bajar:`);
    for (const f of fallos) console.error('   ' + f);
    console.error(
      '\nComprueba el código ISO-3166 alpha-2 de esos países en web/src/lib/countries.ts.',
    );
    process.exit(1);
  }
  console.log('✓ todas las banderas de la tabla están en disco.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
