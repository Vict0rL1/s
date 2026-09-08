"""Análisis de ETFs: solapamiento de carteras.

Limitación honesta y documentada: la fuente gratuita solo expone los ~10
mayores holdings de cada ETF, así que el solapamiento calculado es una COTA
INFERIOR del solapamiento real. La UI debe decirlo.
"""

from __future__ import annotations


def overlap_weight(holdings_a: list[dict], holdings_b: list[dict]) -> dict:
    """Solapamiento por peso entre dos listas de holdings [{symbol, weight}].

    Métrica estándar: sum(min(w_a, w_b)) sobre los símbolos comunes.
    Devuelve también los componentes compartidos para que la UI los muestre.
    """
    weights_a = {h["symbol"]: h.get("weight") or 0.0 for h in holdings_a if h.get("symbol")}
    weights_b = {h["symbol"]: h.get("weight") or 0.0 for h in holdings_b if h.get("symbol")}
    shared = sorted(set(weights_a) & set(weights_b))
    common = [
        {
            "symbol": symbol,
            "weight_a": weights_a[symbol],
            "weight_b": weights_b[symbol],
            "min_weight": min(weights_a[symbol], weights_b[symbol]),
        }
        for symbol in shared
    ]
    common.sort(key=lambda c: c["min_weight"], reverse=True)
    return {
        "overlap_weight": sum(c["min_weight"] for c in common),
        "shared_count": len(common),
        "common_holdings": common,
        "note": (
            "Calculado solo sobre los mayores holdings publicados por la fuente "
            "gratuita: es una cota inferior del solapamiento real."
        ),
    }
