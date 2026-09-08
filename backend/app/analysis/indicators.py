"""Indicadores técnicos clásicos sobre series de cierre.

Funciones puras sobre pandas.Series; devuelven Series alineadas al índice de
entrada con NaN donde el indicador aún no está definido. Toda la lógica
financiera de la app vive en módulos como este y está cubierta por tests: un
error de cálculo silencioso es el peor bug posible aquí.
"""

from __future__ import annotations

import pandas as pd


def sma(close: pd.Series, window: int) -> pd.Series:
    """Media móvil simple."""
    if window < 1:
        raise ValueError("window debe ser >= 1")
    return close.rolling(window=window, min_periods=window).mean()


def ema(close: pd.Series, span: int) -> pd.Series:
    """Media móvil exponencial (convención estándar: alpha = 2/(span+1))."""
    if span < 1:
        raise ValueError("span debe ser >= 1")
    return close.ewm(span=span, adjust=False, min_periods=span).mean()


def rsi(close: pd.Series, period: int = 14) -> pd.Series:
    """RSI de Wilder.

    Usa el suavizado original de Wilder (media móvil exponencial con
    alpha = 1/period), no una media simple: es la convención de las
    plataformas de charting y de la literatura.
    """
    if period < 1:
        raise ValueError("period debe ser >= 1")
    delta = close.diff()
    gains = delta.clip(lower=0.0)
    losses = -delta.clip(upper=0.0)
    avg_gain = gains.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    avg_loss = losses.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    rs = avg_gain / avg_loss
    out = 100 - 100 / (1 + rs)
    # Sin pérdidas en la ventana → RSI 100 (evita división por cero).
    out = out.where(avg_loss != 0, 100.0)
    out[avg_gain.isna() | avg_loss.isna()] = float("nan")
    return out


def macd(
    close: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9
) -> pd.DataFrame:
    """MACD estándar: línea (EMA rápida - EMA lenta), señal e histograma."""
    if not fast < slow:
        raise ValueError("fast debe ser menor que slow")
    macd_line = ema(close, fast) - ema(close, slow)
    signal_line = macd_line.ewm(span=signal, adjust=False).mean()
    return pd.DataFrame(
        {
            "macd": macd_line,
            "signal": signal_line,
            "histogram": macd_line - signal_line,
        }
    )
