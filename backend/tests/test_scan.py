"""Tests del escaneo automático de universos."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.analysis.universes import UNIVERSES, get_universe, list_universes
from app.db.engine import get_session
from app.deps import get_llm, get_service
from app.main import app
from app.providers.base import DataNotFoundError, iso_utc


def test_universos_bien_formados():
    assert len(UNIVERSES) >= 5
    for key, data in UNIVERSES.items():
        assert data["name"] and data["description"], key
        assert len(data["symbols"]) >= 15, key
        # Sin duplicados dentro de un universo (sesgarían los z-scores).
        assert len(data["symbols"]) == len(set(data["symbols"])), key


def test_hay_universos_sectoriales():
    # Comparar dentro de un sector es la forma recomendada de usar el modelo.
    for key in ("tecnologia", "salud", "financiero"):
        assert key in UNIVERSES


def test_universo_desconocido():
    with pytest.raises(KeyError):
        get_universe("no_existe")


def test_listado_incluye_tamano():
    listado = list_universes()
    assert all(u["size"] == len(u["symbols"]) for u in listado)


# ---------------------------------------------------------------------------
# Endpoint de escaneo
# ---------------------------------------------------------------------------


class ScanService:
    """Simula el universo con datos deterministas y momentum masivo."""

    def __init__(self, failing: set[str] | None = None):
        self.failing = failing or set()
        self.bulk_calls = 0
        self.profile_calls = 0

    def get(self, data_type, **kwargs):
        common = {"source": "fake", "as_of": iso_utc(), "cached": False}
        if data_type == "bulk_momentum":
            self.bulk_calls += 1
            symbols = kwargs["symbols"]
            return {
                **common,
                "momentum": {s: (i % 7) / 10 - 0.3 for i, s in enumerate(symbols)},
            }
        symbol = kwargs.get("symbol", "")
        if symbol in self.failing:
            raise DataNotFoundError(f"sin datos para {symbol}")
        if data_type == "fundamentals":
            seed = sum(ord(c) for c in symbol)
            return {
                **common,
                "symbol": symbol,
                "period": "ttm",
                "metrics": {
                    "pe_ttm": 8 + seed % 30,
                    "pb": 1 + (seed % 60) / 10,
                    "roe": (seed % 25) / 100,
                    "operating_margin": (seed % 35) / 100,
                    "debt_to_equity": (seed % 30) / 10,
                    "market_cap": 1e9 + seed * 1e7,
                },
            }
        if data_type == "profile":
            self.profile_calls += 1
            return {**common, "symbol": symbol, "name": f"{symbol} Inc", "sector": "Tech"}
        raise DataNotFoundError(f"tipo no simulado: {data_type}")


@pytest.fixture
def client(session_factory):
    service = ScanService()

    def override_session():
        session = session_factory()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_service] = lambda: service
    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_llm] = lambda: None
    with TestClient(app) as c:
        yield c, service
    app.dependency_overrides.clear()


def test_listar_universos(client):
    c, _ = client
    data = c.get("/api/signals/universes").json()
    assert len(data["universes"]) >= 5
    assert any(u["key"] == "tecnologia" for u in data["universes"])


def test_escaneo_devuelve_ranking_completo_y_finalistas(client):
    c, _ = client
    data = c.post("/api/signals/scan", json={"universe": "tecnologia", "top_n": 5}).json()

    assert data["universe_name"] == "Tecnología"
    assert len(data["top"]) == 5
    assert data["scored"] == data["requested"]
    # El ranking completo cubre todo el universo, no solo las finalistas.
    assert len(data["all_ranked"]) == data["scored"]
    # Ordenado de mejor a peor.
    scores = [s["score"] for s in data["top"]]
    assert scores == sorted(scores, reverse=True)
    assert data["top"][0]["rank"] == 1


def test_momentum_se_pide_una_sola_vez_para_todo_el_universo(client):
    """La palanca de coste: 1 descarga en vez de N llamadas a Twelve Data."""
    c, service = client
    c.post("/api/signals/scan", json={"universe": "salud", "top_n": 5})
    assert service.bulk_calls == 1


def test_perfil_solo_se_pide_para_las_finalistas(client):
    """Pedir el nombre de las 20 costaría 20 llamadas por pura cosmética."""
    c, service = client
    data = c.post("/api/signals/scan", json={"universe": "salud", "top_n": 4}).json()
    assert service.profile_calls == 4
    assert data["scored"] > 4  # se puntuaron muchas más de las que se nombran


def test_escaneo_sin_calibrar_no_publica_probabilidades(client):
    c, _ = client
    data = c.post("/api/signals/scan", json={"universe": "consumo", "top_n": 5}).json()
    assert data["calibrated"] is False
    for signal in data["top"]:
        assert signal["probability"] is None


def test_el_disclaimer_niega_que_sea_lista_de_compra(client):
    c, _ = client
    data = c.post("/api/signals/scan", json={"universe": "megacaps", "top_n": 5}).json()
    assert "NO es una lista de compra" in data["disclaimer"]


def test_fallos_parciales_no_tumban_el_escaneo(session_factory):
    """Si algunas empresas fallan, se puntúan las demás y se reportan las que no."""
    universe = get_universe("salud")["symbols"]
    service = ScanService(failing=set(universe[:5]))

    def override_session():
        session = session_factory()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_service] = lambda: service
    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_llm] = lambda: None
    try:
        with TestClient(app) as c:
            data = c.post("/api/signals/scan", json={"universe": "salud", "top_n": 5}).json()
            assert data["scored"] == len(universe) - 5
            assert len(data["unavailable"]) == 5
            assert len(data["top"]) == 5  # sigue habiendo ranking
    finally:
        app.dependency_overrides.clear()


def test_universo_inexistente_da_404(client):
    c, _ = client
    assert c.post("/api/signals/scan", json={"universe": "cripto"}).status_code == 404


def test_watchlist_vacia_explica_por_que_no_puede(client):
    c, _ = client
    resp = c.post("/api/signals/scan", json={"universe": "watchlist"})
    assert resp.status_code == 422
    assert "menos de 3" in resp.json()["detail"]
