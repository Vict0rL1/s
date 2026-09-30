"""`/api/portfolio/alerts`: lo que la pestaña dice y lo que de verdad sabe.

El endpoint y el comando programado (`scripts/revisar_alertas.py`) comparten el
módulo de evaluación a propósito. Lo que se comprueba aquí es que el endpoint
usa ese módulo de verdad — que no se quedó una copia de la comparación dentro
del handler — y que la pestaña no promete vigilancia que nadie está haciendo.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.analysis import alertas as al
from app.config import settings
from app.db.engine import get_session
from app.db.models import Alert, Instrument
from app.deps import get_service
from app.main import app
from app.providers.base import DataNotFoundError, iso_utc
from tests.test_scan import FakeCache


class FakeService:
    """Precios a la carta; `None` significa «no se pudo consultar»."""

    def __init__(self, precios: dict[str, float | None]):
        self.cache = FakeCache()
        self.precios = precios

    def get(self, data_type, **kw):
        if data_type != "quote":
            raise AssertionError(f"tipo inesperado: {data_type}")
        sym = kw["symbol"]
        if self.precios.get(sym) is None:
            raise DataNotFoundError(f"sin cotización para {sym}")
        return {
            "source": "fake",
            "as_of": iso_utc(),
            "cached": False,
            "symbol": sym,
            "price": self.precios[sym],
            "currency": "USD",
        }


@pytest.fixture
def client(session_factory, tmp_path, monkeypatch):
    # La marca de vigilancia se escribe junto a la base de datos. En los tests
    # eso tiene que ser un directorio temporal: no se toca backend/data.
    monkeypatch.setattr(settings, "database_path", str(tmp_path / "app.db"))

    def override_session():
        s = session_factory()
        try:
            yield s
        finally:
            s.close()

    def _hacer(alertas_def, precios):
        service = FakeService(precios)
        session = session_factory()
        for sym, op, umbral, activa, saltada in alertas_def:
            inst = Instrument(symbol=sym, name=sym, sector="Tech")
            session.add(inst)
            session.flush()
            session.add(
                Alert(
                    instrument_id=inst.id,
                    kind="price",
                    condition={"op": op, "price": umbral},
                    active=activa,
                    triggered_at=saltada,
                )
            )
        session.commit()
        session.close()
        app.dependency_overrides[get_service] = lambda: service
        app.dependency_overrides[get_session] = override_session
        return TestClient(app), tmp_path

    yield _hacer
    app.dependency_overrides.clear()


def test_una_alerta_cumplida_se_marca_y_se_queda_marcada(client):
    c, _ = client([("AAPL", "lt", 150.0, True, None)], {"AAPL": 140.0})

    primera = c.get("/api/portfolio/alerts").json()["alerts"][0]
    assert primera["triggered"] is True
    assert primera["estado"] == "ok"
    assert primera["triggered_at"] is not None
    assert "por debajo de" in primera["motivo"]

    # Segunda pasada: el sello no se reescribe. Si se reescribiera, un cron cada
    # quince minutos volvería a avisar de lo mismo toda la semana.
    segunda = c.get("/api/portfolio/alerts").json()["alerts"][0]
    assert segunda["triggered_at"] == primera["triggered_at"]


def test_una_alerta_tranquila_no_se_marca(client):
    c, _ = client([("AAPL", "lt", 150.0, True, None)], {"AAPL": 160.0})
    a = c.get("/api/portfolio/alerts").json()["alerts"][0]
    assert a["triggered"] is False
    assert a["triggered_at"] is None
    assert a["current_price"] == 160.0


def test_sin_precio_no_dice_que_no_salta(client):
    c, _ = client([("AAPL", "lt", 150.0, True, None)], {"AAPL": None})
    a = c.get("/api/portfolio/alerts").json()["alerts"][0]
    # Tri-estado: None es «no se sabe», que no es False.
    assert a["triggered"] is None
    assert a["estado"] == "sin_precio"
    assert "no se sabe" in a["motivo"].lower()
    assert a["current_price"] is None


def test_un_operador_desconocido_no_se_evalua_al_revés(client):
    """El handler viejo trataba cualquier op que no fuera «lt» como «>».

    Una condición guardada con un operador raro se evaluaba como «por encima
    de», en silencio, y podía marcarse como cumplida al revés.
    """
    c, _ = client([("AAPL", "gte", 150.0, True, None)], {"AAPL": 160.0})
    a = c.get("/api/portfolio/alerts").json()["alerts"][0]
    assert a["triggered"] is None
    assert a["estado"] == "condicion_invalida"
    assert a["triggered_at"] is None


def test_una_alerta_desactivada_no_es_una_alerta_rota(client):
    c, _ = client([("AAPL", "lt", 150.0, False, None)], {"AAPL": 140.0})
    a = c.get("/api/portfolio/alerts").json()["alerts"][0]
    assert a["estado"] == "desactivada"
    assert a["triggered"] is None
    # Apagada de verdad: ni se consulta el precio ni se marca.
    assert a["current_price"] is None
    assert a["triggered_at"] is None


def test_sin_comando_programado_la_pestana_lo_admite(client):
    c, _ = client([("AAPL", "lt", 150.0, True, None)], {"AAPL": 160.0})
    vig = c.get("/api/portfolio/alerts").json()["vigilancia"]
    assert vig["activa"] is False and vig["nunca"] is True
    assert "cron" in vig["nota"].lower()


def test_con_una_pasada_reciente_la_pestana_lo_dice(client):
    c, datos = client([("AAPL", "lt", 150.0, True, None)], {"AAPL": 160.0})
    al.anotar_pasada(
        datos, al.resumir([]), datetime.now(timezone.utc) - timedelta(minutes=5)
    )
    vig = c.get("/api/portfolio/alerts").json()["vigilancia"]
    assert vig["activa"] is True and vig["nunca"] is False
    assert "5 minutos" in vig["nota"]


def test_una_pasada_vieja_no_se_pinta_como_vigilancia(client):
    c, datos = client([("AAPL", "lt", 150.0, True, None)], {"AAPL": 160.0})
    al.anotar_pasada(datos, al.resumir([]), datetime.now(timezone.utc) - timedelta(days=2))
    vig = c.get("/api/portfolio/alerts").json()["vigilancia"]
    assert vig["activa"] is False
    assert vig["nunca"] is False  # configurado, pero no ha corrido


def test_la_hora_de_salto_lleva_zona_siempre(client):
    """SQLite pierde la zona; el endpoint la vuelve a poner.

    Sin esto, la misma alerta se servía con «+00:00» en la pasada que la marcó
    y sin zona en todas las siguientes — y el navegador lee lo segundo como
    hora local, así que la hora mostrada cambiaba al recargar.
    """
    c, _ = client([("AAPL", "lt", 150.0, True, None)], {"AAPL": 140.0})
    recien = c.get("/api/portfolio/alerts").json()["alerts"][0]["triggered_at"]
    releido = c.get("/api/portfolio/alerts").json()["alerts"][0]["triggered_at"]
    assert recien.endswith("+00:00") and releido.endswith("+00:00")
    assert datetime.fromisoformat(recien) == datetime.fromisoformat(releido)
