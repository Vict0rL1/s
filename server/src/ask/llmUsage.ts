// Cuántos tokens gasta el asistente, contados de donde se puede contar.
//
// ===========================================================================
// LA MISMA LECCIÓN QUE CON THE ODDS API
// ===========================================================================
// De `oddsQuota.ts`: «el plan gratuito se agotó porque nada lo mencionaba hasta que ya
// no quedaba». El enrutador con modelo tiene exactamente la misma forma de fallar: se
// paga por pregunta, nadie ve cuánto, y el mes que viene llega una factura que no se
// puede repartir entre lo que la produjo.
//
// Y el dato viene GRATIS en cada respuesta de la API, en `usage.input_tokens` y
// `usage.output_tokens`, igual que la cuota de The Odds API viene en sus cabeceras. Se
// estaba tirando.
//
// ===========================================================================
// TOKENS SÍ, DINERO SOLO SI LO PONES TÚ
// ===========================================================================
// Los tokens son una MEDIDA: los cuenta el proveedor y se guardan tal cual. El precio no
// lo es — depende del modelo, del plan y de la fecha, y cambia sin avisar. Poner aquí
// una cifra a ojo daría un coste con aspecto de medido que puede estar al doble.
//
// Así que el coste solo aparece si se escribe el precio en el .env, y entonces la
// pantalla dice que sale de ese número y no de ninguna medición. Un euro estimado y
// dicho como estimado vale; uno inventado y presentado como dato, no.

import { getMeta, setMeta } from '../db.ts';

const K_ENTRADA = 'llm:inputTokens';
const K_SALIDA = 'llm:outputTokens';
const K_LLAMADAS = 'llm:calls';
const K_DESDE = 'llm:since';
const K_ULTIMA = 'llm:lastAt';

const num = (k: string): number => {
  const v = Number(getMeta(k));
  return Number.isFinite(v) ? v : 0;
};

export interface UsoTokens {
  entrada: number;
  salida: number;
  llamadas: number;
  desde: string | null;
  ultima: string | null;
  /** Coste estimado, solo si hay precios configurados. null = no se puede saber. */
  coste: number | null;
  /** Los precios usados, para que el número sea auditable. */
  precios: { entrada: number; salida: number } | null;
}

/**
 * Apunta lo que acaba de costar una llamada.
 *
 * Se llama SIEMPRE que la API conteste, incluso si luego la respuesta se descarta por no
 * traer una herramienta válida: esos tokens se han pagado igual. Contar solo las
 * llamadas útiles daría un total por debajo del real, que es la peor dirección para
 * equivocarse en una factura.
 */
export function apuntarUso(usage: unknown): void {
  const u = usage as { input_tokens?: unknown; output_tokens?: unknown } | null;
  const ent = Number(u?.input_tokens);
  const sal = Number(u?.output_tokens);
  if (!Number.isFinite(ent) && !Number.isFinite(sal)) return;
  if (!getMeta(K_DESDE)) setMeta(K_DESDE, new Date().toISOString());
  setMeta(K_ENTRADA, String(num(K_ENTRADA) + (Number.isFinite(ent) ? ent : 0)));
  setMeta(K_SALIDA, String(num(K_SALIDA) + (Number.isFinite(sal) ? sal : 0)));
  setMeta(K_LLAMADAS, String(num(K_LLAMADAS) + 1));
  setMeta(K_ULTIMA, new Date().toISOString());
}

/**
 * Precio por MILLÓN de tokens, si alguien lo ha configurado.
 *
 * Se lee del entorno en cada consulta y no al arrancar: cambiar un precio es algo que se
 * hace mirando la factura, y obligar a reiniciar el servidor para eso convertiría una
 * corrección de treinta segundos en un ciclo de reinicio.
 */
function precios(): { entrada: number; salida: number } | null {
  const e = Number(process.env.LLM_PRECIO_ENTRADA);
  const s = Number(process.env.LLM_PRECIO_SALIDA);
  if (!Number.isFinite(e) || !Number.isFinite(s) || (e <= 0 && s <= 0)) return null;
  return { entrada: Number.isFinite(e) ? e : 0, salida: Number.isFinite(s) ? s : 0 };
}

export function usoTokens(): UsoTokens {
  const entrada = num(K_ENTRADA);
  const salida = num(K_SALIDA);
  const p = precios();
  return {
    entrada,
    salida,
    llamadas: num(K_LLAMADAS),
    desde: getMeta(K_DESDE),
    ultima: getMeta(K_ULTIMA),
    coste: p ? (entrada / 1_000_000) * p.entrada + (salida / 1_000_000) * p.salida : null,
    precios: p,
  };
}

/** Para empezar la cuenta de cero, por ejemplo al principio de un mes. */
export function reiniciarUso(): void {
  for (const k of [K_ENTRADA, K_SALIDA, K_LLAMADAS, K_DESDE, K_ULTIMA]) setMeta(k, '');
}
