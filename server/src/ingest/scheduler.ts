// Resultados programados en el servidor (Fase 2B.8).
//
// «¿Acertó?» enseñaba días vacíos y casi nunca era por falta de partidos: era el archivo de
// resultados sin actualizar, porque bajarlo exigía acordarse de `npm run update-results`. El
// servidor lo hace ahora solo, cada RESULTS_REFRESH_HOURS horas (6 por defecto; 0 lo apaga;
// interruptor `datos.resultadosProgramados`), y la primera pasada cinco minutos después de
// arrancar.
//
// Deporte a deporte y CADA UNO EN SU PROCESO HIJO: una fuente caída no tumba a las demás, y la
// memoria que necesita rehacer ratings de una liga vuelve al sistema al terminar en vez de
// quedarse en el servidor. Sin cuotas (`--skip-odds`): esto no gasta ni un crédito. Cada
// deporte deja su fila en ingestion_runs desde su propio proceso; aquí queda además la del
// ciclo entero (`results:ciclo`).

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { conRegistro } from './runs.ts';
import { horasDesdeEntorno as horasAcotadas } from '../scheduler/horas.ts';

export const PASOS_RESULTADOS = [
  { nombre: 'fútbol', script: 'update-data:fb' },
  { nombre: 'baloncesto', script: 'update-data:bb' },
  { nombre: 'béisbol', script: 'update-data:bsb' },
  { nombre: 'NFL', script: 'update-data:naf' },
  { nombre: 'NHL', script: 'update-data:nhl' },
  { nombre: 'UFC', script: 'update-data:ufc' },
] as const;

export const PRIMERA_PASADA_MIN = 5;
export const HORAS_POR_DEFECTO = 6;
/** Un deporte que tarda más que esto se mata: una fuente colgada no puede retener el ciclo. */
export const TIEMPO_MAX_MIN = 25;

export function horasDesdeEntorno(entorno: NodeJS.ProcessEnv = process.env): number {
  return horasAcotadas(entorno, 'RESULTS_REFRESH_HOURS', HORAS_POR_DEFECTO);
}

export interface ResultadoPaso {
  nombre: string;
  script: string;
  ok: boolean;
  codigo: number | null;
  ms: number;
  /** Las últimas líneas de salida, para el log; nunca entera. */
  cola: string;
}

export type Lanzador = (script: string) => Promise<{ codigo: number | null; salida: string }>;

const SERVIDOR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Lanza `npm run <script> -- --skip-odds` en el directorio del servidor y espera a que acabe. */
export const lanzarNpm: Lanzador = (script) =>
  new Promise((resolve) => {
    const hijo = spawn('npm', ['run', script, '--', '--skip-odds'], { cwd: SERVIDOR, shell: process.platform === 'win32', env: { ...process.env, FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let salida = '';
    const acumula = (b: Buffer) => {
      salida = (salida + b.toString('utf8')).slice(-4000);
    };
    hijo.stdout.on('data', acumula);
    hijo.stderr.on('data', acumula);
    const t = setTimeout(() => hijo.kill('SIGTERM'), TIEMPO_MAX_MIN * 60_000);
    hijo.on('close', (codigo) => {
      clearTimeout(t);
      resolve({ codigo, salida });
    });
    hijo.on('error', (e) => {
      clearTimeout(t);
      resolve({ codigo: null, salida: e.message });
    });
  });

/** Un ciclo: los cinco deportes de equipo en orden, uno a uno. Nunca lanza: devuelve qué pasó. */
export async function cicloResultados(lanzar: Lanzador = lanzarNpm, log: (m: string) => void = () => {}): Promise<ResultadoPaso[]> {
  const out: ResultadoPaso[] = [];
  await conRegistro('results:ciclo', async () => {
    for (const p of PASOS_RESULTADOS) {
      const t0 = Date.now();
      const r = await lanzar(p.script);
      const ok = r.codigo === 0;
      const cola = r.salida.trim().split('\n').slice(-3).join(' | ').slice(0, 300);
      out.push({ nombre: p.nombre, script: p.script, ok, codigo: r.codigo, ms: Date.now() - t0, cola });
      log(ok ? `Resultados de ${p.nombre} al día (${Math.round((Date.now() - t0) / 1000)} s).` : `Resultados de ${p.nombre}: falló (código ${r.codigo}) — ${cola}`);
    }
    const fallidos = out.filter((x) => !x.ok);
    if (fallidos.length === out.length) throw new Error(`fallaron los ${out.length} deportes: ${fallidos.map((f) => f.cola).join(' / ')}`);
    return { rowsUpdated: out.length - fallidos.length, detail: fallidos.length ? `fallaron: ${fallidos.map((f) => f.nombre).join(', ')}` : 'los cinco deportes al día' };
  }).catch(() => {
    // Ya quedó en ingestion_runs como error; el ciclo no puede tumbar el servidor.
  });
  return out;
}

export interface Programado {
  parar: () => void;
}

/**
 * Programa el ciclo: primera pasada a los PRIMERA_PASADA_MIN minutos, después cada `horas`.
 * Un ciclo no se solapa con otro: si el anterior sigue, el tic se salta.
 */
export function programarResultados(opts: { horas: number; lanzar?: Lanzador; log?: (m: string) => void; despues?: (r: ResultadoPaso[]) => void }): Programado | null {
  if (!(opts.horas > 0)) return null;
  let enMarcha = false;
  const correr = async () => {
    if (enMarcha) {
      opts.log?.('Resultados: el ciclo anterior sigue en marcha; se salta este tic.');
      return;
    }
    enMarcha = true;
    try {
      const r = await cicloResultados(opts.lanzar, opts.log);
      opts.despues?.(r);
    } finally {
      enMarcha = false;
    }
  };
  const primero = setTimeout(correr, PRIMERA_PASADA_MIN * 60_000);
  primero.unref();
  const cada = setInterval(correr, opts.horas * 3_600_000);
  cada.unref();
  return {
    parar: () => {
      clearTimeout(primero);
      clearInterval(cada);
    },
  };
}
