"""`/api/portfolio/historial`: la curva servida, con las cerradas dentro.

El módulo puede estar bien y el endpoint contar otra historia: lo que más
importa aquí es que las posiciones CERRADAS entren en la curva hasta su fecha de
cierre. Sin ellas, el recorrido describiría una cartera en la que nunca vendiste
nada — justo el periodo que uno quiere revisar.
"""

from __future__ import annotations

import math
from datetime import date, datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.db.engine import get_session
from app.db.models import Instrument, Position
from app.deps import get_service
from app.main import app
from app.providers.base import DataNotFoundError, iso_utc
from tests.test_scan import FakeCache

HOY = date.today()


def _barras(desde: date, precio=100.0, paso=0.0):
    barras, d, i = [], desde, 0
    while d <= HOY:
        if d.weekday() < 5:
            barras.append({"ts": d.isoformat(), "close": round(precio + paso * i, 4)})
            i += 1
        d += timedelta(days=1)
    return barras


class FakeService:
    def __init__(self, divisas: dict[str, str], con_fred=True, paso=0.0):
        self.cache = FakeCache()
        self.divisas = divisas
        self.con_fred = con_fred
        for sym in divisas:
            self.cache.set(
                "price_history_long", {"symbol": sym},
                {"symbol": sym, "bars": _barras(HOY - timedelta(days=500), 100.0, paso)},
            )

    def get(self, data_type, **kw):
        common = {"source": "fake", "as_of": iso_utc(), "cached": False}
        if data_type == "quote":
            sym = kw["symbol"]
            return {**common, "symbol": sym, "price": 110.0,
                    "currency": self.divisas.get(sym, "USD")}
        if data_type == "macro":
            if not self.con_fred:
                raise DataNotFoundError("FRED no disponible")
            if kw["series_id"] != "DEXCAUS":
                raise DataNotFoundError(f"serie {kw['series_id']} no simulada")
            puntos, d = [], HOY - timedelta(days=500)
            while d <= HOY:
                if d.weekday() < 5:
                    puntos.append({"ts": d.isoformat(), "value": "1.37"})
                d += timedelta(days=1)
            return {**common, "series_id": "DEXCAUS", "points": puntos}
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
        divisas = {sym: div for sym, _, _, div in posiciones}
        service = FakeService(divisas, **kw)
        session = session_factory()
        for sym, abierta, cerrada, _ in posiciones:
            inst = Instrument(symbol=sym, name=sym, sector="Tech")
            session.add(inst)
            session.flush()
            session.add(Position(
                instrument_id=inst.id, quantity=10, cost_basis=90.0,
                opened_at=datetime.combine(abierta, datetime.min.time(), timezone.utc),
                closed_at=(datetime.combine(cerrada, datetime.min.time(), timezone.utc)
                           if cerrada else None),
                realized_pnl=50.0 if cerrada else None,
            ))
        session.commit()
        session.close()
        app.dependency_overrides[get_service] = lambda: service
        app.dependency_overrides[get_session] = override_session
        return TestClient(app), service

    yield _hacer
    app.dependency_overrides.clear()


ABIERTA = HOY - timedelta(days=400)


def test_la_curva_llega_con_sus_puntos_y_su_resumen(client):
    c, _ = client([("AAPL", ABIERTA, None, "USD")], paso=0.05)
    r = c.get("/api/portfolio/historial").json()

    assert r["disponible"] is True
    assert len(r["puntos"]) >= 10
    assert r["puntos"][0]["fecha"] < r["puntos"][-1]["fecha"]
    assert r["resumen"]["disponible"] is True
    assert r["base"] == "USD"


def test_las_posiciones_cerradas_entran_hasta_su_fecha_de_cierre(client):
    """Sin ellas la curva contaría una cartera en la que nunca vendiste nada."""
    cierre = HOY - timedelta(days=100)
    c, _ = client([("AAPL", ABIERTA, None, "USD"), ("MSFT", ABIERTA, cierre, "USD")])
    r = c.get("/api/portfolio/historial").json()

    antes = next(p for p in r["puntos"] if p["fecha"] < (cierre - timedelta(days=30)).isoformat())
    despues = next(p for p in r["puntos"] if p["fecha"] > (cierre + timedelta(days=30)).isoformat())
    assert antes["abiertas"] == 2
    assert despues["abiertas"] == 1
    assert despues["valor"] < antes["valor"]


def test_un_cierre_se_explica_como_retirada_y_no_como_perdida(client):
    cierre = HOY - timedelta(days=100)
    c, _ = client([("AAPL", ABIERTA, None, "USD"), ("MSFT", ABIERTA, cierre, "USD")])
    r = c.get("/api/portfolio/historial").json()

    assert cierre.isoformat() in r["cierres"]
    assert "retirada, no una pérdida" in r["aviso"]
    assert "no el de tu cuenta" in r["aviso"]


def test_una_posicion_en_otra_divisa_se_convierte_con_el_tipo_de_cada_dia(client):
    c, _ = client([("SHOP", ABIERTA, None, "CAD")])
    r = c.get("/api/portfolio/historial").json()

    assert r["disponible"] is True
    # 10 acciones a 100 CAD con el cambio a 1,37 son ~730 USD, no 1000.
    assert r["puntos"][-1]["valor"] == pytest.approx(1000 / 1.37, abs=1.0)
    assert "tipo vigente ESE día" in r["aviso"]


def test_sin_serie_de_cambio_la_posicion_queda_fuera_y_se_nombra(client):
    c, _ = client([("AAPL", ABIERTA, None, "USD"), ("TOYO", ABIERTA, None, "JPY")])
    r = c.get("/api/portfolio/historial").json()

    assert [e["symbol"] for e in r["excluidas"]] == ["TOYO"]
    assert "quedan fuera de la curva" in r["aviso"]
    # Y la curva sigue existiendo con el resto.
    assert r["disponible"] is True


def test_sin_fred_se_reporta_el_fallo_aparte(client):
    c, _ = client([("SHOP", ABIERTA, None, "CAD")], con_fred=False)
    r = c.get("/api/portfolio/historial").json()
    assert "CAD" in r["fallos_de_cambio"]


def test_sin_posiciones_se_dice_en_vez_de_devolver_una_curva_vacia(client):
    c, _ = client([])
    r = c.get("/api/portfolio/historial").json()
    assert r["disponible"] is False
    assert "No hay posiciones" in r["nota"]


def test_la_curva_no_engorda_la_respuesta_sin_limite(client):
    """500 días diarios son demasiados puntos para una línea de 600 píxeles."""
    c, _ = client([("AAPL", ABIERTA, None, "USD")])
    r = c.get("/api/portfolio/historial").json()
    assert len(r["puntos"]) <= 270
    assert r["sesiones"] > len(r["puntos"])
