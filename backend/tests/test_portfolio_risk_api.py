"""El análisis de cartera, servido de verdad por `/api/portfolio/riesgo`.

Un módulo que calcula bien y que ningún endpoint llama existe en el repositorio
y no en la aplicación. Estos tests fijan que la vista de cartera devuelva las
cuatro piezas —correlación, exposición, concentración real y estrés— y que la
disciplina de coste (no descargar veinte años cada vez que se abre la pantalla)
siga en pie.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.db.engine import get_session
from app.db.models import ApiCache, Instrument, Position
from app.deps import get_service
from app.main import app
from app.providers.base import DataNotFoundError, iso_utc
from tests.test_scan import FakeCache


def _barras(semilla: int, desde: date, hasta: date) -> list[dict]:
    """Cierres diarios con la forma que devuelve `price_history_long`."""
    rng = np.random.default_rng(semilla)
    comun = rng.normal(0, 0.011, 20000)
    barras, p, d, i = [], 100.0, desde, 0
    while d <= hasta:
        if d.weekday() < 5:
            p *= 1 + comun[i] + rng.normal(0, 0.004)
            barras.append({"ts": d.isoformat(), "close": round(p, 4)})
            i += 1
        d += timedelta(days=1)
    return barras


class FakeService:
    """Proveedor falso que CUENTA sus descargas: el coste es parte del contrato.

    Guarda en caché lo que descarga, igual que `MarketDataService`: sin eso, un
    test sobre «no vuelvas a descargar lo que ya tienes» estaría midiendo el
    doble falso y no el endpoint.
    """

    def __init__(self, largos: dict[str, tuple[date, date]] | None = None, etfs=()):
        self.cache = FakeCache()
        self.descargas: list[str] = []
        self.largos = largos or {}
        self.etfs = set(etfs)

    def _payload(self, data_type, symbol):
        common = {"source": "fake", "as_of": iso_utc(), "cached": False}
        if data_type == "quote":
            return {**common, "symbol": symbol, "price": 100.0}
        if data_type == "profile":
            return {**common, "symbol": symbol, "name": symbol, "country": "US"}
        if data_type == "price_history_long":
            if symbol not in self.largos:
                raise DataNotFoundError(f"sin histórico para {symbol}")
            desde, hasta = self.largos[symbol]
            return {
                **common,
                "symbol": symbol,
                "bars": _barras(hash(symbol) % 99, desde, hasta),
            }
        if data_type == "etf_data":
            if symbol not in self.etfs:
                raise DataNotFoundError(f"{symbol} no es un ETF")
            return {
                **common,
                "symbol": symbol,
                "top_holdings": [
                    {"symbol": "AAPL", "name": "Apple", "weight": 0.07},
                    {"symbol": "NVDA", "name": "Nvidia", "weight": 0.06},
                ],
            }
        raise AssertionError(f"tipo inesperado: {data_type}")

    def get(self, data_type, **kwargs):
        symbol = kwargs.get("symbol", "")
        self.descargas.append(f"{data_type}:{symbol}")
        payload = self._payload(data_type, symbol)  # lo que falla no se cachea
        cache_params = {k: v for k, v in kwargs.items() if not k.startswith("_")}
        self.cache.set(data_type, cache_params, payload)
        return payload


LARGO = (date(2006, 1, 2), date(2024, 1, 2))
CORTO = (date(2018, 1, 2), date(2024, 1, 2))


@pytest.fixture
def client(session_factory):
    def override_session():
        session = session_factory()
        try:
            yield session
        finally:
            session.close()

    def _hacer(posiciones=(("AAPL", "Technology"), ("MSFT", "Technology")), service=None):
        service = service or FakeService({s: LARGO for s, _ in posiciones})
        session = session_factory()
        for symbol, sector in posiciones:
            instrument = Instrument(symbol=symbol, name=symbol, sector=sector)
            session.add(instrument)
            session.flush()
            session.add(
                Position(
                    instrument_id=instrument.id,
                    quantity=10,
                    cost_basis=90.0,
                    opened_at=datetime.now(timezone.utc),
                )
            )
        session.commit()
        session.close()

        app.dependency_overrides[get_service] = lambda: service
        app.dependency_overrides[get_session] = override_session
        return TestClient(app), service

    yield _hacer
    app.dependency_overrides.clear()


def test_la_vista_de_cartera_sirve_las_cuatro_piezas(client):
    """Correlación, exposición agregada, concentración real y estrés."""
    c, _ = client()
    r = c.get("/api/portfolio/riesgo").json()

    assert r["disponible"] is True
    assert r["correlacion"]["disponible"] is True
    assert r["concentracion"]["disponible"] is True
    assert set(r["exposicion"]) == {"sector", "geografia"}
    assert {x["clave"] for x in r["estres"]["crisis"]} == {"2008", "2020", "2022"}


def test_sin_posiciones_abiertas_se_dice_en_vez_de_devolver_ceros(client):
    c, _ = client(posiciones=())
    r = c.get("/api/portfolio/riesgo").json()
    assert r["disponible"] is False
    assert "No hay posiciones" in r["nota"]


def test_la_correlacion_usa_la_ventana_reciente_y_no_veinte_anos(client):
    """La correlación media de 2006-2024 no es la correlación de tu cartera."""
    c, _ = client()
    corr = c.get("/api/portfolio/riesgo").json()["correlacion"]
    assert corr["observaciones"] <= 504
    assert date.fromisoformat(corr["desde"]) > date(2020, 1, 1)


def test_el_estres_si_usa_todo_el_historico_y_llega_a_2008(client):
    """La correlación mira dos años; el estrés tiene que mirar 2008 entero."""
    c, _ = client()
    c2008 = next(
        x for x in c.get("/api/portfolio/riesgo").json()["estres"]["crisis"]
        if x["clave"] == "2008"
    )
    assert c2008["medible"] is True
    assert c2008["cobertura_pct"] == 100.0
    assert c2008["sesiones"] > 300


def test_una_posicion_sin_historico_de_2008_baja_la_cobertura_y_se_nombra(client):
    """La honestidad del estrés está en el denominador."""
    service = FakeService({"AAPL": LARGO, "IPO": CORTO})
    c, _ = client((("AAPL", "Technology"), ("IPO", "Technology")), service)
    c2008 = next(
        x for x in c.get("/api/portfolio/riesgo").json()["estres"]["crisis"]
        if x["clave"] == "2008"
    )
    assert c2008["cobertura_pct"] == pytest.approx(50.0, abs=0.1)
    assert "IPO" in c2008["sin_datos"]


def test_una_posicion_sin_historico_ninguno_se_reporta_y_no_desaparece(client):
    """Si yfinance no da histórico, hay que decir de cuál y por qué."""
    service = FakeService({"AAPL": LARGO})  # MSFT no está: lanzará DataNotFound
    c, _ = client((("AAPL", "Technology"), ("MSFT", "Technology")), service)
    r = c.get("/api/portfolio/riesgo").json()
    assert "MSFT" in r["sin_historico"]
    # Sigue apareciendo como posición y en los pesos: no se borra del análisis.
    assert {p["symbol"] for p in r["posiciones"]} == {"AAPL", "MSFT"}


def test_el_etf_de_la_cartera_revela_la_exposicion_duplicada(client):
    """Tener AAPL suelta y AAPL dentro de un ETF es tener más AAPL."""
    service = FakeService({"AAPL": LARGO, "SPY": LARGO}, etfs=["SPY"])
    c, _ = client((("AAPL", "Technology"), ("SPY", None)), service)
    lt = c.get("/api/portfolio/riesgo").json()["look_through"]

    assert lt["disponible"] is True
    assert lt["etfs_analizados"] == ["SPY"]
    assert "AAPL" in lt["duplicadas"]
    aapl = next(e for e in lt["exposicion"] if e["symbol"] == "AAPL")
    assert aapl["directa_pct"] == pytest.approx(50.0)
    assert aapl["indirecta_pct"] == pytest.approx(3.5)  # 50 % del ETF * 7 %


def test_con_descargar_false_no_se_baja_ni_un_historico(client):
    """Veinte años por posición cada vez que se abre la pantalla no es opción."""
    c, service = client()
    r = c.get("/api/portfolio/riesgo?descargar=false").json()

    assert not [d for d in service.descargas if d.startswith("price_history_long")]
    assert r["sin_historico"], "debe decir que falta histórico, no callarlo"
    assert all("caché" in v for v in r["sin_historico"].values())


def test_lo_ya_cacheado_no_se_vuelve_a_descargar(client):
    """La segunda visita a la pantalla no debe costar nada."""
    c, service = client()
    c.get("/api/portfolio/riesgo")
    primera = len([d for d in service.descargas if d.startswith("price_history_long")])
    assert primera == 2

    c.get("/api/portfolio/riesgo")
    segunda = len([d for d in service.descargas if d.startswith("price_history_long")])
    assert segunda == primera, "el histórico largo ya estaba en caché"


def test_sin_universo_escaneado_las_caracteristicas_lo_dicen(client):
    """Comparar contra una referencia inventada es peor que no comparar."""
    c, _ = client()
    car = c.get("/api/portfolio/riesgo").json()["caracteristicas"]
    assert car["con_referencia"] is False
    assert car["universo_empresas"] == 0
    assert "SIN referencia" in car["nota"]


def test_con_universo_escaneado_aparece_la_inclinacion(client, session_factory):
    """La referencia sale de los fundamentales que el barrido ya descargó."""
    session = session_factory()
    for i in range(25):
        session.add(
            ApiCache(
                provider="router",
                endpoint="fundamentals",
                params_hash=f"h{i}",
                payload={"metrics": {"pe_ttm": 20.0 + i, "roe": 0.10}},
                fetched_at=datetime.now(timezone.utc),
                expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
            )
        )
    session.commit()
    session.close()

    c, _ = client()
    car = c.get("/api/portfolio/riesgo").json()["caracteristicas"]
    assert car["universo_empresas"] == 25
    assert car["con_referencia"] is True


def test_la_referencia_no_se_calcula_con_cuatro_empresas(client, session_factory):
    """Compararse contra tres empresas no es compararse contra nada."""
    session = session_factory()
    for i in range(4):
        session.add(
            ApiCache(
                provider="router",
                endpoint="fundamentals",
                params_hash=f"h{i}",
                payload={"metrics": {"pe_ttm": 20.0}},
                fetched_at=datetime.now(timezone.utc),
                expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
            )
        )
    session.commit()
    session.close()

    c, _ = client()
    car = c.get("/api/portfolio/riesgo").json()["caracteristicas"]
    assert car["universo_empresas"] == 4
    assert car["con_referencia"] is False


def test_los_fundamentales_caducados_no_cuentan_como_universo(client, session_factory):
    """Una referencia de hace un mes no es la del mercado de ahora."""
    session = session_factory()
    for i in range(30):
        session.add(
            ApiCache(
                provider="router",
                endpoint="fundamentals",
                params_hash=f"h{i}",
                payload={"metrics": {"pe_ttm": 20.0}},
                fetched_at=datetime.now(timezone.utc) - timedelta(days=30),
                expires_at=datetime.now(timezone.utc) - timedelta(days=29),
            )
        )
    session.commit()
    session.close()

    c, _ = client()
    assert c.get("/api/portfolio/riesgo").json()["caracteristicas"]["universo_empresas"] == 0


def test_la_geografia_se_declara_como_domicilio_y_no_como_exposicion(client):
    """Apple está domiciliada en EE. UU. y vende medio mundo."""
    c, _ = client()
    r = c.get("/api/portfolio/riesgo").json()
    assert "DOMICILIO" in r["nota_geografia"]
    assert r["exposicion"]["geografia"]["filas"][0]["etiqueta"] == "US"
