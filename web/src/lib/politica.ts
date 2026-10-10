// Las etiquetas de la política de apuestas en Ajustes: una por clave numérica de la política
// (server/src/staking/policyStore.ts → politicaPorDefecto). Un test del servidor comprueba
// que ninguna se queda sin etiqueta en español ni en inglés.
import type { Clave } from '../i18n/es';

export const ETIQUETA_POLITICA: Record<string, Clave> = {
  'staking.kellyFraction': 'aj.pol.kellyFraction',
  'staking.maxPerEvent': 'aj.pol.maxPerEvent',
  'staking.dailyLossLimit': 'aj.pol.dailyLossLimit',
  'staking.weeklyLossLimit': 'aj.pol.weeklyLossLimit',
  'staking.minEdge': 'aj.pol.minEdge',
  'staking.maxTotalExposure': 'aj.pol.maxTotalExposure',
  'staking.maxExposurePerDay': 'aj.pol.maxExposurePerDay',
  'abstencion.calidadDatosMin': 'aj.pol.calidadDatosMin',
  'staking.maxExposurePerLeague': 'aj.pol.maxExposurePerLeague',
  'abstencion.desapareceMax': 'aj.pol.desapareceMax',
  'abstencion.precioViejoHoras': 'aj.pol.precioViejoHoras',
  'recortes.estabilidadMedia': 'aj.pol.estabilidadMedia',
  'recortes.desacuerdoMedio': 'aj.pol.desacuerdoMedio',
  'recortes.desacuerdoAlto': 'aj.pol.desacuerdoAlto',
  'recortes.oodLeve': 'aj.pol.oodLeve',
  'recortes.dispersionAlta': 'aj.pol.dispersionAlta',
  'recortes.deriva': 'aj.pol.deriva',
  'grupos.maxSameTeamExposure': 'aj.pol.maxSameTeamExposure',
  'grupos.maxSamePlayerExposure': 'aj.pol.maxSamePlayerExposure',
};
