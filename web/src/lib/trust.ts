// La evaluación de confianza de un partido, tal como la sirve el servidor (server/src/trust).

export interface ItemDato {
  estado: 'ok' | 'aviso' | 'desconocido';
  texto: string;
  max: number;
  puntos: number;
}

export interface EvaluacionConfianza {
  sport: string;
  matchKey: string;
  outcomes: string[];
  probs: number[];
  calidadDatos: { puntuacion: number; items: ItemDato[]; explicacion: string };
  incertidumbre: {
    ruidoRatingPp: number;
    sesgoCalibracionPp: number | null;
    nTramo: number | null;
    totalPp: number;
    rango: { bajo: number; alto: number };
    significado: string;
  };
  estabilidad: {
    nivel: 'ALTA' | 'MEDIA' | 'BAJA';
    base: number;
    escenarios: { texto: string; p: number }[];
    p10: number;
    p90: number;
    anchoPp: number;
    supuestos: string[];
    criterio: string;
  };
  desacuerdo: { nivel: 'BAJO' | 'MEDIO' | 'ALTO' | 'SIN COMPONENTES'; rangoPp: number; componentes: { nombre: string; p: number }[]; criterio: string };
  sensibilidad: { base: number; contribuciones: { etiqueta: string; pp: number }[]; final: number; metodo: string; exacta: boolean };
  /** Qué pasaría si: factores con su rango plausible y la pendiente de la curva (simulación, no predicción publicada). */
  queSi?: { pendiente: number; exacta: boolean; factores: { clave: string; etiqueta: string; puntos: number; rango: [number, number]; porQue: string }[]; etiqueta: string };
  mercado: {
    etiqueta: string;
    calidad: 'ALTA' | 'MEDIA' | 'BAJA' | 'SIN DATOS';
    dispersion: 'BAJA' | 'MEDIA' | 'ALTA' | null;
    casas: number;
    lineas: { seleccion: string; mejor: number; mejorCasa: string; mediana: number; peor: number; casas: number; dispersionPp: number }[];
    ultimaActualizacionMin: number | null;
    observaciones24h: number;
    horasAlInicio: number | null;
    motivos: string[];
  };
  ood: { grave: boolean; texto: string }[];
  regimen: { etiqueta: string; nota: string | null };
  confianza: { nivel: 'ALTA' | 'MEDIA' | 'BAJA'; porQue: { ok: boolean; texto: string }[]; criterio: string };
  decision: {
    decision: 'BET' | 'NO BET' | 'SIN MERCADO';
    seleccion: { indice: number; nombre: string; p: number; cuota: number; edge: number } | null;
    razones: string[];
    factorStake: number;
    recortes: { texto: string; factor: number }[];
    contrafactual: string[];
    desaparece: number | null;
  };
  deriva: string;
  nota: string;
}

export interface PrePartidoRef {
  sport: string;
  matchKey: string;
}

export interface Horizonte {
  etiqueta: string;
  marca: string;
  fila: { probs: number[]; captured_at: string; outcomes: string[] } | null;
  minutosAntesDeLaMarca: number | null;
  /** El estado que decidió el servidor con su reloj (G1b). Falta en respuestas guardadas de antes. */
  estado?: 'ok' | 'pendiente' | 'sin_observacion';
}

/**
 * Qué decir de un horizonte sin fila: si su hora aún no ha llegado, está PENDIENTE (no es que
 * falte una observación: todavía no podía haberla). Con fila, nada (se enseña la probabilidad).
 */
export function etiquetaHorizonte(h: Horizonte, ahora: Date = new Date()): 'fiarse.pendiente' | 'fiarse.sinObservacion' | null {
  if (h.fila) return null;
  // El servidor decide con el mismo reloj con que buscó la fila; el del navegador, solo si no lo dice.
  if (h.estado === 'pendiente') return 'fiarse.pendiente';
  if (h.estado === 'sin_observacion') return 'fiarse.sinObservacion';
  const marca = Date.parse(h.marca);
  return Number.isFinite(marca) && marca > ahora.getTime() ? 'fiarse.pendiente' : 'fiarse.sinObservacion';
}

export interface PrePartido {
  instantaneas: number;
  /** Los resultados de la última instantánea (G1b); falta en respuestas guardadas de antes. */
  outcomes?: string[];
  horizontes: Horizonte[];
  cambios: { desde: string; hasta: string; deltaPp: number[]; causas: string[]; atribucion: string }[];
  final: { probs: number[]; frozen_at: string; source: string } | null;
}

/**
 * El resultado cuya probabilidad se sigue por horizontes. De las instantáneas, no del primer
 * horizonte con fila: con los horizontes aún pendientes (G1) no hay ninguno, y el panel decía
 * «Probabilidad de , tal como…».
 */
export function nombreDelPrePartido(d: PrePartido): string {
  return d.outcomes?.[0] ?? d.horizontes.find((h) => h.fila)?.fila?.outcomes[0] ?? '';
}

/**
 * Qué decir cuando no hay deriva que dibujar (menos de dos horizontes con fila). Con varias
 * instantáneas no es que haya una sola: es que aún no caen en dos horizontes distintos (G1b).
 */
export function avisoSinDeriva(d: PrePartido): 'partido.sinInstantaneas' | 'partido.unaInstantanea' | 'partido.sinDosHorizontes' {
  return !d.instantaneas ? 'partido.sinInstantaneas' : d.instantaneas === 1 ? 'partido.unaInstantanea' : 'partido.sinDosHorizontes';
}
