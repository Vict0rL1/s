"""Cálculos de portafolio: P&L, pesos y exposición.

Funciones puras sobre posiciones ya cargadas. Una posición sin precio actual
NO se convierte en cero: se reporta como None y se excluye de los totales,
para no inventar un valor de cartera que no se conoce.
"""

from __future__ import annotations


def position_metrics(position: dict, price: float | None) -> dict:
    """Métricas de UNA posición abierta.

    position: {quantity, cost_basis (por acción), symbol, ...}
    """
    quantity = position["quantity"]
    cost_basis = position["cost_basis"]
    invested = quantity * cost_basis
    market_value = quantity * price if price is not None else None
    unrealized = market_value - invested if market_value is not None else None
    return {
        "quantity": quantity,
        "cost_basis": cost_basis,
        "invested": invested,
        "price": price,
        "market_value": market_value,
        "unrealized_pnl": unrealized,
        "unrealized_pct": (unrealized / invested) if unrealized is not None and invested else None,
    }


def portfolio_summary(positions: list[dict]) -> dict:
    """Agrega posiciones ya enriquecidas con `market_value` e `invested`.

    `total_market_value` suma solo lo que tiene precio; `priced_positions`
    dice sobre cuántas se calculó, para que la UI no presente un total
    parcial como si fuera completo.
    """
    priced = [p for p in positions if p.get("market_value") is not None]
    total_invested = sum(p["invested"] for p in positions)
    total_value = sum(p["market_value"] for p in priced)
    invested_priced = sum(p["invested"] for p in priced)
    unrealized = total_value - invested_priced if priced else None
    return {
        "total_invested": total_invested,
        "total_market_value": total_value if priced else None,
        "unrealized_pnl": unrealized,
        "unrealized_pct": (unrealized / invested_priced) if unrealized is not None and invested_priced else None,
        "priced_positions": len(priced),
        "total_positions": len(positions),
    }


def allocation_weights(positions: list[dict], key: str) -> list[dict]:
    """Peso por posición o por agrupación (`key` = 'symbol', 'sector', ...).

    Los pesos se calculan sobre el valor de mercado de las posiciones con
    precio; una posición sin precio no puede ponderarse y se omite.
    """
    priced = [p for p in positions if p.get("market_value") is not None]
    total = sum(p["market_value"] for p in priced)
    if not total:
        return []
    buckets: dict[str, float] = {}
    for p in priced:
        label = p.get(key) or "Sin clasificar"
        buckets[label] = buckets.get(label, 0.0) + p["market_value"]
    rows = [
        {"label": label, "market_value": value, "weight": value / total}
        for label, value in buckets.items()
    ]
    rows.sort(key=lambda r: r["weight"], reverse=True)
    return rows


def realized_pnl(closed_positions: list[dict]) -> float:
    """Suma del P&L realizado de posiciones cerradas."""
    return sum(p.get("realized_pnl") or 0.0 for p in closed_positions)


def concentration_warning(weights: list[dict], threshold: float = 0.25) -> list[str]:
    """Avisos de concentración. No es una recomendación: es un hecho sobre
    la cartera que conviene ver explícitamente."""
    return [
        f"{row['label']} representa el {row['weight'] * 100:.1f} % de la cartera"
        for row in weights
        if row["weight"] > threshold
    ]
