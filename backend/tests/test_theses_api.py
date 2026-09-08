"""Test de integración del flujo de tesis → escenario → registro de aciertos."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.db.engine import get_session
from app.deps import get_service
from app.main import app
from app.providers.base import iso_utc


class FakeService:
    """Servicio de datos simulado con precio controlable."""

    def __init__(self):
        self.price = 100.0

    def get(self, data_type, **kwargs):
        common = {"source": "fake", "as_of": iso_utc(), "cached": False}
        if data_type == "quote":
            return {**common, "symbol": kwargs["symbol"], "price": self.price}
        if data_type == "profile":
            return {**common, "symbol": kwargs["symbol"], "name": "Fake Corp", "sector": "Tech"}
        raise AssertionError(f"tipo inesperado: {data_type}")


@pytest.fixture
def client(session_factory):
    service = FakeService()

    def override_session():
        session = session_factory()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_service] = lambda: service
    app.dependency_overrides[get_session] = override_session
    with TestClient(app) as c:
        yield c, service
    app.dependency_overrides.clear()


def test_flujo_completo_tesis_escenario_registro(client):
    c, service = client

    # 1. Crear una tesis con criterios de invalidación.
    resp = c.post(
        "/api/theses",
        json={
            "symbol": "AAPL",
            "title": "Márgenes de servicios en expansión",
            "body_md": "El mix hacia servicios sostiene el margen.",
            "invalidation_criteria": "Si el margen bruto cae dos trimestres seguidos.",
        },
    )
    assert resp.status_code == 200
    thesis_id = resp.json()["id"]

    # 2. Añadir un escenario alcista: ancla el precio de hoy (100).
    resp = c.post(
        f"/api/theses/{thesis_id}/scenarios",
        json={"kind": "bull", "assumptions": {"growth_rate": 0.10}, "value_mid": 130.0},
    )
    assert resp.status_code == 200
    assert resp.json()["price_at_creation"] == 100.0
    assert resp.json()["warning"] is None

    # 3. El precio sube a 120: el escenario alcista acertó la dirección.
    service.price = 120.0
    record = c.get("/api/theses/track-record").json()
    assert record["summary"]["hit_rate"] == pytest.approx(1.0)
    assert record["scenarios"][0]["outcome"] == "acertado"
    assert record["scenarios"][0]["price_at_creation"] == 100.0

    # 4. El precio se desploma: el mismo escenario ahora consta como fallido.
    service.price = 60.0
    record = c.get("/api/theses/track-record").json()
    assert record["scenarios"][0]["outcome"] == "fallido"
    assert record["summary"]["hit_rate"] == pytest.approx(0.0)

    # 5. La tesis conserva sus criterios de invalidación y su antigüedad.
    theses = c.get("/api/theses").json()["theses"]
    assert theses[0]["invalidation_criteria"].startswith("Si el margen bruto")
    assert theses[0]["days_elapsed"] == 0
    assert theses[0]["scenarios"][0]["outcome"] == "fallido"


def test_escenario_sin_precio_avisa_que_no_sera_evaluable(client, monkeypatch):
    c, service = client
    thesis_id = c.post(
        "/api/theses",
        json={"symbol": "XYZ", "title": "T", "body_md": "cuerpo"},
    ).json()["id"]

    # El proveedor deja de dar precio: el escenario se guarda, pero avisado.
    from app.providers.base import DataNotFoundError

    def sin_precio(data_type, **kwargs):
        if data_type == "quote":
            raise DataNotFoundError("sin cotización")
        return {"source": "fake", "as_of": iso_utc(), "symbol": kwargs.get("symbol")}

    monkeypatch.setattr(service, "get", sin_precio)
    resp = c.post(
        f"/api/theses/{thesis_id}/scenarios",
        json={"kind": "base", "assumptions": {}, "value_mid": 50.0},
    )
    assert resp.json()["price_at_creation"] is None
    assert "no será evaluable" in resp.json()["warning"]


def test_portafolio_calcula_pnl_y_pesos(client):
    c, service = client
    c.post("/api/portfolio/positions", json={"symbol": "AAPL", "quantity": 10, "cost_basis": 90.0})
    service.price = 100.0

    data = c.get("/api/portfolio").json()
    assert data["summary"]["total_invested"] == pytest.approx(900.0)
    assert data["summary"]["total_market_value"] == pytest.approx(1000.0)
    assert data["summary"]["unrealized_pnl"] == pytest.approx(100.0)
    assert data["allocation_by_sector"][0]["label"] == "Tech"
    assert data["concentration_warnings"]  # una sola posición = 100 %


def test_cerrar_posicion_registra_pnl_realizado(client):
    c, service = client
    position_id = c.post(
        "/api/portfolio/positions",
        json={"symbol": "KO", "quantity": 5, "cost_basis": 50.0},
    ).json()["id"]

    resp = c.post(f"/api/portfolio/positions/{position_id}/close", json={"exit_price": 70.0})
    assert resp.json()["realized_pnl"] == pytest.approx(100.0)  # (70−50)×5

    data = c.get("/api/portfolio").json()
    assert data["summary"]["realized_pnl"] == pytest.approx(100.0)
    assert data["positions"] == []  # ya no está abierta
    # Cerrarla otra vez no debe duplicar el P&L.
    assert c.post(f"/api/portfolio/positions/{position_id}/close", json={"exit_price": 80.0}).status_code == 409


def test_watchlist_no_admite_duplicados(client):
    c, _ = client
    assert c.post("/api/watchlist", json={"symbol": "MSFT"}).status_code == 200
    assert c.post("/api/watchlist", json={"symbol": "MSFT"}).status_code == 409
    assert len(c.get("/api/watchlist").json()["items"]) == 1
