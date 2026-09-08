"""Factores cuantitativos con puntuación transversal (cross-sectional).

Un factor solo significa algo **en relación a un universo**: un P/E de 18 no
es caro ni barato en abstracto. Por eso todo aquí se puntúa contra el resto
de la muestra (z-score winsorizado), no contra umbrales absolutos.

Convenciones que el resto del motor asume:
- Todo factor está orientado de forma que **más alto = mejor**. Los que son
  "mejor cuanto menor" (deuda, múltiplos) se invierten al construirlos.
- Un insumo ausente produce un factor None. Nunca se imputa un valor: no
  saber el ROE de una empresa no es lo mismo que tener un ROE de 0.
"""

from __future__ import annotations

import math
from statistics import NormalDist

# Familias de factores y su peso por defecto en el compuesto. Suman 1.
# Sentimiento pesa menos porque NO es backtesteable (ver backtest.py) y
# porque su horizonte natural es mucho más corto que 6-12 meses.
DEFAULT_WEIGHTS = {
    "value": 0.30,
    "quality": 0.30,
    "momentum": 0.30,
    "sentiment": 0.10,
}

# Cada familia agrupa varios factores individuales, promediados entre sí.
FACTOR_FAMILIES = {
    "value": ["earnings_yield", "book_yield", "fcf_yield"],
    "quality": ["roe", "operating_margin", "interest_coverage", "low_leverage"],
    "momentum": ["momentum_12_1"],
    "sentiment": ["news_sentiment"],
}


def _safe_inverse(value: float | None) -> float | None:
    """Invierte un múltiplo a rendimiento (P/E -> E/P).

    Un múltiplo negativo o cero NO se convierte en un rendimiento alto: una
    empresa en pérdidas no es "barata" por tener P/E negativo. Devuelve None.
    """
    if value is None or value <= 0:
        return None
    return 1.0 / value


def build_raw_factors(
    metrics: dict,
    momentum: float | None = None,
    sentiment: float | None = None,
) -> dict[str, float | None]:
    """Construye los factores crudos de UNA empresa, ya orientados.

    `metrics` usa las claves normalizadas de la app (fracciones, no %).
    """
    debt_to_equity = metrics.get("debt_to_equity")
    return {
        # Valor: rendimientos, no múltiplos (más alto = más barato)
        "earnings_yield": _safe_inverse(metrics.get("pe_ttm")),
        "book_yield": _safe_inverse(metrics.get("pb")),
        "fcf_yield": metrics.get("fcf_yield"),
        # Calidad
        "roe": metrics.get("roe"),
        "operating_margin": metrics.get("operating_margin"),
        "interest_coverage": metrics.get("interest_coverage"),
        # Apalancamiento invertido: menos deuda = mejor
        "low_leverage": -debt_to_equity if debt_to_equity is not None else None,
        # Momentum y sentimiento vienen ya calculados fuera
        "momentum_12_1": momentum,
        "news_sentiment": sentiment,
    }


def winsorize(values: list[float], limit: float = 0.05) -> list[float]:
    """Recorta los extremos al percentil `limit` para que un outlier no
    domine la media y la desviación del corte transversal."""
    if not values:
        return []
    ordered = sorted(values)
    n = len(ordered)
    k = int(n * limit)
    if k == 0 or n < 5:  # muestras pequeñas: winsorizar haría más daño que bien
        return list(values)
    low, high = ordered[k], ordered[n - k - 1]
    return [min(max(v, low), high) for v in values]


def zscores(values_by_symbol: dict[str, float | None]) -> dict[str, float | None]:
    """z-score transversal. Los None se mantienen como None.

    Con menos de 3 observaciones válidas no hay dispersión estimable y todo
    devuelve None: puntuar contra dos empresas sería ruido con formato de
    número.
    """
    present = {s: v for s, v in values_by_symbol.items() if v is not None}
    if len(present) < 3:
        return {s: None for s in values_by_symbol}

    symbols = list(present)
    clipped = winsorize([present[s] for s in symbols])
    mean = sum(clipped) / len(clipped)
    variance = sum((v - mean) ** 2 for v in clipped) / (len(clipped) - 1)
    std = math.sqrt(variance)

    out: dict[str, float | None] = {s: None for s in values_by_symbol}
    # Sin dispersión, nadie destaca: z=0 para los presentes.
    #
    # La comparación es RELATIVA a la escala del dato, no `std == 0`, y la
    # diferencia no es cosmética. Con cuarenta empresas que declaran exactamente
    # el mismo valor, la suma en coma flotante deja una media que difiere del
    # valor en 7e-17: la desviación sale de 7e-17 —distinta de cero— y la
    # división convierte ruido de redondeo puro en un z-score de −0,99. Un factor
    # que no distingue a nadie acababa moviendo el compuesto casi una desviación
    # entera, y el número tenía exactamente la misma pinta que uno bueno.
    escala = max((abs(v) for v in clipped), default=0.0)
    if std <= escala * 1e-9:
        for symbol in symbols:
            out[symbol] = 0.0
        return out
    for symbol, value in zip(symbols, clipped):
        out[symbol] = (value - mean) / std
    return out


def family_scores(
    factor_z: dict[str, dict[str, float | None]],
) -> dict[str, dict[str, float | None]]:
    """Promedia los z-scores de cada familia, por símbolo.

    `factor_z`: {factor: {símbolo: z}}. Una familia con todos sus factores
    ausentes queda como None; con algunos presentes, promedia los que hay
    (y `coverage` en el compuesto refleja cuánto se pudo medir).
    """
    symbols = {s for values in factor_z.values() for s in values}
    out: dict[str, dict[str, float | None]] = {}
    for family, factors in FACTOR_FAMILIES.items():
        family_row: dict[str, float | None] = {}
        for symbol in symbols:
            available = [
                factor_z[f][symbol]
                for f in factors
                if f in factor_z and factor_z[f].get(symbol) is not None
            ]
            family_row[symbol] = sum(available) / len(available) if available else None
        out[family] = family_row
    return out


def composite_score(
    families: dict[str, float | None], weights: dict[str, float] | None = None
) -> dict:
    """Compuesto ponderado a partir de las familias de UN símbolo.

    Renormaliza sobre las familias efectivamente disponibles y reporta
    `coverage` (fracción del peso total que se pudo medir). Un compuesto con
    coverage 0.3 no es comparable con uno de 1.0, y la UI debe enseñarlo.
    """
    weights = weights or DEFAULT_WEIGHTS
    available = {f: z for f, z in families.items() if z is not None and f in weights}
    total_weight = sum(weights[f] for f in available)
    if not available or total_weight == 0:
        return {
            "score": None,
            "coverage": 0.0,
            "contributions": {},
            "families": families,
        }

    score = sum(weights[f] * z for f, z in available.items()) / total_weight
    # Atribución: cuánto aporta cada familia al compuesto final.
    contributions = {
        f: (weights[f] * z) / total_weight for f, z in available.items()
    }
    return {
        "score": score,
        "coverage": total_weight / sum(weights.values()),
        "contributions": contributions,
        "families": families,
    }


def score_to_percentile(score: float) -> float:
    """Percentil normal del z-score compuesto — solo para ordenar y mostrar.

    **No es una probabilidad de subida.** Es dónde cae la empresa en la
    distribución de puntuaciones, asumiendo normalidad. La probabilidad real
    solo sale del backtest (ver signal.py).
    """
    return NormalDist().cdf(score)
