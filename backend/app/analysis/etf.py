"""Análisis de ETFs: solapamiento de carteras.

Limitación honesta y documentada: la fuente gratuita solo expone los ~10
mayores holdings de cada ETF, así que el solapamiento calculado es una COTA
INFERIOR del solapamiento real. La UI debe decirlo.
"""

from __future__ import annotations

from app import datos


def overlap_weight(holdings_a: list[dict], holdings_b: list[dict]) -> dict:
    """Solapamiento por peso entre dos listas de holdings [{symbol, weight}].

    Métrica estándar: sum(min(w_a, w_b)) sobre los símbolos comunes.
    Devuelve también los componentes compartidos para que la UI los muestre.

    Si a cualquiera de los dos le falta la composición, el solapamiento es
    DESCONOCIDO, no cero. Antes salía 0 %, y dos ETFs que replican el mismo
    índice pasaban por diversificados justo cuando no se había podido mirar.
    """
    simbolos_a = [h for h in holdings_a or [] if h.get("symbol")]
    simbolos_b = [h for h in holdings_b or [] if h.get("symbol")]
    if not simbolos_a or not simbolos_b:
        return {
            "overlap_weight": None,
            "desconocido": True,
            "shared_count": None,
            "common_holdings": [],
            "pesos_desconocidos": [],
            "motivo": (
                "No se ha podido leer la composición de al menos uno de los dos: el "
                "solapamiento no se sabe. No es 0 %, es desconocido."
            ),
            "note": NOTA,
        }

    weights_a = {h["symbol"]: datos.numero(h.get("weight")) for h in simbolos_a}
    weights_b = {h["symbol"]: datos.numero(h.get("weight")) for h in simbolos_b}
    shared = sorted(set(weights_a) & set(weights_b))
    # Un holding compartido sin peso sigue siendo compartido. Se cuenta y se
    # nombra; no se suma como cero en silencio, que rebajaría la cota.
    sin_peso = [s for s in shared if weights_a[s] is None or weights_b[s] is None]
    common = [
        {
            "symbol": symbol,
            "weight_a": weights_a[symbol],
            "weight_b": weights_b[symbol],
            "min_weight": (
                min(weights_a[symbol], weights_b[symbol])
                if symbol not in sin_peso
                else None
            ),
        }
        for symbol in shared
    ]
    common.sort(key=lambda c: c["min_weight"] or 0.0, reverse=True)
    return {
        "overlap_weight": sum(c["min_weight"] for c in common if c["min_weight"] is not None),
        "desconocido": False,
        "shared_count": len(common),
        "common_holdings": common,
        "pesos_desconocidos": sin_peso,
        "motivo": None,
        "note": NOTA,
    }


NOTA = (
    "Calculado solo sobre los mayores holdings publicados por la fuente "
    "gratuita: es una cota inferior del solapamiento real."
)
