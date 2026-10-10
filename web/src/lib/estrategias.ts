// Tipos y ayudas del laboratorio de estrategias (Fase 6.1). Sin React: lo prueba el test unitario.

export interface Staking {
  kellyFraction: number;
  maxPerEvent: number;
  dailyLossLimit: number;
  weeklyLossLimit: number;
  minEdge: number;
  maxTotalExposure: number;
  maxExposurePerDay: number;
  maxExposurePerLeague: number;
}
export interface ConfigEstrategia {
  deportes: string[];
  mercados: string[];
  staking: Staking;
  /** Topes de grupo congelados al crear (las estrategias anteriores no lo tienen). */
  grupos?: { maxSameTeamExposure: number; maxSamePlayerExposure: number };
  confianza: boolean;
  calibracion: boolean;
}
export interface Estrategia {
  id: number;
  created_at: string;
  nombre: string;
  config: ConfigEstrategia;
  hash: string;
  nota: string | null;
  archived_at: string | null;
}
export interface Aviso {
  nivel: 'insuficiente' | 'orientativa' | 'suficiente';
  texto: string | null;
}
export interface FilaComparacion {
  id: number | null;
  nombre: string;
  archivada: boolean;
  config: ConfigEstrategia | null;
  banco: number;
  beneficio: number;
  apuestas: number;
  liquidadas: number;
  pendientes: number;
  ganadas: number;
  perdidas: number;
  roi: number | null;
  acierto: number | null;
  clvMedio: number | null;
  conCierre: number;
  drawdown: { importe: number; pct: number } | null;
  aviso: Aviso;
  comparable: boolean;
  curva: { t: string; banco: number }[];
}
export interface Historico {
  sport: string;
  disponible: boolean;
  motivo: string | null;
  fuente: string | null;
  generado: string | null;
  partidos: number;
  desde: string | null;
  hasta: string | null;
  temporadas: { desde: number; hasta: number } | null;
  apuestas: number;
  ganadas: number;
  beneficio: number;
  bancoFinal: number;
  roi: number | null;
  acierto: number | null;
  drawdown: { importe: number; pct: number; desde: string | null; hasta: string | null } | null;
  clvMedio: number | null;
  conClv: number;
  aviso: Aviso;
  curva: { fecha: string; banco: number }[];
  porTemporada: { temporada: string; apuestas: number; beneficio: number; roi: number | null }[];
  notas: string[];
}
export interface RespuestaLab {
  estrategias: Estrategia[];
  comparacion: { filas: FilaComparacion[]; nota: string };
  historicos: { sport: string; partidos: number; generado: string | null; fuente: string | null }[];
  limites: { maxActivas: number; deportes: string[]; mercados: string[] };
  politica: Staking;
}

/** El formulario: porcentajes como texto, tal como se escriben (coma o punto). */
export interface Formulario {
  nombre: string;
  nota: string;
  deportes: string[];
  minEdge: string;
  kellyFraction: '0.25' | '0.2';
  maxPerEvent: string;
  maxTotalExposure: string;
  dailyLossLimit: string;
  weeklyLossLimit: string;
  confianza: boolean;
  calibracion: boolean;
}

const pct = (x: number) => String(Math.round(x * 10000) / 100).replace('.', ',');

export function formularioDesde(p: Staking, deportes: string[]): Formulario {
  return {
    nombre: '',
    nota: '',
    deportes: [...deportes],
    minEdge: pct(p.minEdge),
    kellyFraction: p.kellyFraction === 0.2 ? '0.2' : '0.25',
    maxPerEvent: pct(p.maxPerEvent),
    maxTotalExposure: pct(p.maxTotalExposure),
    dailyLossLimit: pct(p.dailyLossLimit),
    weeklyLossLimit: pct(p.weeklyLossLimit),
    confianza: true,
    calibracion: true,
  };
}

/** Plantillas: cambios sobre el formulario, nunca valores inventados fuera de los rangos. */
export const PLANTILLAS: Record<'conservadora' | 'soloFutbol' | 'sinConfianza' | 'sinFreno', (f: Formulario) => Formulario> = {
  conservadora: (f) => ({ ...f, nombre: 'Conservadora', minEdge: '4', kellyFraction: '0.2', maxPerEvent: '1' }),
  soloFutbol: (f) => ({ ...f, nombre: 'Solo fútbol', deportes: ['football'] }),
  sinConfianza: (f) => ({ ...f, nombre: 'Sin capa de confianza', confianza: false }),
  sinFreno: (f) => ({ ...f, nombre: 'Sin freno de calibración', calibracion: false }),
};

const fraccion = (s: string): number => Number(String(s).trim().replace(',', '.')) / 100;

/** Lo que se manda a POST /api/estrategias. El servidor valida los rangos; aquí solo se convierte. */
export function peticionDe(f: Formulario) {
  return {
    nombre: f.nombre.trim(),
    nota: f.nota.trim() || null,
    deportes: f.deportes,
    mercados: ['h2h'],
    confianza: f.confianza,
    calibracion: f.calibracion,
    staking: {
      minEdge: fraccion(f.minEdge),
      kellyFraction: Number(f.kellyFraction),
      maxPerEvent: fraccion(f.maxPerEvent),
      maxTotalExposure: fraccion(f.maxTotalExposure),
      dailyLossLimit: fraccion(f.dailyLossLimit),
      weeklyLossLimit: fraccion(f.weeklyLossLimit),
    },
  };
}
