// `npm run auto` — que los datos se actualicen solos, sin que nadie escriba nada.
//
// ===========================================================================
// QUÉ SE ACTUALIZA SOLO YA, Y QUÉ NO
// ===========================================================================
// Con el servidor en marcha, las CUOTAS ya se refrescan solas: `startAutoRefresh` en
// server/src/index.ts pide las cinco a un ritmo que se ajusta al tamaño del plan. Esa
// parte no hace falta tocarla.
//
// Lo que NO se actualiza solo es el HISTÓRICO —los resultados de los partidos jugados—,
// y es el que envejece peor: una base de hace tres semanas abre igual, predice igual y
// no se queja. Enseña resultados de hace tres semanas con la misma seguridad que los de
// ayer, y los Elo que salen de ahí son los de hace tres semanas.
//
// Eso sí exige correr un comando, y exigirlo a diario es exigir que alguien se acuerde a
// diario. Esto lo pone en el calendario del sistema y se acabó.
//
// ===========================================================================
// POR QUÉ launchd Y NO cron EN UN MAC
// ===========================================================================
// cron existe en macOS pero está desaconsejado desde hace años, y tiene un defecto que
// aquí importa: si el portátil está dormido a la hora de la cita, esa cita SE PIERDE.
// launchd, con StartCalendarInterval, lanza el trabajo en cuanto la máquina despierta.
// Para un portátil que se cierra por la noche, es la diferencia entre actualizarse y no
// actualizarse nunca.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const C = { bold: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', amber: '\x1b[33m', off: '\x1b[0m' };

const args = process.argv.slice(2);
const quitar = args.includes('--quitar') || args.includes('--remove');
const estado = args.includes('--estado') || args.includes('--status');
const ahora = args.includes('--ahora') || args.includes('--now');
const horaArg = args.find((a) => a.startsWith('--hora='));
// Las 9 de la mañana: después de que hayan terminado los partidos de la noche anterior
// en Europa y en América, y a una hora en la que un portátil suele estar encendido.
const HORA = horaArg ? Number(horaArg.split('=')[1]) : 9;

const ETIQUETA = 'local.sports-predictor.datos';
const AGENTE = path.join(os.homedir(), 'Library', 'LaunchAgents', `${ETIQUETA}.plist`);
const GUION = path.join(ROOT, 'data', 'auto-actualizar.sh');
const LOG = path.join(ROOT, 'data', 'auto.log');

const esMac = process.platform === 'darwin';

function correr(cmd, argv) {
  return spawnSync(cmd, argv, { cwd: ROOT, stdio: 'inherit', shell: false });
}

// ---------------------------------------------------------------------------
// El guion que se ejecuta cada día
// ---------------------------------------------------------------------------
// Va a un fichero y no dentro del plist porque launchd arranca con un PATH mínimo que
// NO incluye nvm, Homebrew ni el instalador oficial de Node. Es el mismo problema que
// tiene un .command lanzado desde el Finder, y se resuelve igual: buscando Node antes de
// rendirse. Sin esto, el trabajo se ejecutaría todos los días y fallaría todos los días
// con «command not found: npm», en un log que nadie mira.
function escribirGuion() {
  const sh = `#!/bin/bash
# Generado por \`npm run auto\`. Se puede borrar; \`npm run auto --quitar\` lo hace solo.
set -u
cd "${ROOT}" || exit 1

# launchd no lee tu ~/.zshrc, así que aquí no existe el Node que instalaste con nvm.
if ! command -v npm >/dev/null 2>&1; then
  [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
fi
if ! command -v npm >/dev/null 2>&1; then
  for dir in /opt/homebrew/bin /usr/local/bin "$HOME/.volta/bin" "$HOME/.local/bin"; do
    [ -x "$dir/npm" ] && PATH="$dir:$PATH" && export PATH && break
  done
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "[$(date)] no encuentro npm; no actualizo" >&2
  exit 1
fi

echo "[$(date)] actualizando…"

# Primero la descarga rápida: 9 MB y unos segundos, contra los ~100 MB y dos minutos de
# reconstruirlo todo. Conserva tus apuestas y tu histórico de aciertos, y deja copia de
# la base anterior — eso lo garantiza fetch-data, no este guion.
if npm run fetch-data -- --force; then
  echo "[$(date)] listo (descarga rápida)"
  exit 0
fi

# Si nadie ha publicado la base todavía, se construye desde las fuentes. --skip-odds
# porque las cuotas las refresca el servidor en marcha: pedirlas aquí gastaría plan por
# duplicado y encima a una hora en la que la app puede no estar abierta.
echo "[$(date)] la descarga rápida no está disponible; reconstruyo desde las fuentes"
if npm run update-all -- --skip-odds; then
  echo "[$(date)] listo (reconstruida)"
else
  echo "[$(date)] FALLÓ. Corre \\\`npm run doctor\\\` cuando puedas." >&2
  exit 1
fi
`;
  fs.mkdirSync(path.dirname(GUION), { recursive: true });
  fs.writeFileSync(GUION, sh, { mode: 0o755 });
}

