#!/usr/bin/env node
// Escáner de secretos sin dependencias. Complementa a gitleaks (si está instalado, el hook
// lo usa primero) y es lo que corre siempre: en el hook de pre-commit, en CI y en el doctor.
//
//   node scripts/secret-scan.mjs --staged    lo que está a punto de commitearse
//   node scripts/secret-scan.mjs --tracked   todos los ficheros rastreados por git
//   node scripts/secret-scan.mjs --json      salida para el doctor
//   --root <dir>                              otro repositorio (los tests)
//
// En --staged se lee lo que hay en el ÍNDICE (`git show :<ruta>`), no el fichero del disco: es
// lo que va al commit. Antes se leía el disco, así que un `git add -p` parcial o un secreto ya
// borrado del disco pero no del índice pasaban (D16 de la revisión del 8 de octubre de 2026).
//
// Exit 1 si encuentra algo. Lo que busca son FORMAS de clave, no valores concretos: la
// clave de The Odds API son 32 hex, las de Anthropic empiezan por sk-ant-, etc. Y comprueba
// que ningún .env esté rastreado.

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const args = new Set(argv);
const JSON_OUT = args.has('--json');
const MODO = args.has('--staged') ? 'staged' : 'tracked';
const iRoot = argv.indexOf('--root');
const ROOT = iRoot >= 0 && argv[iRoot + 1] ? path.resolve(argv[iRoot + 1]) : path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

/** Patrones. Cada uno con el contexto que evita falsos positivos. */
const PATRONES = [
  { nombre: 'The Odds API (32 hex junto a su variable)', re: /(ODDS_API_KEY|THE_ODDS_API_KEY|apiKey)\s*[=:]\s*["']?[0-9a-f]{32}\b/g },
  { nombre: 'Anthropic', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { nombre: 'Telegram bot', re: /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/g },
  { nombre: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { nombre: 'Clave privada', re: /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/g },
  { nombre: 'Token GitHub', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { nombre: 'Slack webhook', re: /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]+/g },
  { nombre: 'Discord webhook', re: /https:\/\/discord(app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g },
  { nombre: 'Contraseña en claro junto a su variable', re: /(APP_PASSWORD|SMTP_PASS|BACKUP_S3_SECRET_KEY|TOTP_SECRET)\s*=\s*["']?[^\s"'#]{8,}/g },
];

/** Ficheros que legítimamente parecen tener claves (ejemplos, tests con valores falsos). */
const EXCLUIR = [/^\.env\.example$/, /^web\/public\/flags\//, /^data\/seed\//, /\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|db|zip|gz)$/i, /^package-lock\.json$/, /^scripts\/secret-scan\.mjs$/, /^\.gitleaks\.toml$/];

function listar() {
  const cmd = MODO === 'staged' ? 'git diff --cached --name-only --diff-filter=ACMR' : 'git ls-files';
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

const hallazgos = [];
const ficheros = listar();

// 1. Ningún .env (ni variante con secretos) rastreado o a punto de commitearse.
for (const f of ficheros) {
  if (/^(.*\/)?\.env(\.local|\.production|\.development)?$/.test(f) || /^(.*\/)?\.env\.[^./]+\.local$/.test(f)) {
    hallazgos.push({ fichero: f, linea: 0, patron: 'fichero .env rastreado por git' });
  }
}

// 2. Patrones en el contenido.
for (const f of ficheros) {
  if (EXCLUIR.some((re) => re.test(f))) continue;
  const ruta = path.join(ROOT, f);
  let texto;
  try {
    if (MODO === 'staged') {
      // Lo que va al commit: el contenido del índice.
      // Sin shell: el nombre del fichero va como argumento, tal cual.
      texto = execFileSync('git', ['show', `:${f}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 4_000_000, stdio: ['ignore', 'pipe', 'ignore'] });
      if (texto.length > 2_000_000) continue;
    } else {
      const st = fs.statSync(ruta);
      if (!st.isFile() || st.size > 2_000_000) continue;
      texto = fs.readFileSync(ruta, 'utf8');
    }
  } catch {
    continue;
  }
  if (texto.includes('\u0000')) continue; // binario
  const lineas = texto.split('\n');
  for (const p of PATRONES) {
    lineas.forEach((l, i) => {
      p.re.lastIndex = 0;
      if (p.re.test(l) && !/secret-scan:ignore/.test(l)) hallazgos.push({ fichero: f, linea: i + 1, patron: p.nombre });
    });
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify({ modo: MODO, ficheros: ficheros.length, hallazgos }));
} else if (hallazgos.length === 0) {
  console.log(`secret-scan: ${ficheros.length} fichero(s) (${MODO}), sin secretos.`);
} else {
  console.error(`secret-scan: ${hallazgos.length} posible(s) secreto(s) en ${MODO}:`);
  for (const h of hallazgos) console.error(`  ${h.fichero}${h.linea ? `:${h.linea}` : ''}  ${h.patron}`);
  console.error('\nSi es un falso positivo, añade `secret-scan:ignore` al final de esa línea. Si es real: quítalo, y ROTA la clave.');
}
process.exit(hallazgos.length === 0 ? 0 : 1);
