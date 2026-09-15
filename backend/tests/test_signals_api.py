"""Tests de integración del endpoint de señales.

Lo que más importa aquí: sin backtest previo, la API **no** debe devolver
ninguna probabilidad, por muy alta que sea la puntuación.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.db.engine import get_session
from app.deps import get_llm, get_service
from app.main import app
from app.providers.base import iso_utc

METRICS = {
    "A": {"pe_ttm": 10.0, "pb": 1.0, "roe": 0.25, "operating_margin": 0.30,
          "debt_to_equity": 0.2, "market_cap": 1e9},
    "B": {"pe_ttm": 25.0, "pb": 4.0, "roe": 0.12, "operating_margin": 0.15,
          "debt_to_equity": 1.0, "market_cap": 2e9},
    "C": {"pe_ttm": 40.0, "pb": 8.0, "roe": 0.05, "operating_margin": 0.05,
          "debt_to_equity": 3.0, "market_cap": 5e8},
    "D": {"pe_ttm": 18.0, "pb": 2.5, "roe": 0.18, "operating_margin": 0.22,
          "debt_to_equity": 0.6, "market_cap": 3e9},
}


class FakeService:
    def get(self, data_type, **kwargs):
        symbol = kwargs.get("symbol", "")
        common = {"source": "fake", "as_of": iso_utc(), "cached": False}
        if data_type == "fundamentals":
            if symbol not in METRICS:
                from app.providers.base import DataNotFoundError

                raise DataNotFoundError(f"sin datos para {symbol}")
            return {**common, "symbol": symbol, "period": "ttm", "metrics": dict(METRICS[symbol])}
        if data_type == "price_history":
            # Serie alcista distinta por símbolo para que el momentum difiera.
            drift = {"A": 0.0015, "B": 0.0005, "C": -0.001, "D": 0.001}.get(symbol, 0.0)
            return {
                **common,
                "symbol": symbol,
                "bars": [
                    {"ts": f"2024-01-01 00:00:00", "close": 100 * (1 + drift) ** i}
                    for i in range(252)
                ],
            }
        if data_type == "profile":
            return {**common, "symbol": symbol, "name": f"{symbol} Corp", "sector": "Tech"}
        if data_type == "financials":
            from app.providers.base import DataNotFoundError

            raise DataNotFoundError("sin EDGAR en el test")
        from app.providers.base import DataNotFoundError

        raise DataNotFoundError(f"tipo no simulado: {data_type}")


@pytest.fixture
def client(session_factory):
    def override_session():
        session = session_factory()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_service] = FakeService
    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_llm] = lambda: None
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def test_puntua_y_ordena_el_universo(client):
    resp = client.post("/api/signals/score", json={"symbols": ["A", "B", "C", "D"]})
    assert resp.status_code == 200
    data = resp.json()

    assert data["universe_size"] == 4
    signals = data["signals"]
    # A es la más barata, rentable y con más momentum → debe encabezar.
    assert signals[0]["symbol"] == "A"
    assert signals[0]["rank"] == 1
    # C es la más cara, menos rentable y con momentum negativo → última.
    assert signals[-1]["symbol"] == "C"
    assert signals[0]["score"] > signals[-1]["score"]


def test_sin_backtest_no_hay_probabilidad(client):
    """La regla que sostiene toda la honestidad del módulo."""
    data = client.post("/api/signals/score", json={"symbols": ["A", "B", "C", "D"]}).json()
    assert data["calibrated"] is False
    for signal in data["signals"]:
        assert signal["probability"] is None
        assert signal["probability_ci"] is None
        assert "sin calibrar" in (signal["probability_note"] or "")


def test_las_senales_no_dicen_comprar(client):
    data = client.post("/api/signals/score", json={"symbols": ["A", "B", "C", "D"]}).json()
    etiquetas = {s["label"] for s in data["signals"]}
    assert not any("compr" in e.lower() or "vend" in e.lower() for e in etiquetas)
    assert "no asesoría" in data["disclaimer"] or "no asesoría" in data["disclaimer"].lower()


def test_atribucion_por_familia_presente(client):
    data = client.post("/api/signals/score", json={"symbols": ["A", "B", "C", "D"]}).json()
    top = data["signals"][0]
    assert top["contributions"]  # se puede explicar de dónde viene la puntuación
    assert sum(top["contributions"].values()) == pytest.approx(top["score"])
    assert 0 < top["coverage"] <= 1.0


def test_universo_pequeno_se_rechaza(client):
    resp = client.post("/api/signals/score", json={"symbols": ["A", "B"]})
    assert resp.status_code == 422


def test_simbolos_sin_datos_se_reportan(client):
    resp = client.post("/api/signals/score", json={"symbols": ["A", "B", "C", "ZZZZ"]})
    data = resp.json()
    assert any(u["symbol"] == "ZZZZ" for u in data["unavailable"])
    assert data["universe_size"] == 3


def test_explicacion_requiere_llm_configurado(client):
    resp = client.post(
        "/api/signals/A/explain",
        json={"signal": {"symbol": "A", "score": 1.0, "label": "favorable"}},
    )
    assert resp.status_code == 503
    assert "ANTHROPIC_API_KEY" in resp.json()["detail"]


def test_backtest_sin_edgar_avisa_en_vez_de_inventar(client):
    resp = client.post("/api/signals/backtest", json={"symbols": ["A", "B", "C"]})
    assert resp.status_code == 422
    assert "EDGAR" in resp.json()["detail"]
