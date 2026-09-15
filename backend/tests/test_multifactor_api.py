"""El endpoint del screener multifactor, con su presupuesto y su coste.

Lo que se fija aquí es sobre todo la promesa de coste: este screener no puede
gastar ni una llamada más que la lista diaria. Si algún día alguien enruta los
fundamentales por el proveedor de pago «porque es más cómodo», la cuota se seca
en los primeros 60 símbolos y el resto del mercado queda sin puntuar — que es
exactamente el fallo que ya costó una vez.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.analysis.markets import load_market
from app.db.engine import get_session
from app.deps import get_service
from app.main import app
from app.providers.base import iso_utc
from tests.test_scan import FakeCache

MERCADO = "us_sp500"


def _periodos(semilla: int, n: int = 8) -> list[dict]:
    """Ocho ejercicios anuales con la forma que produce EDGAR."""
    salida = []
    for i in range(n):
        escala = 1.0 + i * 0.1
        salida.append(
            {
                "fiscal_year": 2017 + i,
                "end_date": f"{2017 + i}-12-31",
                "revenue": 1_000e6 * escala * (1 + semilla % 5),
                "gross_profit": 400e6 * escala,
                "operating_income": 200e6 * escala * (1 + semilla % 3),
                "net_income": 150e6 * escala,
                "eps_diluted": 3.0 * escala,
                "equity": 1_200e6,
                "total_assets": 3_000e6,
                "current_assets": 900e6,
                "current_liabilities": 600e6,
                "long_term_debt": 500e6 + semilla * 1e6,
                "short_term_debt": 100e6,
                "cash": 300e6,
                "interest_expense": 30e6,
                "cfo": 250e6 * escala,
                "capex": 80e6,
                "shares_outstanding": 100e6,
            }
        )
    return salida


class FakeService:
    """Devuelve datos deterministas y CUENTA las llamadas de cada tipo."""

    def __init__(self):
        self.cache = FakeCache()
        self.llamadas: dict[str, int] = {}

    def get(self, data_type, **kwargs):
        self.llamadas[data_type] = self.llamadas.get(data_type, 0) + 1
        common = {"source": "fake", "as_of": iso_utc(), "cached": False}
        if data_type == "bulk_momentum":
            symbols = kwargs["symbols"]
            return {
                **common,
                "momentum": {s: (i % 11) / 20 - 0.25 for i, s in enumerate(symbols)},
                "prices": {
                    s: {
                        "last": 50.0 + (i % 40) * 3,
                        "daily_vol_pct": 0.8 + (i % 9) * 0.25,
                        "spark": [90.0, 95.0, 100.0],
                        "points": 251,
                    }
                    for i, s in enumerate(symbols)
                },
            }
        if data_type == "financials":
            symbol = kwargs["symbol"]
            payload = {
                **common,
                "symbol": symbol,
                "periods": _periodos(sum(ord(c) for c in symbol)),
            }
            # El servicio real cachea lo que descarga; el presupuesto depende de
            # ello, así que el doble tiene que hacer lo mismo.
            self.cache.set("financials", {"symbol": symbol}, payload)
            return payload
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


def _correr(c, **body):
    r = c.post("/api/screener/multifactor", json={"market": MERCADO, **body})
    assert r.status_code == 200, r.text
    return r.json()


def test_devuelve_un_ranking_con_las_seis_familias(client):
    c, _ = client
    data = _correr(c, budget=120)
    assert data["ranking"], data["nota_cobertura"]
    fila = data["ranking"][0]
    assert fila["puesto"] == 1
    assert set(fila["familias"]) == {
        "value", "quality", "momentum", "growth", "low_volatility", "size"
    }
    assert fila["name"] and fila["price"]


def test_no_gasta_ni_una_llamada_al_proveedor_de_pago(client):
    """La palanca de coste más grande de la app: `fundamentals` va a Finnhub
    (60/min) y `financials` a EDGAR (gratis). Este screener usa EDGAR."""
    c, service = client
    _correr(c, budget=120)
    assert service.llamadas.get("fundamentals", 0) == 0
    assert service.llamadas.get("quote", 0) == 0
    assert service.llamadas.get("financials", 0) > 0


def test_el_presupuesto_limita_las_descargas_nuevas_y_deja_el_resto_pendiente(client):
    c, service = client
    data = _correr(c, budget=20)
    assert service.llamadas.get("financials", 0) <= 20
    assert data["pendientes"]
    assert data["completo"] is False
    assert "seguirá por donde iba" in data["nota_cobertura"]


def test_una_segunda_pasada_avanza_porque_lo_cacheado_es_gratis(client):
    c, service = client
    _correr(c, budget=20)
    primera = service.llamadas["financials"]
    _correr(c, budget=20)
    # La segunda tanda descarga 20 NUEVAS, no vuelve a pagar las 20 anteriores.
    assert service.llamadas["financials"] <= primera + 20


def test_los_pesos_del_cliente_cambian_el_orden(client):
    c, _ = client
    por_value = _correr(c, budget=150, weights={"value": 1})
    por_momentum = _correr(c, budget=150, weights={"momentum": 1})
    assert por_value["pesos"] == {"value": 1.0}
    assert [f["symbol"] for f in por_value["ranking"][:5]] != [
        f["symbol"] for f in por_momentum["ranking"][:5]
    ]


def test_un_peso_negativo_se_rechaza_con_422(client):
    c, _ = client
    r = c.post(
        "/api/screener/multifactor",
        json={"market": MERCADO, "weights": {"value": -1}, "budget": 20},
    )
    assert r.status_code == 422
    assert "en contra" in r.json()["detail"]


def test_las_primeras_traen_su_percentil_historico(client):
    c, _ = client
    data = _correr(c, budget=150, con_historia=5)
    con = [f for f in data["ranking"] if "historia" in f]
    assert len(con) == 5
    historia = con[0]["historia"]
    assert historia["ejercicios"] == 8
    assert historia["metricas"]["roe"]["disponible"] is True
    assert 0.0 <= historia["metricas"]["roe"]["percentil"] <= 1.0
    # Y las que están más abajo no la traen: 500 tablas de percentiles no las
    # lee nadie.
    assert "historia" not in data["ranking"][50]


def test_un_mercado_desconocido_da_404(client):
    c, _ = client
    r = c.post("/api/screener/multifactor", json={"market": "no_existe"})
    assert r.status_code == 404


def test_la_meta_expone_familias_y_pesos_de_partida(client):
    c, _ = client
    meta = c.get("/api/screener/multifactor/meta").json()
    assert set(meta["familias"]) == {
        "value", "quality", "momentum", "growth", "low_volatility", "size"
    }
    assert abs(sum(meta["pesos_por_defecto"].values()) - 1.0) < 1e-9
    assert any(m["key"] == MERCADO for m in meta["markets"])


def test_el_universo_real_se_puntua_por_sector_no_en_bloque(client):
    """Los 11 sectores GICS del S&P 500 dan 11 cortes transversales, no uno."""
    c, _ = client
    # El S&P 500 pasa de 500 empresas y el tope por petición es 500: la segunda
    # pasada termina el mercado gratis, porque lo de la primera ya está cacheado.
    _correr(c, budget=500)
    data = _correr(c, budget=500)
    assert data["completo"] is True, data["nota_cobertura"]
    assert len(data["sectores"]) == len(load_market(MERCADO)["sectors"])
    # Ningún sector debe copar el podio si la normalización es sectorial.
    sectores_top = {f["sector"] for f in data["ranking"][:10]}
    assert len(sectores_top) >= 3, sectores_top
