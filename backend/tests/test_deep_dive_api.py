"""Test de integración del endpoint de informe de analista."""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from app.db.engine import get_session
from app.deps import get_llm, get_service
from app.main import app
from app.providers.base import DataNotFoundError, iso_utc


def _periods(n=8):
    out = []
    for i in range(n):
        revenue = 1000.0 * (1.09**i)
        out.append(
            {
                "fiscal_year": str(2016 + i),
                "end_date": f"{2016 + i}-12-31",
                "revenue": revenue,
                "gross_profit": revenue * 0.55,
                "operating_income": revenue * 0.22,
                "net_income": revenue * 0.16,
                "eps_diluted": 2.0 * (1.09**i),
                "equity": revenue * 0.9,
                "total_assets": revenue * 2.1,
                "total_liabilities": revenue * 1.2,
                "current_assets": revenue * 0.7,
                "current_liabilities": revenue * 0.35,
                "long_term_debt": revenue * 0.3,
                "short_term_debt": revenue * 0.05,
                "cash": revenue * 0.25,
                "retained_earnings": revenue * 0.6,
                "interest_expense": revenue * 0.015,
                "cfo": revenue * 0.20,
                "capex": revenue * 0.05,
                "shares_outstanding": 100.0,
            }
        )
    return out


class DeepDiveService:
    def get(self, data_type, **kwargs):
        common = {"source": "fake", "as_of": iso_utc(), "cached": False}
        symbol = kwargs.get("symbol", "")
        if data_type == "financials":
            if symbol == "NOSEC":
                raise DataNotFoundError("edgar: no registrada en la SEC")
            return {**common, "symbol": symbol, "periods": _periods()}
        if data_type == "profile":
            return {
                **common, "symbol": symbol, "name": f"{symbol} Corp",
                "sector": "Technology", "market_cap": 8000.0, "country": "US",
            }
        if data_type == "quote":
            return {**common, "symbol": symbol, "price": 45.0, "freshness": "live"}
        if data_type == "price_history":
            return {
                **common, "symbol": symbol,
                "bars": [
                    {
                        "ts": (date(2019, 1, 1) + timedelta(days=i)).isoformat(),
                        "close": 30.0 + i * 0.01,
                    }
                    for i in range(1500)
                ],
            }
        if data_type == "filings":
            return {
                **common, "symbol": symbol,
                "filings": [
                    {"type": "10-K", "filed_at": f"{2017 + i}-02-15",
                     "accession_no": f"a{i}", "url": "https://sec.gov/x"}
                    for i in range(8)
                ],
                "insider_filings": [],
            }
        if data_type == "fundamentals":
            return {
                **common, "symbol": symbol, "period": "ttm",
                "metrics": {"pe_ttm": 15.0, "pb": 2.0, "roe": 0.18,
                            "operating_margin": 0.22, "debt_to_equity": 0.4,
                            "market_cap": 8000.0},
            }
        if data_type == "peers":
            return {**common, "symbol": symbol, "peers": ["P1", "P2", "P3"]}
        if data_type == "earnings_calendar":
            return {
                **common,
                "events": [{"symbol": "AAPL", "date": "2026-09-30",
                            "eps_estimate": 2.1, "hour": "amc"}],
            }
        raise DataNotFoundError(f"tipo no simulado: {data_type}")


@pytest.fixture
def client(session_factory):
    def override_session():
        session = session_factory()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_service] = DeepDiveService
    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_llm] = lambda: None
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def test_informe_trae_todas_las_secciones(client):
    data = client.get("/api/deep-dive/AAPL").json()
    for section in (
        "business", "growth", "margins", "debt", "cash_flow",
        "valuation", "risks", "catalysts", "verdict", "quant_signal",
    ):
        assert section in data, section
    assert data["computed_by"] == "app"  # todo calculado, nada de IA
    assert data["generated_at"]


def test_valoracion_contra_su_historia_se_calcula(client):
    data = client.get("/api/deep-dive/AAPL").json()
    pe = data["valuation"]["multiples"]["pe"]
    assert pe["available"] is True
    assert pe["n"] >= 12
    assert pe["current"] is not None
    assert pe["median"] is not None
    assert data["valuation"]["cheapness_score"] is not None
    # Y siempre viaja con la advertencia del value trap.
    assert any("declive estructural" in c for c in data["valuation"]["caveats"])


def test_veredicto_lleva_invalidadores_y_disclaimer(client):
    verdict = client.get("/api/deep-dive/AAPL").json()["verdict"]
    assert verdict["stance"] in {"constructiva", "cautelosa", "mixta"}
    assert len(verdict["what_would_change_it"]) >= 4
    assert "no una recomendación de compra o venta" in verdict["disclaimer"]


def test_dcf_precargado_con_escenarios(client):
    dcf = client.get("/api/deep-dive/AAPL").json()["dcf"]
    assert dcf is not None
    assert set(dcf["scenarios"]) == {"bear", "base", "bull"}
    valores = [dcf["scenarios"][k]["value_per_share"] for k in ("bear", "base", "bull")]
    assert valores[0] < valores[1] < valores[2]  # ordenados por construcción


def test_crecimiento_y_margenes_coherentes_con_los_datos(client):
    data = client.get("/api/deep-dive/AAPL").json()
    # Serie construida con +9 % anual.
    assert data["growth"]["revenue_cagr"] == pytest.approx(0.09, abs=1e-6)
    assert data["margins"]["current"]["operating_margin"] == pytest.approx(0.22, abs=1e-6)
    assert data["margins"]["trends"]["operating_margin"] == "estable"


def test_empresa_fuera_de_la_sec_da_404_explicativo(client):
    resp = client.get("/api/deep-dive/NOSEC")
    assert resp.status_code == 404
    assert "EDGAR" in resp.json()["detail"]


def test_narrativa_requiere_llm(client):
    resp = client.post("/api/deep-dive/AAPL/narrative", json={"business": {}})
    assert resp.status_code == 503
    assert "ANTHROPIC_API_KEY" in resp.json()["detail"]
