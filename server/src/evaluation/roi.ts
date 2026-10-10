// El ROI, una sola definición (lote C, C7): beneficio sobre lo ARRIESGADO.
//
// Había dos fórmulas: `beneficio / arriesgado` (banco de papel, estrategias, segmentos) y
// `beneficio / n` (CLV histórico de fútbol, walk-forward). Daban el mismo número porque las
// segundas apuestan una unidad fija (arriesgado = n), pero eran dos fórmulas que divergen en
// cuanto alguien cambie el importe. Quien calcule un ROI pasa por aquí con el arriesgado
// explícito; sin nada arriesgado el ROI no existe (null), no es cero.

export function roiDe(beneficio: number, arriesgado: number): number | null {
  return arriesgado > 0 ? beneficio / arriesgado : null;
}
