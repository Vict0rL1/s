"""Métricas de riesgo calculadas sobre series de precios ya cacheadas.

Cero coste de API: reutilizan el histórico que el gráfico ya descargó.
"""

from __future__ import annotations

import math

import pandas as pd


def daily_returns(closes: pd.Series) -> pd.Series:
    return closes.pct_change().dropna()


def annualized_volatility(returns: pd.Series, periods_per_year: int = 252) -> float | None:
    if len(returns) < 20:
        return None  # con menos de ~1 mes de datos el número es ruido
    return float(returns.std(ddof=1) * math.sqrt(periods_per_year))


def beta(asset_returns: pd.Series, benchmark_returns: pd.Series) -> float | None:
    """Beta = cov(activo, benchmark) / var(benchmark), sobre retornos alineados."""
    joined = pd.concat([asset_returns, benchmark_returns], axis=1, join="inner").dropna()
    if len(joined) < 30:
        return None
    a, b = joined.iloc[:, 0], joined.iloc[:, 1]
    var = b.var(ddof=1)
    if var == 0:
        return None
    return float(a.cov(b) / var)


def max_drawdown(closes: pd.Series) -> dict | None:
    """Máxima caída pico-a-valle del periodo, con fechas si el índice las trae.

    Usa indexación **posicional**, no por etiqueta: un histórico con fechas
    repetidas (dos barras el mismo día, duplicados del proveedor) haría que
    `.loc[]` devolviera una Series en vez de un escalar y rompiera el cálculo.
    """
    if len(closes) < 2:
        return None
    running_max = closes.cummax()
    drawdown = closes / running_max - 1.0
    trough_pos = int(drawdown.to_numpy().argmin())
    peak_pos = int(closes.iloc[: trough_pos + 1].to_numpy().argmax())
    return {
        "max_drawdown": float(drawdown.iloc[trough_pos]),
        "peak": str(closes.index[peak_pos]),
        "trough": str(closes.index[trough_pos]),
    }
