// BET / NO BET, la confianza y el contrafactual, con las reglas de verdad.
//
// ===========================================================================
// NO ES «PROBABILIDAD < 60 % = ABSTENERSE»
// ===========================================================================
// La probabilidad sola no dice nada de si fiarse de ella. Lo que decide es si la ventaja
// que se ve SOBREVIVE a lo que no se sabe:
//
//   1. Ventaja mínima de la política (DEFAULT_CONFIG.minEdge), la misma puerta 1 de
//      staking/policy.ts.
//   2. Que siga habiendo ventaja con la probabilidad bajada en su incertidumbre (±1σ):
//      si la ventaja es menor que el error del propio número, no es una ventaja.
//   3. Que la ventaja no desaparezca en más de la mitad de las simulaciones (ruido de
//      rating + supuestos en su rango): por encima, es más probable que no esté.
//   4. Datos: calidad ≥ 60/100, ningún aviso OOD grave.
//   5. Estabilidad no BAJA; desacuerdo ALTO solo si ningún componente niega la ventaja.
//   6. Mercado: calidad no BAJA (proxy) y precio observado en las últimas 6 h.
//   7. Que la predicción con la que se apuesta (la registrada) no esté desfasada de la
//      actual más de su incertidumbre.
//
// Las demás señales no abstienen: recortan el importe (nunca lo suben), y cada recorte
// queda escrito con su motivo. Los umbrales son elecciones de diseño, a la vista, no
// parámetros ajustados con datos — y menos con el holdout.

import { bestSelection } from '../staking/policy.ts';
import { politica } from '../staking/policyStore.ts';
import type { EventoConfianza } from './types.ts';
import type { Incertidumbre, Estabilidad, Desacuerdo } from './perturbation.ts';
import type { CalidadDatos } from './dataQuality.ts';
import type { CalidadMercado } from './market.ts';
import { num, pct as pctEs } from '../numeros.ts';

export const ABSTENCION = {
  calidadDatosMin: 60,
  desapareceMax: 0.5,
  precioViejoHoras: 6,
};

/** Recortes del importe por señal. Multiplican; nunca suben de 1. */
export const RECORTES = {
  estabilidadMedia: 0.5,
  desacuerdoMedio: 0.75,
  desacuerdoAlto: 0.5,
  oodLeve: 0.5,
  dispersionAlta: 0.75,
  deriva: 0.5,
};

/**
 * Familias de motivo de abstención, para agruparlos (doctor, informes). Los textos llevan
 * números («calidad de datos 42/100») y contados tal cual nunca se repiten.
 *
 * `tuberia`: el motivo no habla del partido sino de que algo no estaba al día (cuotas sin
 * refrescar, evaluación anterior a las cuotas). Una abstención así es un fallo de
 * operación, no una decisión del modelo, y se diagnostica distinto.
 *
 * Incluye las del banco (paper/bankroll.ts → juicioDeConfianza). Un test fija que todo
 * texto que generan las reglas cae en alguna familia: un texto nuevo sin familia saldría
 * como «otro» y el diagnóstico dejaría de verlo.
 */
export const FAMILIAS_MOTIVO: { familia: string; re: RegExp; tuberia: boolean }[] = [
  { familia: 'sin ventaja mínima', re: /por debajo del mínimo de la política/, tuberia: false },
  { familia: 'no sobrevive a la incertidumbre', re: /no sobrevive a la incertidumbre/, tuberia: false },
  { familia: 'desaparece en la sensibilidad', re: /desaparece en el \d+ % de las simulaciones/, tuberia: false },
  { familia: 'calidad de datos', re: /^calidad de datos \d+\/100/, tuberia: false },
  { familia: 'fuera de distribución', re: /^fuera de distribución/, tuberia: false },
  { familia: 'predicción inestable', re: /^predicción inestable/, tuberia: false },
  { familia: 'componentes en contra', re: /^componentes en contra/, tuberia: false },
  { familia: 'mercado de calidad baja', re: /^mercado de calidad baja/, tuberia: false },
  { familia: 'predicción desfasada', re: /está desfasada de la actual/, tuberia: false },
  { familia: 'sin mercado', re: /^(partido de demostración|sin cuotas para este partido)/, tuberia: false },
  { familia: 'recorte a cero', re: /^el recorte de confianza deja el importe en cero/, tuberia: false },
  { familia: 'precio viejo', re: /^precio de hace \d+ h/, tuberia: true },
  { familia: 'sin evaluación', re: /^sin evaluación de confianza registrada/, tuberia: true },
  { familia: 'evaluación anterior a las cuotas', re: /evaluación de confianza es anterior a las cuotas/, tuberia: true },
  { familia: 'evaluación con otra cuota', re: /evaluación de confianza se hizo con otra selección o con otra cuota/, tuberia: true },
];

