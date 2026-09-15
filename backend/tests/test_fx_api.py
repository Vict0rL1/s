"""La cartera con varias divisas, servida de verdad por `/api/portfolio`.

El módulo `fx` puede estar perfecto y no arreglar nada si el endpoint sigue
sumando los importes sin convertir. Lo que fijan estos tests es que el total que
llega a pantalla sea el convertido, y que lo que no se puede convertir quede
fuera y se diga.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app.db.engine import get_session
from app.db.models import Instrument, Position
from app.deps import get_service
from app.main import app
from app.providers.base import DataNotFoundError, iso_utc
from tests.test_scan import FakeCache


class FakeService:
    def __init__(self, precios: dict[str, tuple[float, str]], con_fred=True):
        self.cache = FakeCache()
        self.precios = precios
        self.con_fred = con_fred
        self.llamadas: list[str] = []

    def get(self, data_type, **kw):
        self.llamadas.append(f"{data_type}:{kw.get('symbol') or kw.get('series_id', '')}")
        common = {"source": "fake", "as_of": iso_utc(), "cached": False}
        if data_type == "quote":
            sym = kw["symbol"]
            if sym not in self.precios:
                raise DataNotFoundError(f"sin cotización para {sym}")
            precio, moneda = self.precios[sym]
            return {**common, "symbol": sym, "price": precio, "currency": moneda,
                    "change": 0.0, "change_pct": 0.0, "prev_close": precio}
        if data_type == "macro":
            if not self.con_fred:
                raise DataNotFoundError("FRED no disponible")
            # DEXCAUS: dólares canadienses por UN dólar estadounidense.
            valores = {"DEXCAUS": "1.37", "DEXUSEU": "1.08"}
            sid = kw["series_id"]
            if sid not in valores:
                raise DataNotFoundError(f"serie {sid} no simulada")
            return {**common, "series_id": sid,
                    "points": [{"ts": "2026-09-11", "value": valores[sid]}]}
        if data_type == "profile":
            return {**common, "symbol": kw["symbol"], "name": kw["symbol"], "sector": "Tech"}
        raise AssertionError(f"tipo inesperado: {data_type}")


@pytest.fixture
def client(session_factory):
    def override_session():
        s = session_factory()
        try:
            yield s
        finally:
            s.close()

    def _hacer(posiciones, **kw):
        service = FakeService(**kw)
        session = session_factory()
        for symbol, cantidad, coste in posiciones:
            inst = Instrument(symbol=symbol, name=symbol, sector="Tech")
            session.add(inst)
            session.flush()
            session.add(Position(instrument_id=inst.id, quantity=cantidad,
                                 cost_basis=coste, opened_at=datetime.now(timezone.utc)))
        session.commit()
        session.close()
        app.dependency_overrides[get_service] = lambda: service
        app.dependency_overrides[get_session] = override_session
        return TestClient(app), service

    yield _hacer
    app.dependency_overrides.clear()


def test_una_cartera_mezclada_ya_no_suma_manzanas_con_peras(client):
    """El bug entero: 100 USD + 137 CAD son 200 USD, no 237."""
    c, _ = client(
        [("AAPL", 1, 80.0), ("SHOP", 1, 100.0)],
        precios={"AAPL": (100.0, "USD"), "SHOP": (137.0, "CAD")},
    )
    r = c.get("/api/portfolio").json()

    assert r["summary"]["total_market_value"] == pytest.approx(200.0)
    assert r["summary"]["total_market_value"] != pytest.approx(237.0)
    assert r["divisas"]["mezcla_de_divisas"] is True
    assert r["divisas"]["base"] == "USD"


def test_los_pesos_tambien_salen_de_los_importes_convertidos(client):
    """De un total mal calculado cuelgan los pesos, la concentración y el
    presupuesto de riesgo: arreglar solo el total no arreglaba nada."""
    c, _ = client(
        [("AAPL", 1, 80.0), ("SHOP", 1, 100.0)],
        precios={"AAPL": (100.0, "USD"), "SHOP": (137.0, "CAD")},
    )
    pesos = {p["label"]: p["weight"] for p in c.get("/api/portfolio").json()["allocation_by_position"]}
    # 100 USD y 100 USD: mitad y mitad. Sin convertir daría 42 % / 58 %.
    assert pesos["AAPL"] == pytest.approx(0.5, abs=0.001)
    assert pesos["SHOP"] == pytest.approx(0.5, abs=0.001)


def test_una_cartera_de_una_sola_divisa_no_cambia_de_comportamiento(client):
    c, service = client(
        [("AAPL", 2, 80.0), ("MSFT", 1, 300.0)],
        precios={"AAPL": (100.0, "USD"), "MSFT": (400.0, "USD")},
    )
    r = c.get("/api/portfolio").json()
    assert r["summary"]["total_market_value"] == pytest.approx(600.0)
    assert r["divisas"]["mezcla_de_divisas"] is False
    # Y no se ha pedido ni un tipo de cambio: no hay nada que convertir.
    assert not [x for x in service.llamadas if x.startswith("macro")]


def test_sin_tipo_de_cambio_la_posicion_queda_fuera_del_total_y_se_dice(client):
    """Inventar una paridad sería exactamente el error que esto evita."""
    c, _ = client(
        [("AAPL", 1, 80.0), ("SHOP", 1, 100.0)],
        precios={"AAPL": (100.0, "USD"), "SHOP": (137.0, "CAD")},
        con_fred=False,
    )
    r = c.get("/api/portfolio").json()

    assert r["summary"]["total_market_value"] == pytest.approx(100.0)
    assert r["divisas"]["sin_convertir"][0]["symbol"] == "SHOP"
    assert "quedan FUERA del total" in r["note"]
    # Pero la posición sigue visible en la tabla, con su motivo.
    shop = next(p for p in r["positions"] if p["symbol"] == "SHOP")
    assert shop["market_value_base"] is None
    assert "SHOP" not in [p["label"] for p in r["allocation_by_position"]]


def test_solo_se_pide_un_tipo_por_divisa_presente(client):
    """FRED es gratis, pero pedir series que nadie usa sigue siendo ruido."""
    c, service = client(
        [("AAPL", 1, 80.0), ("SHOP", 1, 100.0), ("BB", 1, 5.0)],
        precios={"AAPL": (100.0, "USD"), "SHOP": (137.0, "CAD"), "BB": (10.0, "CAD")},
    )
    c.get("/api/portfolio")
    macros = [x for x in service.llamadas if x.startswith("macro")]
    assert macros == ["macro:DEXCAUS"], f"esperaba una sola serie, hubo {macros}"


def test_la_nota_dice_que_divisas_hay_y_cuanto_pesa_cada_una(client):
    c, _ = client(
        [("AAPL", 1, 80.0), ("SHOP", 2, 100.0)],
        precios={"AAPL": (100.0, "USD"), "SHOP": (137.0, "CAD")},
    )
    d = c.get("/api/portfolio").json()["divisas"]
    assert d["monedas"] == {"CAD": 200.0, "USD": 100.0}
    assert d["tipos_usados"]["CAD"]["serie"] == "DEXCAUS"
    assert d["tipos_usados"]["CAD"]["por_usd"] == pytest.approx(1.37)
