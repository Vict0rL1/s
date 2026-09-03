"""El peor escenario histórico sobre la cartera actual, servido de verdad.

`peor_ventana` y `con_caida_esperada` estaban escritas y probadas, y no las
llamaba ningún endpoint: existían en el repositorio y no en la aplicación. Un
número de riesgo que nadie ve no protege de nada, así que lo que estos tests
fijan es que el portafolio lo devuelva — y que cuando no pueda calcularlo lo
diga en vez de enseñar una rentabilidad a secas.
"""

from __future__ import annotations

import math
import random
from datetime import date, datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.db.engine import get_session
from app.db.models import Instrument, Position
from app.deps import get_service
from app.main import app
from app.providers.base import iso_utc
from tests.test_scan import FakeCache


def _historico(semilla: int, dias: int = 252) -> list[dict]:
    """Barras diarias con la misma forma que devuelve el proveedor real."""
    rng = random.Random(semilla)
    inicio = date.today() - timedelta(days=dias)
    barras, p = [], 100.0
    for i in range(dias):
        p *= math.exp(rng.gauss(0.0002, 0.02))
        barras.append(
            {"ts": f"{inicio + timedelta(days=i)} 00:00:00", "close": round(p, 4)}
        )
    return barras


class FakeService:
    def __init__(self, con_historico=("AAPL", "MSFT")):
        self.cache = FakeCache()
        for i, symbol in enumerate(con_historico):
            self.cache.set(
                "price_history",
                {"symbol": symbol, "interval": "1day", "outputsize": 252},
                {"symbol": symbol, "bars": _historico(i + 1)},
            )

    def get(self, data_type, **kwargs):
        common = {"source": "fake", "as_of": iso_utc(), "cached": False}
        if data_type == "quote":
            return {**common, "symbol": kwargs["symbol"], "price": 120.0}
        if data_type == "profile":
            return {
                **common,
                "symbol": kwargs["symbol"],
                "name": "Fake Corp",
                "sector": "Tech",
            }
        raise AssertionError(f"tipo inesperado: {data_type}")


@pytest.fixture
def client(session_factory):
    def override_session():
        session = session_factory()
        try:
            yield session
        finally:
            session.close()

    def _hacer(simbolos_con_historico=("AAPL", "MSFT")):
        service = FakeService(simbolos_con_historico)
        session = session_factory()
        for symbol in ("AAPL", "MSFT"):
            instrument = Instrument(symbol=symbol, name=symbol, sector="Tech")
            session.add(instrument)
            session.flush()
            session.add(
                Position(
                    instrument_id=instrument.id,
                    quantity=10,
                    cost_basis=100.0,
                    opened_at=datetime.now(timezone.utc),
                )
            )
        session.commit()
        session.close()

        app.dependency_overrides[get_service] = lambda: service
        app.dependency_overrides[get_session] = override_session
        return TestClient(app)

    yield _hacer
    app.dependency_overrides.clear()


def test_el_portafolio_estresa_la_cartera_actual_contra_el_historico(client):
    r = client().get("/api/portfolio").json()
    estres = r["estres"]
    assert estres["suficiente"] is True
    assert estres["max_drawdown_pct"] < 0
    assert estres["drawdown_desde"] < estres["drawdown_hasta"]
    assert estres["años_cubiertos"] > 0


def test_ninguna_rentabilidad_viaja_sin_su_caida_al_lado(client):
    """«+12 %» y «+12 % con un −45 % por el camino» son propuestas distintas."""
    resumen = client().get("/api/portfolio").json()["summary"]
    assert resumen["unrealized_pct"] is not None
    assert "max_drawdown_esperado_pct" in resumen
    assert resumen["max_drawdown_esperado_pct"] < 0
    assert "aviso_cobertura" in resumen


def test_el_aviso_nombra_las_crisis_que_el_historico_no_vio(client):
    """Un «peor caso» de un año no es el peor caso: es el peor de lo que dio
    tiempo a pasar."""
    aviso = client().get("/api/portfolio").json()["estres"]["aviso_cobertura"]
    assert "NO ha vivido" in aviso
    assert "2008" in aviso


def test_sin_historico_en_cache_se_dice_en_vez_de_enseñar_un_retorno_pelado(client):
    """No se descarga nada para esto: si el histórico no está guardado, la
    rentabilidad sale marcada como no interpretable, no acompañada de un cero."""
    r = client(simbolos_con_historico=()).get("/api/portfolio").json()
    assert r["estres"]["suficiente"] is False
    assert r["summary"]["max_drawdown_esperado_pct"] is None
    assert "no se puede interpretar" in r["summary"]["aviso_cobertura"]