export function familiaDeMotivo(texto: string): { familia: string; tuberia: boolean } {
  const limpio = texto.replace(/^abstención:\s*/, '');
  const f = FAMILIAS_MOTIVO.find((x) => x.re.test(limpio));
  return f ? { familia: f.familia, tuberia: f.tuberia } : { familia: 'otro', tuberia: false };
}

export interface Senal {
  ok: boolean;
  texto: string;
}

export interface Confianza {
  nivel: 'ALTA' | 'MEDIA' | 'BAJA';
  porQue: Senal[];
  criterio: string;
}

export interface Decision {
  decision: 'BET' | 'NO BET' | 'SIN MERCADO';
  seleccion: { indice: number; nombre: string; p: number; cuota: number; edge: number } | null;
  /** Por qué NO, o las salvedades si es BET. */
  razones: string[];
  /** Multiplicador del importe de la política (≤ 1) y cada recorte. */
  factorStake: number;
  recortes: { texto: string; factor: number }[];
  /** «Deja de cumplir si…» (BET) o «haría falta…» (NO BET). Calculado con las reglas de arriba. */
  contrafactual: string[];
  /** Fracción de simulaciones en que la ventaja desaparece. */
  desaparece: number | null;
}

export interface Contexto {
  evento: EventoConfianza;
  calidad: CalidadDatos;
  incertidumbre: Incertidumbre;
  estabilidad: Estabilidad;
  desacuerdo: Desacuerdo;
  mercado: CalidadMercado;
  /** Fracción de simulaciones sin ventaja, por selección (la calcula quien llama). */
  desapareceDe: (seleccion: number, cuota: number) => number;
  /** La probabilidad registrada con la que se apostaría, si difiere de la actual. */
  pRegistrada?: number[] | null;
  /** ¿El deporte muestra deriva reciente en vivo? */
  deriva?: string | null;
  now?: Date;
}

const pct = (x: number) => pctEs(x);

export function confianza(c: Omit<Contexto, 'desapareceDe'>): Confianza {
  const s: Senal[] = [];
  const u = c.incertidumbre;
  s.push(
    u.sesgoCalibracionPp == null
      ? { ok: false, texto: 'tramo de probabilidad sin calibración histórica medida' }
      : Math.abs(u.sesgoCalibracionPp) <= 2
        ? { ok: true, texto: `tramo histórico bien calibrado (sesgo ${num(u.sesgoCalibracionPp)} pp, n ${u.nTramo})` }
        : { ok: false, texto: `tramo histórico descalibrado (${num(u.sesgoCalibracionPp)} pp, n ${u.nTramo})` },
  );
  s.push(u.ruidoRatingPp <= 4 ? { ok: true, texto: `incertidumbre de rating baja (±${num(u.ruidoRatingPp)} pp)` } : { ok: false, texto: `incertidumbre de rating alta (±${num(u.ruidoRatingPp)} pp)` });
  s.push(c.calidad.puntuacion >= 80 ? { ok: true, texto: `calidad de datos alta (${c.calidad.puntuacion}/100)` } : { ok: false, texto: `calidad de datos ${c.calidad.puntuacion}/100` });
  s.push(c.estabilidad.nivel === 'ALTA' ? { ok: true, texto: 'predicción estable ante sus supuestos' } : { ok: false, texto: `estabilidad ${c.estabilidad.nivel} (P10–P90: ${num(c.estabilidad.anchoPp)} pp)` });
  if (c.desacuerdo.nivel !== 'SIN COMPONENTES') {
    s.push(c.desacuerdo.nivel === 'BAJO' ? { ok: true, texto: 'los componentes del modelo coinciden' } : { ok: false, texto: `desacuerdo ${c.desacuerdo.nivel} entre componentes (${num(c.desacuerdo.rangoPp)} pp)` });
  }
  if (c.evento.ood.length) for (const o of c.evento.ood) s.push({ ok: false, texto: o.texto });
  else s.push({ ok: true, texto: 'sin señales de fuera de distribución' });
  if (c.mercado.calidad !== 'SIN DATOS') {
    s.push(c.mercado.dispersion === 'ALTA' ? { ok: false, texto: 'las casas discrepan mucho' } : { ok: true, texto: `mercado ${c.mercado.calidad.toLowerCase()} (${c.mercado.casas} casas)` });
  }
  const malas = s.filter((x) => !x.ok).length;
  const grave = c.evento.ood.some((o) => o.grave) || c.estabilidad.nivel === 'BAJA' || c.calidad.puntuacion < politica().abstencion.calidadDatosMin;
  return {
    nivel: grave || malas >= 3 ? 'BAJA' : malas === 0 ? 'ALTA' : 'MEDIA',
    porQue: s,
    criterio:
      'ALTA si no hay ningún aviso; BAJA si hay tres o más, o uno grave (OOD grave, estabilidad BAJA o calidad de datos < 60); ' +
      'si no, MEDIA. No depende de la probabilidad: un 80 % puede ser de confianza baja y un 52 % de confianza alta.',
  };
}

