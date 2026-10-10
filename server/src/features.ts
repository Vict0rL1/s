// Los interruptores de funciones (config/features.json).
//
// Una función nueva se entrega detrás de un flag: así se puede apagar sin desplegar código,
// y la pantalla sabe qué enseñar. Las «opcionales» dependen además de una variable de
// entorno (una clave, un secreto): con el flag encendido y la variable vacía, la función
// está DISPONIBLE pero no ACTIVA, y las dos cosas se distinguen aquí para que la pantalla
// pueda decir «falta TOTP_SECRET» en vez de esconder la opción sin explicación.

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.ts';

export interface Feature {
  on: boolean;
  descripcion: string;
  /** Variable de entorno de la que depende, si es opcional. */
  opcional?: string;
}

interface Fichero {
  features: Record<string, Feature>;
}

let cache: Record<string, Feature> | null = null;

/** Anulaciones hechas desde Ajustes (Fase 5.7), guardadas en `settings` como un JSON. */
export const CLAVE_ANULACIONES = 'features.anulaciones';

/**
 * Los interruptores que SOLO cambian al arrancar (lote A, A3): la puerta y las cabeceras de
 * seguridad. Antes `PATCH /api/features/auth.totp {on:false}` apagaba el segundo factor desde
 * la propia API, y `auth.sesiones` en false dejaba el login en 404. Ahora la API los rechaza,
 * una anulación guardada para ellos se ignora, y Ajustes no los enseña.
 */
export function soloArranque(nombre: string): boolean {
  return nombre.startsWith('auth.') || nombre.startsWith('seguridad.');
}
let anulaciones: Record<string, boolean> | null = null;

function cargarAnulaciones(): Record<string, boolean> {
  if (anulaciones) return anulaciones;
  try {
    anulaciones = lector ? (JSON.parse(lector(CLAVE_ANULACIONES) ?? '{}') as Record<string, boolean>) : {};
  } catch {
    anulaciones = {};
  }
  return anulaciones;
}

/**
 * De dónde se leen las anulaciones guardadas. Lo fija app.ts con `getMeta` al arrancar: así
 * features.ts no importa la base (muchos scripts leen los interruptores sin abrirla).
 */
let lector: ((clave: string) => string | null) | null = null;
export function conLectorDeAnulaciones(f: (clave: string) => string | null): void {
  lector = f;
  anulaciones = null;
}

/** Fija (o quita, con null) la anulación de un interruptor. Devuelve el estado resultante. */
export function fijarAnulacion(nombre: string, on: boolean | null, guardar: (json: string) => void): Record<string, boolean> {
  if (soloArranque(nombre)) throw new Error(`${nombre} solo se cambia al arrancar (config/features.json)`);
  const a = { ...cargarAnulaciones() };
  if (on == null) delete a[nombre];
  else a[nombre] = on;
  anulaciones = a;
  guardar(JSON.stringify(a));
  return a;
}

export function leerFeatures(): Record<string, Feature> {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'features.json'), 'utf8')) as Fichero;
    cache = raw.features ?? {};
  } catch {
    // Sin fichero, todo encendido: un despliegue viejo no pierde funciones por no tener
    // el JSON nuevo. Lo que falte sale como «desconocida» en /api/features.
    cache = {};
  }
  return cache;
}

/** Para los tests: olvidar el fichero leído y, opcionalmente, fijar otro contenido. */
export function reiniciarFeatures(forzar?: Record<string, Feature>, anuladas?: Record<string, boolean>): void {
  cache = forzar ?? null;
  anulaciones = anuladas ?? null;
}

/** ¿Está la función encendida? Una función que no está en el fichero cuenta como encendida. */
export function featureEncendida(nombre: string): boolean {
  const a = cargarAnulaciones();
  if (nombre in a && !soloArranque(nombre)) return a[nombre];
  const f = leerFeatures()[nombre];
  return f ? f.on : true;
}

/** Encendida Y con su variable de entorno presente (si la necesita). */
export function featureActiva(nombre: string, entorno: NodeJS.ProcessEnv = process.env): boolean {
  if (!featureEncendida(nombre)) return false;
  const f = leerFeatures()[nombre];
  if (f?.opcional) return !!entorno[f.opcional]?.trim();
  return true;
}

/** Lo que ve la pantalla: estado de cada flag, sin valores de ninguna variable. */
export interface EstadoFeature {
  on: boolean;
  activa: boolean;
  descripcion: string;
  falta: string | null;
  anulada: boolean;
  /** Solo cambia al arrancar (auth.*, seguridad.*): la API lo rechaza y Ajustes no lo enseña. */
  soloArranque: boolean;
}

export function estadoFeatures(entorno: NodeJS.ProcessEnv = process.env): Record<string, EstadoFeature> {
  const out: Record<string, EstadoFeature> = {};
  const a = cargarAnulaciones();
  for (const [k, f] of Object.entries(leerFeatures())) {
    const on = featureEncendida(k);
    const activa = featureActiva(k, entorno);
    const fijo = soloArranque(k);
    out[k] = { on, activa, descripcion: f.descripcion, falta: on && !activa && f.opcional ? f.opcional : null, anulada: k in a && !fijo, soloArranque: fijo };
  }
  return out;
}
