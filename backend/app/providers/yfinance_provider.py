"""Proveedor yfinance — SOLO como respaldo.

Librería no oficial que raspa Yahoo Finance: puede romperse sin aviso, así
que nunca es fuente primaria (decisión de diseño del proyecto). Sus datos se
marcan como freshness="delayed" porque no hay garantía de tiempo real.
"""

from __future__ import annotations

import math

from app.providers.base import (
    BASIC_FUNDAMENTAL_KEYS,
    DataNotFoundError,
    DataProvider,
    ProviderError,
    iso_utc,
)

_INFO_MAP = {
    "marketCap": "market_cap",
    "trailingPE": "pe_ttm",
    "priceToBook": "pb",
    "priceToSalesTrailing12Months": "ps_ttm",
    "returnOnEquity": "roe",           # ya viene como fracción
    "grossMargins": "gross_margin",
    "operatingMargins": "operating_margin",
    "profitMargins": "net_margin",
    "debtToEquity": "debt_to_equity",  # viene en % (p.ej. 150.3)
    "currentRatio": "current_ratio",
    "dividendYield": "dividend_yield", # viene en % en versiones recientes
    "beta": "beta",
    "fiftyTwoWeekHigh": "week52_high",
    "fiftyTwoWeekLow": "week52_low",
}

_INTERVAL_MAP = {"1day": "1d", "1week": "1wk", "1month": "1mo"}


# Puntos del minigráfico. Suficientes para que se lea la forma de un año sin
# inflar la respuesta: con 500 empresas, cada punto extra son 500 números más.
SPARK_POINTS = 32


def _price_summary(closes) -> dict | None:
    """Precio, variación, rango de 52 semanas y serie, a partir de los cierres.

    Todo sale de la descarga que el momentum ya hacía. Es best-effort: si la
    serie es demasiado corta para un campo, ese campo queda en None en vez de
    inventarse — un dato ausente no es un cero.
    """
    if closes is None or len(closes) == 0:
        return None
    try:
        valores = [float(v) for v in closes.tolist()]
    except (TypeError, ValueError):
        return None
    valores = [v for v in valores if v == v and v not in (float("inf"), float("-inf"))]
    if not valores:
        return None

    last = valores[-1]
    prev = valores[-2] if len(valores) >= 2 else None
    low, high = min(valores), max(valores)

    # Muestreo uniforme: conserva la forma de la serie sin mandarla entera.
    if len(valores) <= SPARK_POINTS:
        spark = valores
    else:
        paso = (len(valores) - 1) / (SPARK_POINTS - 1)
        spark = [valores[round(i * paso)] for i in range(SPARK_POINTS)]

    return {
        "last": round(last, 2),
        "change_pct": round((last / prev - 1) * 100, 2) if prev else None,
        "low_52w": round(low, 2),
        "high_52w": round(high, 2),
        # Dónde está el precio dentro de su rango anual: 0 = mínimo, 1 = máximo.
        "range_position": round((last - low) / (high - low), 3) if high > low else None,
        "spark": [round(v, 2) for v in spark],
        "points": len(valores),
    }


def _clean(value):
    if value is None:
        return None
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    return value


