"""Tests del API HTTP completo con el servicio de datos simulado.

Valida el contrato de los endpoints (códigos, campos obligatorios de fuente y
frescura) y el cálculo de indicadores del endpoint de histórico, sin tocar
ninguna API externa.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.deps import get_service
from app.main import app
from app.providers.base import DataNotFoundError, iso_utc


class FakeService:
    def __init__(self):
        base_price = 100.0
        self.bars = [
            {
                "ts": f"2025-{(i // 28) + 1:02d}-{(i % 28) + 1:02d} 00:00:00",
                "open": base_price + i,
                "high": base_price + i + 1,
                "low": base_price + i - 1,
                "close": base_price + i + 0.5,
                "volume": 1000.0 + i,
            }
            for i in range(60)
        ]

    def get(self, data_type, **kwargs):
        symbol = kwargs.get("symbol", "")
        if symbol == "NOEXISTE":
            raise DataNotFoundError("símbolo no encontrado")
        common = {"source": "fake", "as_of": iso_utc(), "cached": False, "fetched_at": iso_utc()}
        if data_type == "quote":
            return {
                **common,
                "symbol": symbol,
                "price": 190.5,
                "change": 1.5,
                "change_pct": 0.79,
                "prev_close": 189.0,
                "freshness": "live",
            }
        if data_type == "price_history":
            return {
                **common,
                "symbol": symbol,
                "interval": kwargs["interval"],
                "currency": "USD",
                "bars": self.bars[: kwargs["outputsize"]],
            }
        if data_type == "fundamentals":
            return {**common, "symbol": symbol, "period": "ttm", "metrics": {"pe_ttm": 25.3}}
        if data_type == "profile":
            return {**common, "symbol": symbol, "name": "Fake Corp"}
        raise AssertionError(f"tipo inesperado: {data_type}")


@pytest.fixture
def client():
    app.dependency_overrides[get_service] = FakeService
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def test_quote_incluye_fuente_y_frescura(client):
    resp = client.get("/api/stocks/AAPL/quote")
    assert resp.status_code == 200
    data = resp.json()
    assert data["symbol"] == "AAPL"
    assert data["source"] == "fake"
    assert data["freshness"] == "live"
    assert data["as_of"]  # nunca una cifra sin fecha


def test_simbolo_invalido_es_422(client):
    assert client.get("/api/stocks/@@@/quote").status_code == 422


def test_simbolo_inexistente_es_404(client):
    assert client.get("/api/stocks/NOEXISTE/quote").status_code == 404


def test_history_calcula_indicadores_alineados(client):
    resp = client.get("/api/stocks/AAPL/history?range=1M")
    assert resp.status_code == 200
    data = resp.json()
    n = len(data["bars"])
    assert n == 22  # rango 1M = 22 barras diarias
    ind = data["indicators"]
    # Toda serie de indicadores va alineada barra a barra.
    for key in ("sma20", "sma50", "sma200", "rsi14"):
        assert len(ind[key]) == n
    assert len(ind["macd"]["macd"]) == n
    # Con 22 barras: SMA20 definida al final, SMA50 aún no.
    assert ind["sma20"][-1] is not None
    assert ind["sma20"][0] is None
    assert all(v is None for v in ind["sma50"])
    # Serie estrictamente alcista → RSI saturado en 100.
    assert ind["rsi14"][-1] == pytest.approx(100.0)


def test_history_valida_rango(client):
    assert client.get("/api/stocks/AAPL/history?range=3D").status_code == 422
