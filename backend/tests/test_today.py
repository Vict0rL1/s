"""Tests de la lista diaria por mercado (/api/signals/today)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.analysis.markets import MARKETS, list_markets, load_market
from app.db.engine import get_session
from app.deps import get_llm, get_service
from app.main import app
from app.providers.base import DataNotFoundError, iso_utc
from tests.test_scan import FakeCache


# ---------------------------------------------------------------------------
# Datos de los universos
# ---------------------------------------------------------------------------


def test_los_mercados_cargan_y_traen_sector():
    for key in MARKETS:
        market = load_market(key)
        assert market["companies"], key
        for company in market["companies"]:
            assert company["symbol"] and company["name"] and company["sector"], company
        # Agrupar por sector debe cubrir a todas, sin perder ni duplicar.
        agrupadas = sum(len(v) for v in market["sectors"].values())
        assert agrupadas == len(market["companies"])


def test_el_sp500_tiene_tamano_y_sectores_plausibles():
    market = load_market("us_sp500")
    assert 480 <= len(market["companies"]) <= 520
    # Los 11 sectores GICS.
    assert len(market["sectors"]) == 11
    simbolos = [c["symbol"] for c in market["companies"]]
    assert len(simbolos) == len(set(simbolos))  # sin duplicados


def test_nasdaq_se_solapa_con_el_sp500_a_proposito():
    """Los mercados son vistas, no particiones: el solapamiento es correcto.

    Una empresa puntúa distinto en cada lista porque cambia con quién se la
    compara, y eso es justamente lo que aporta mirar las dos.
    """
    nasdaq = load_market("nasdaq")
    assert 200 <= len(nasdaq["companies"]) <= 450
    assert len(nasdaq["sectors"]) == 11
    simbolos = [c["symbol"] for c in nasdaq["companies"]]
    assert len(simbolos) == len(set(simbolos))  # sin duplicados dentro del mercado

    sp500 = {c["symbol"] for c in load_market("us_sp500")["companies"]}
    solapan = set(simbolos) & sp500
    assert len(solapan) > 50, "se esperaba solapamiento con el S&P 500"
    assert set(simbolos) - sp500, "el NASDAQ debe aportar empresas propias"


def test_el_nasdaq_no_se_presenta_como_el_indice_nasdaq_100():
    """No hay fuente automatizable del índice: la UI no debe afirmar que lo es."""
    nasdaq = load_market("nasdaq")
    assert "Nasdaq-100" not in nasdaq["name"]
    assert "no es el índice nasdaq-100" in nasdaq["description"].lower()


def test_canada_usa_tickers_estadounidenses_y_no_duplica_el_sp500():
    """Se usan los tickers de NYSE/NASDAQ para que EDGAR siga cubriéndolas."""
    canada = load_market("canada")
    assert 20 <= len(canada["companies"]) <= 80
    sp500 = {c["symbol"] for c in load_market("us_sp500")["companies"]}
    solapan = {c["symbol"] for c in canada["companies"]} & sp500
    assert not solapan, f"empresas duplicadas entre mercados: {solapan}"
    # Tickers estadounidenses: sin sufijo de bolsa extranjera (.TO, .MC…).
    for company in canada["companies"]:
        assert "." not in company["symbol"], company


def test_listado_de_mercados_cuenta_empresas_y_sectores():
    for entry in list_markets():
        market = load_market(entry["key"])
        assert entry["companies"] == len(market["companies"])
        assert entry["sectors"] == len(market["sectors"])


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------


class MarketService:
    """Servicio simulado con fundamentales deterministas por símbolo."""

    def __init__(self, failing: set[str] | None = None):
        self.failing = failing or set()
        self.bulk_calls = 0
        self.profile_calls = 0
        self.fundamental_calls = 0
        self.cache = FakeCache()

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
            self.fundamental_calls += 1
            seed = sum(ord(c) for c in symbol)
            payload = {
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
            # El servicio real cachea lo que descarga; el presupuesto depende
            # de ello, así que el doble tiene que hacer lo mismo.
            self.cache.set("fundamentals", {"symbol": symbol}, payload)
            return payload
        if data_type == "profile":
            self.profile_calls += 1
            return {**common, "symbol": symbol, "name": f"{symbol} Inc", "sector": "Tech"}
        raise DataNotFoundError(f"tipo no simulado: {data_type}")


@pytest.fixture
def client(session_factory):
    service = MarketService()

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


def _completar(c, market="us_sp500", vueltas=10):
    """Repite hasta que no queden pendientes (o se agoten las vueltas)."""
    data = c.get(f"/api/signals/today?market={market}&budget=600").json()
    for _ in range(vueltas):
        if data["complete"]:
            break
        data = c.get(
            f"/api/signals/today?market={market}&budget=600&refresh=true"
        ).json()
    return data


def test_endpoint_de_mercados(client):
    c, _ = client
    data = c.get("/api/signals/markets").json()
    claves = {m["key"] for m in data["markets"]}
    assert claves == set(MARKETS)
    # La procedencia de los datos viaja con ellos.
    assert data["meta"]["retrieved_at"]
    assert data["meta"]["markets"]["us_sp500"]["source"].startswith("https://")


def test_mercado_desconocido_da_404(client):
    c, _ = client
    assert c.get("/api/signals/today?market=marte").status_code == 404


def test_lista_del_sp500_ordenada_y_numerada(client):
    c, _ = client
    data = _completar(c)

    assert data["market_key"] == "us_sp500"
    assert data["scored"] > 400
    scores = [s["score"] for s in data["all_ranked"]]
    assert scores == sorted(scores, reverse=True)
    assert [s["rank"] for s in data["all_ranked"]] == list(range(1, len(scores) + 1))
    # Los 11 sectores GICS entran en juego, no uno solo.
    assert len({s["sector_name"] for s in data["all_ranked"]}) == 11


def test_canada_se_puntua_por_separado(client):
    c, _ = client
    data = _completar(c, market="canada")
    assert data["market_key"] == "canada"
    assert data["scored"] >= 20
    # Sectores con menos de 3 comparables se descartan enteros.
    descartados = [s for s in data["sectors"] if not s["usable"]]
    assert all(s["scored"] < 3 for s in descartados)
    nombres_usables = {s["name"] for s in data["sectors"] if s["usable"]}
    assert {s["sector_name"] for s in data["all_ranked"]} == nombres_usables


def test_los_nombres_salen_del_universo_sin_gastar_llamadas(client):
    """Pedir el perfil de 500 empresas costaría 500 llamadas por cosmética."""
    c, service = client
    data = _completar(c)
    assert service.profile_calls == 0
    assert all(s["context"]["name"] for s in data["favorables"])


def test_el_presupuesto_limita_las_descargas_nuevas(client):
    c, service = client
    c.get("/api/signals/today?budget=50")
    assert service.fundamental_calls == 50


def test_la_cobertura_se_acumula_entre_peticiones(client):
    """Cada pasada avanza un trozo; lo ya cacheado no vuelve a costar."""
    c, service = client
    primera = c.get("/api/signals/today?budget=100").json()
    assert primera["complete"] is False
    assert primera["pending"] > 0
    assert primera["fetched_now"] == 100

    segunda = c.get("/api/signals/today?budget=100&refresh=true").json()
    # Descargó 100 nuevas, no repitió las 100 anteriores.
    assert service.fundamental_calls == 200
    assert segunda["scored"] > primera["scored"]
    assert segunda["pending"] < primera["pending"]


def test_al_completar_no_quedan_pendientes(client):
    c, _ = client
    data = _completar(c)
    assert data["complete"] is True
    assert data["pending"] == 0
    assert data["scored"] + len(data["unavailable"]) == data["requested"]


def test_favorables_y_desfavorables_por_umbral(client):
    c, _ = client
    data = _completar(c)
    assert all(s["score"] >= 0.35 for s in data["favorables"])
    assert all(s["score"] <= -0.35 for s in data["desfavorables"])
    peores = [s["score"] for s in data["desfavorables"]]
    assert peores == sorted(peores)  # el peor primero
    assert (
        len(data["favorables"]) + len(data["desfavorables"]) + data["neutrales"]
        == data["scored"]
    )


def test_se_sirve_de_cache_en_la_segunda_llamada(client):
    c, service = client
    c.get("/api/signals/today?budget=600")
    llamadas = service.bulk_calls
    data = c.get("/api/signals/today").json()
    assert data["cached"] is True
    assert service.bulk_calls == llamadas


def test_cada_mercado_tiene_su_propia_cache(client):
    c, _ = client
    c.get("/api/signals/today?market=us_sp500&budget=600")
    data = c.get("/api/signals/today?market=canada&budget=600").json()
    # No devuelve la lista del S&P por error de clave de caché.
    assert data["market_key"] == "canada"
    assert data["scored"] < 100


def test_no_se_presenta_como_lista_de_compra(client):
    c, _ = client
    data = _completar(c)
    assert "NO es una lista de compra" in data["disclaimer"]
    assert data["calibrated"] is False
    for signal in data["favorables"]:
        assert signal["probability"] is None