class YFinanceProvider(DataProvider):
    name = "yfinance"
    capabilities = frozenset(
        {"quote", "price_history", "profile", "fundamentals", "etf_data", "bulk_momentum"}
    )

    def _ticker(self, symbol: str):
        import yfinance as yf  # import perezoso: la librería es pesada

        return yf.Ticker(symbol)

    def get_quote(self, symbol: str) -> dict:
        try:
            info = self._ticker(symbol).fast_info
            price = _clean(info.last_price)
            prev = _clean(info.previous_close)
        except Exception as exc:  # yfinance lanza de todo; lo acotamos aquí
            raise ProviderError(f"yfinance: {exc}") from exc
        if price is None:
            raise DataNotFoundError(f"yfinance: sin cotización para {symbol}")
        change = price - prev if prev else None
        return {
            "symbol": symbol.upper(),
            "price": price,
            "change": change,
            "change_pct": (change / prev * 100) if change is not None and prev else None,
            "prev_close": prev,
            "day_high": _clean(getattr(info, "day_high", None)),
            "day_low": _clean(getattr(info, "day_low", None)),
            "day_open": _clean(getattr(info, "open", None)),
            "currency": getattr(info, "currency", None),
            "as_of": iso_utc(),
            "freshness": "delayed",
        }

    def get_price_history(self, symbol: str, interval: str, outputsize: int) -> dict:
        yf_interval = _INTERVAL_MAP.get(interval, "1d")
        try:
            df = self._ticker(symbol).history(
                period="max", interval=yf_interval, auto_adjust=True
            )
        except Exception as exc:
            raise ProviderError(f"yfinance: {exc}") from exc
        if df is None or df.empty:
            raise DataNotFoundError(f"yfinance: sin histórico para {symbol}")
        df = df.tail(outputsize)
        bars = [
            {
                "ts": ts.to_pydatetime().strftime("%Y-%m-%d %H:%M:%S"),
                "open": float(row["Open"]),
                "high": float(row["High"]),
                "low": float(row["Low"]),
                "close": float(row["Close"]),
                "volume": float(row["Volume"]) if not math.isnan(row["Volume"]) else None,
            }
            for ts, row in df.iterrows()
        ]
        return {
            "symbol": symbol.upper(),
            "interval": interval,
            "currency": None,
            "bars": bars,
            "as_of": iso_utc(),
        }

    def get_profile(self, symbol: str) -> dict:
        try:
            info = self._ticker(symbol).info or {}
        except Exception as exc:
            raise ProviderError(f"yfinance: {exc}") from exc
        if not info.get("longName") and not info.get("shortName"):
            raise DataNotFoundError(f"yfinance: sin perfil para {symbol}")
        return {
            "symbol": symbol.upper(),
            "name": info.get("longName") or info.get("shortName"),
            "exchange": info.get("exchange"),
            "sector": info.get("sector"),
            "industry": info.get("industry"),
            "market_cap": _clean(info.get("marketCap")),
            "currency": info.get("currency"),
            "country": info.get("country"),
            "ipo": None,
            "website": info.get("website"),
            "as_of": iso_utc(),
        }

    def get_fundamentals(self, symbol: str) -> dict:
        try:
            info = self._ticker(symbol).info or {}
        except Exception as exc:
            raise ProviderError(f"yfinance: {exc}") from exc
        if not info:
            raise DataNotFoundError(f"yfinance: sin fundamentales para {symbol}")
        metrics: dict[str, float | None] = {k: None for k in BASIC_FUNDAMENTAL_KEYS}
        for yf_key, our_key in _INFO_MAP.items():
            value = _clean(info.get(yf_key))
            if value is None:
                continue
            # Normalización a fracción, igual que el resto de proveedores.
            if our_key in {"debt_to_equity", "dividend_yield"}:
                value = value / 100.0
            metrics[our_key] = value
        return {
            "symbol": symbol.upper(),
            "period": "ttm",
            "metrics": metrics,
            "as_of": iso_utc(),
        }

    def get_bulk_momentum(self, symbols: list[str]) -> dict:
        """Momentum 12-1 de muchos símbolos en UNA sola descarga.

        Clave para el escaneo automático: pedir el histórico de 30 empresas a
        Twelve Data costaría 30 créditos y ~4 minutos por su límite de 8/min.
        yfinance descarga todo el bloque de golpe y gratis. Para momentum (un
        cociente entre dos precios pasados) su precisión sobra.

        Devuelve además `prices`: la descarga ya trae un año de cierres diarios
        por empresa y el momentum solo usa dos puntos. Sacar de ahí el último
        cierre, la variación, el rango de 52 semanas y una serie para el
        minigráfico **no cuesta ninguna llamada adicional** — es aprovechar
        datos que ya estaban pagados.
        """
        import yfinance as yf

        if not symbols:
            return {"momentum": {}, "prices": {}, "as_of": iso_utc()}
        try:
            data = yf.download(
                " ".join(symbols),
                period="1y",
                interval="1d",
                auto_adjust=True,
                progress=False,
                group_by="ticker",
                threads=True,
            )
        except Exception as exc:
            raise ProviderError(f"yfinance: descarga masiva falló: {exc}") from exc
        if data is None or data.empty:
            raise DataNotFoundError("yfinance: sin datos para el universo")

        out: dict[str, float | None] = {}
        prices: dict[str, dict | None] = {}
        for symbol in symbols:
            try:
                # Con un solo símbolo yfinance no agrupa por ticker.
                closes = (
                    data["Close"] if len(symbols) == 1 else data[symbol]["Close"]
                ).dropna()
            except (KeyError, TypeError):
                out[symbol] = None
                prices[symbol] = None
                continue

            prices[symbol] = _price_summary(closes)

            # ~252 sesiones/año, ~21/mes: de t−12m a t−1m (se excluye el último
            # mes para evitar la reversión de corto plazo).
            if len(closes) < 200:
                out[symbol] = None
                continue
            start, end = closes.iloc[0], closes.iloc[-21]
            out[symbol] = (end / start - 1) if start else None
        return {"momentum": out, "prices": prices, "as_of": iso_utc()}

    def get_etf_data(self, symbol: str) -> dict:
        """Composición de ETF vía Yahoo. Es la única fuente gratuita razonable
        (los endpoints de ETF de Finnhub son de pago), con dos límites que la
        UI debe dejar claros: solo llegan los ~10 mayores holdings y los datos
        pueden traer retraso. Todo es best-effort: lo que falte queda en None.
        """
        try:
            ticker = self._ticker(symbol)
            info = ticker.info or {}
        except Exception as exc:
            raise ProviderError(f"yfinance: {exc}") from exc
        if info.get("quoteType") != "ETF":
            raise DataNotFoundError(f"yfinance: {symbol} no es un ETF según Yahoo")

        top_holdings: list[dict] = []
        sector_weights: dict[str, float] = {}
        try:
            funds = ticker.funds_data
            holdings_df = funds.top_holdings
            if holdings_df is not None:
                for sym, row in holdings_df.iterrows():
                    top_holdings.append(
                        {
                            "symbol": str(sym),
                            "name": row.get("Name"),
                            "weight": _clean(row.get("Holding Percent")),
                        }
                    )
            sector_weights = {
                k: v for k, v in (funds.sector_weightings or {}).items() if v
            }
        except Exception:
            pass  # sin composición: se reporta vacío, no se inventa

        expense = _clean(info.get("netExpenseRatio"))
        return {
            "symbol": symbol.upper(),
            "name": info.get("longName") or info.get("shortName"),
            "category": info.get("category"),
            # Yahoo reporta el expense ratio en puntos porcentuales (0.09 = 0.09 %).
            "expense_ratio": expense / 100.0 if expense is not None else None,
            "aum": _clean(info.get("totalAssets")),
            "dividend_yield": _clean(info.get("yield")),
            "currency": info.get("currency"),
            "top_holdings": top_holdings,
            "sector_weights": sector_weights,
            "as_of": iso_utc(),
        }