export function decidir(c: Contexto): Decision {
  const e = c.evento;
  const now = c.now ?? new Date();
  const minEdge = politica().staking.minEdge;
  const base: Decision = { decision: 'SIN MERCADO', seleccion: null, razones: [], factorStake: 0, recortes: [], contrafactual: [], desaparece: null };
  if (e.demo || !e.odds || e.odds.length !== e.probs.length) {
    return { ...base, razones: [e.demo ? 'partido de demostración: no hay mercado real' : 'sin cuotas para este partido'] };
  }
  const opciones = e.probs.map((p, i) => ({ indice: i, p, odds: (e.odds as number[])[i] }));
  const elegida = bestSelection(opciones, politica().staking) ?? opciones[0];
  const { indice, p, odds } = elegida;
  const edge = p * odds - 1;
  const u = c.incertidumbre.totalPp / 100;
  const seleccion = { indice, nombre: e.outcomes[indice], p, cuota: odds, edge };
  const razones: string[] = [];
  const falta: string[] = [];

  if (edge < minEdge) {
    razones.push(`ventaja ${pct(edge)} por debajo del mínimo de la política (${pct(minEdge)})`);
    falta.push(`cuota ≥ ${num((1 + minEdge) / p, 2)} (hoy ${num(odds, 2)}) o probabilidad ≥ ${pct((1 + minEdge) / odds)}`);
  }
  const edgeBajo = (p - u) * odds - 1;
  if (edge >= minEdge && edgeBajo < 0) {
    razones.push(`la ventaja no sobrevive a la incertidumbre: con ${pct(p - u)} (−${num(u * 100, 1)} pp) la apuesta pierde`);
    falta.push(`cuota ≥ ${num(1 / (p - u), 2)} o incertidumbre ≤ ±${num((p - 1 / odds) * 100, 1)} pp`);
  }
  const desaparece = edge >= minEdge ? c.desapareceDe(indice, odds) : null;
  if (desaparece != null && desaparece > politica().abstencion.desapareceMax) {
    razones.push(`la ventaja desaparece en el ${Math.round(desaparece * 100)} % de las simulaciones de sensibilidad`);
    falta.push(`que desaparezca en menos del ${politica().abstencion.desapareceMax * 100} % (hoy ${Math.round(desaparece * 100)} %)`);
  }
  if (c.calidad.puntuacion < politica().abstencion.calidadDatosMin) {
    razones.push(`calidad de datos ${c.calidad.puntuacion}/100 (mínimo ${politica().abstencion.calidadDatosMin})`);
    falta.push(`calidad de datos ≥ ${politica().abstencion.calidadDatosMin}: ${c.calidad.items.filter((i) => i.estado === 'aviso').map((i) => i.texto).join('; ')}`);
  }
  for (const o of e.ood.filter((x) => x.grave)) razones.push(`fuera de distribución: ${o.texto}`);
  if (c.estabilidad.nivel === 'BAJA') {
    razones.push(`predicción inestable: entre ${pct(c.estabilidad.p10)} y ${pct(c.estabilidad.p90)} según los supuestos`);
    falta.push(`estabilidad MEDIA o ALTA (P10–P90 < ${8} pp; hoy ${num(c.estabilidad.anchoPp)} pp)`);
  }
  if (c.desacuerdo.nivel === 'ALTO') {
    const niega = e.componentes.filter((k) => k.probs[indice] * odds - 1 < 0);
    if (niega.length) razones.push(`componentes en contra: según ${niega.map((k) => k.nombre).join(', ')} no hay ventaja`);
  }
  if (c.mercado.calidad === 'BAJA') razones.push(`mercado de calidad baja (proxy): ${c.mercado.motivos.join('; ')}`);
  if (e.oddsAt) {
    const h = (now.getTime() - Date.parse(e.oddsAt)) / 3_600_000;
    if (h > politica().abstencion.precioViejoHoras) {
      razones.push(`precio de hace ${h.toFixed(0)} h (máximo ${politica().abstencion.precioViejoHoras} h)`);
      falta.push('un precio observado en las últimas 6 h');
    }
  }
  if (c.pRegistrada && Math.abs(c.pRegistrada[indice] - p) > Math.max(u, 0.01)) {
    razones.push(`la predicción registrada (${pct(c.pRegistrada[indice])}) está desfasada de la actual (${pct(p)})`);
  }

  // Recortes del importe.
  const recortes: Decision['recortes'] = [];
  if (c.estabilidad.nivel === 'MEDIA') recortes.push({ texto: 'estabilidad MEDIA', factor: politica().recortes.estabilidadMedia });
  if (c.desacuerdo.nivel === 'MEDIO') recortes.push({ texto: 'desacuerdo MEDIO entre componentes', factor: politica().recortes.desacuerdoMedio });
  if (c.desacuerdo.nivel === 'ALTO') recortes.push({ texto: 'desacuerdo ALTO entre componentes', factor: politica().recortes.desacuerdoAlto });
  if (e.ood.some((o) => !o.grave)) recortes.push({ texto: 'señal leve de fuera de distribución', factor: politica().recortes.oodLeve });
  if (c.mercado.dispersion === 'ALTA') recortes.push({ texto: 'casas muy dispersas', factor: politica().recortes.dispersionAlta });
  if (c.deriva) recortes.push({ texto: `deriva reciente: ${c.deriva}`, factor: politica().recortes.deriva });
  const factor = recortes.reduce((a, r) => a * r.factor, 1);

  if (razones.length) {
    return { decision: 'NO BET', seleccion, razones, factorStake: 0, recortes, contrafactual: falta.length ? falta : ['ninguna regla cuantitativa lo arreglaría: es un problema de datos o de mercado'], desaparece };
  }
  // BET: qué tendría que cambiar para dejar de cumplir.
  const cuotaMin = Math.max((1 + minEdge) / p, 1 / (p - u));
  const pMin = Math.max((1 + minEdge) / odds, 1 / odds + u);
  return {
    decision: 'BET',
    seleccion,
    razones: recortes.map((r) => `importe ×${r.factor}: ${r.texto}`),
    factorStake: factor,
    recortes,
    contrafactual: [
      `la cuota cae por debajo de ${num(cuotaMin, 2)} (hoy ${num(odds, 2)})`,
      `la probabilidad del modelo cae por debajo de ${pct(pMin)} (hoy ${pct(p)})`,
      `la incertidumbre sube por encima de ±${num((p - 1 / odds) * 100, 1)} pp (hoy ±${num(u * 100, 1)} pp)`,
      `la ventaja desaparece en más del ${politica().abstencion.desapareceMax * 100} % de las simulaciones (hoy ${Math.round((desaparece ?? 0) * 100)} %)`,
      `la calidad de datos baja de ${politica().abstencion.calidadDatosMin} (hoy ${c.calidad.puntuacion})`,
      'la estabilidad pasa a BAJA, o el precio queda más de 6 h sin observarse',
    ],
    desaparece,
  };
}