function plist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${ETIQUETA}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>${GUION}</string></array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>${HORA}</integer><key>Minute</key><integer>0</integer></dict>
  <!-- Si el portátil estaba dormido a la hora de la cita, launchd la lanza al
       despertar. Es la razón de usar launchd y no cron. -->
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
  <!-- Nunca a la vez que otra copia: una reconstrucción tarda dos minutos y dos a la
       vez escribirían sobre la misma base. -->
  <key>AbandonProcessGroup</key><false/>
</dict>
</plist>
`;
}

// ---------------------------------------------------------------------------
console.log(`\n${C.bold}Actualización automática de los datos${C.off}`);

if (!esMac) {
  // Ni se intenta: un plist de launchd en Linux no hace nada y decir «instalado» sería
  // mentir. Se da la línea de cron equivalente, que ahí sí funciona.
  console.log(
    `\n${C.amber}Esto instala un trabajo de launchd, que es de macOS.${C.off}\n\n` +
      `Estás en ${process.platform}. El equivalente con cron, si lo quieres a mano:\n\n` +
      `    (crontab -l 2>/dev/null; echo "0 ${HORA} * * * cd ${ROOT} && npm run fetch-data -- --force") | crontab -\n\n` +
      `${C.dim}Aviso: cron NO recupera las citas perdidas mientras la máquina estaba apagada.${C.off}\n`,
  );
  process.exit(0);
}

if (estado) {
  const puesto = fs.existsSync(AGENTE);
  console.log(puesto ? `  ${C.green}✓${C.off} instalado en ${AGENTE}` : `  ${C.dim}no está instalado${C.off}`);
  if (puesto) {
    const r = spawnSync('launchctl', ['list', ETIQUETA], { encoding: 'utf8' });
    console.log(r.status === 0 ? `  ${C.green}✓${C.off} cargado en launchd` : `  ${C.amber}·${C.off} NO cargado (reinstálalo: npm run auto)`);
  }
  if (fs.existsSync(LOG)) {
    const lineas = fs.readFileSync(LOG, 'utf8').trim().split('\n').slice(-6);
    console.log(`\n  ${C.dim}Últimas líneas de ${LOG}:${C.off}`);
    for (const l of lineas) console.log(`    ${C.dim}${l.slice(0, 100)}${C.off}`);
  } else {
    console.log(`\n  ${C.dim}Todavía no se ha ejecutado ninguna vez.${C.off}`);
  }
  process.exit(0);
}

if (quitar) {
  spawnSync('launchctl', ['unload', '-w', AGENTE], { stdio: 'ignore' });
  if (fs.existsSync(AGENTE)) fs.unlinkSync(AGENTE);
  if (fs.existsSync(GUION)) fs.unlinkSync(GUION);
  console.log(`\n  ${C.green}✓${C.off} quitado. Los datos ya no se actualizarán solos.\n`);
  process.exit(0);
}

if (!Number.isInteger(HORA) || HORA < 0 || HORA > 23) {
  console.error(`\n${C.red}✗ --hora tiene que ser un número de 0 a 23.${C.off}\n`);
  process.exit(1);
}

escribirGuion();
fs.mkdirSync(path.dirname(AGENTE), { recursive: true });
fs.writeFileSync(AGENTE, plist());
// `unload` antes de `load` para que reinstalar sobre una instalación anterior no falle
// con «service already loaded» y deje la vieja hora puesta.
spawnSync('launchctl', ['unload', '-w', AGENTE], { stdio: 'ignore' });
const carga = spawnSync('launchctl', ['load', '-w', AGENTE], { encoding: 'utf8' });

if (carga.status !== 0) {
  console.error(
    `\n${C.red}✗ launchd no aceptó el trabajo.${C.off}\n${(carga.stderr || '').trim()}\n\n` +
      `El fichero está en ${AGENTE}. Puedes intentarlo a mano:\n` +
      `    launchctl load -w "${AGENTE}"\n`,
  );
  process.exit(1);
}

console.log(
  `\n  ${C.green}✓${C.off} listo. Los datos se actualizarán solos todos los días a las ${String(HORA).padStart(2, '0')}:00.\n\n` +
    `  ${C.dim}Qué hace: descarga la base ya construida (9 MB, unos segundos) y, si todavía\n` +
    `  nadie la ha publicado, la reconstruye desde las fuentes. Conserva tus apuestas y\n` +
    `  tu histórico de aciertos, y deja copia de la anterior. No gasta peticiones de\n` +
    `  The Odds API: las cuotas las refresca el servidor mientras la app está abierta.${C.off}\n\n` +
    `  Si el portátil está dormido a esa hora, se ejecuta al despertar.\n\n` +
    `  ${C.bold}npm run auto -- --estado${C.off}   ver si funciona y qué hizo la última vez\n` +
    `  ${C.bold}npm run auto -- --hora=7${C.off}   cambiar la hora\n` +
    `  ${C.bold}npm run auto -- --quitar${C.off}   desinstalarlo\n`,
);

if (ahora) {
  console.log(`  ${C.dim}Ejecutándolo una vez ahora…${C.off}\n`);
  correr('/bin/bash', [GUION]);
}
