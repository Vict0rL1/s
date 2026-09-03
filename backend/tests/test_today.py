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
                # La descarga real trae un año de cierres; el doble devuelve el
                # resumen que el proveedor deriva de ellos.
                "prices": {
                    s: {
                        "last": 100.0 + i,
                        "change_pct": (i % 5) - 2.0,
                        "low_52w": 80.0 + i,
                        "high_52w": 130.0 + i,
                        "range_position": 0.4,
                        "spark": [90.0 + i, 95.0 + i, 100.0 + i],
                        "points": 251,
                    }
                    for i, s in enumerate(symbols)
                },
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
    scores = [s["score"] for s in data["signals"]]
    assert scores == sorted(scores, reverse=True)
    assert [s["rank"] for s in data["signals"]] == list(range(1, len(scores) + 1))
    # Los 11 sectores GICS entran en juego, no uno solo.
    sectores = {s["context"]["sector_name"] for s in data["signals"]}
    assert len(sectores) == 11


def test_canada_se_puntua_por_separado(client):
    c, _ = client
    data = _completar(c, market="canada")
    assert data["market_key"] == "canada"
    assert data["scored"] >= 20
    # Sectores con menos de 3 comparables se descartan enteros.
    descartados = [s for s in data["sectors"] if not s["usable"]]
    assert all(s["scored"] < 3 for s in descartados)
    nombres_usables = {s["name"] for s in data["sectors"] if s["usable"]}
    assert {s["context"]["sector_name"] for s in data["signals"]} == nombres_usables


def test_los_nombres_salen_del_universo_sin_gastar_llamadas(client):
    """Pedir el perfil de 500 empresas costaría 500 llamadas por cosmética."""
    c, service = client
    data = _completar(c)
    assert service.profile_calls == 0
    assert all(s["context"]["name"] for s in data["signals"])


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


def test_los_recuentos_cuadran_con_los_umbrales(client):
    c, _ = client
    data = _completar(c)
    fav = data["thresholds"]["favorable"]
    des = data["thresholds"]["desfavorable"]

    assert data["counts"]["favorables"] == sum(
        1 for s in data["signals"] if s["score"] >= fav
    )
    assert data["counts"]["desfavorables"] == sum(
        1 for s in data["signals"] if s["score"] <= des
    )
    assert sum(data["counts"].values()) == data["scored"]


def test_la_franja_neutral_viaja_en_la_respuesta(client):
    """Regresión: antes solo viajaban los dos extremos.

    Casi la mitad del índice cae en la franja neutral. Si no viaja, buscar una
    empresa concreta y no encontrarla parece que el modelo no la cubre, cuando
    en realidad la ha puntuado y ha salido del montón.
    """
    c, _ = client
    data = _completar(c)
    fav = data["thresholds"]["favorable"]
    des = data["thresholds"]["desfavorable"]

    neutrales = [s for s in data["signals"] if des < s["score"] < fav]
    assert len(neutrales) == data["counts"]["neutrales"]
    assert neutrales, "se esperaba franja neutral en un universo de 500"
    # Toda empresa puntuada es alcanzable desde la respuesta.
    assert len(data["signals"]) == data["scored"]


def test_toda_empresa_del_universo_esta_puntuada_o_justificada(client):
    """Nada desaparece en silencio: o se puntúa, o consta por qué no."""
    c, _ = client
    data = _completar(c)
    en_lista = {s["symbol"] for s in data["signals"]}
    sin_datos = {u["symbol"] for u in data["unavailable"]}

    del_universo = {c_["symbol"] for c_ in load_market("us_sp500")["companies"]}
    descartados = {
        c_["symbol"]
        for s in data["sectors"]
        if not s["usable"]
        for c_ in load_market("us_sp500")["sectors"][s["name"]]
    }
    assert del_universo == en_lista | sin_datos | descartados


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


def test_la_lista_dice_que_sus_reglas_no_estan_validadas(client):
    """La app ya sí dice qué comprar; lo que no puede es fingir que acierta.

    Antes este test exigía «NO es una lista de compra». Esa promesa se retiró a
    propósito al añadir el motor de decisión, pero la garantía honesta que la
    sustituye es más exigente: mientras no haya backtest con muestra, hay que
    decirlo en pantalla y no publicar ninguna probabilidad.
    """
    c, _ = client
    data = _completar(c)
    assert "no están validadas" in data["disclaimer"]
    assert "backtest" in data["disclaimer"]
    # Y no vende la señal como predicción.
    assert "no que vaya a subir" in data["disclaimer"]

    assert data["calibrated"] is False
    for signal in data["signals"]:
        assert signal["probability"] is None
        assert signal["decision"]["confidence"] != "calibrada"


def test_una_respuesta_cacheada_con_forma_antigua_se_descarta(client):
    """Regresión: servirla dejaba la pantalla en blanco.

    Al cambiar la forma de la respuesta, lo guardado por la versión anterior
    seguía en caché y la UI lo leía mal. No basta con subir la versión de la
    clave — hay que olvidarse de subirla y que aun así no rompa.
    """
    c, service = client
    data = _completar(c)
    assert data["complete"] is True

    # Simula lo guardado por una versión anterior: sin los campos nuevos.
    clave = {"v": 3, "market": "us_sp500"}
    viejo = {k: v for k, v in data.items() if k not in {"signals", "counts", "thresholds"}}
    viejo["favorables"] = []
    service.cache.set("daily_picks", clave, viejo)

    # La siguiente petición ignora ese cacheado y devuelve la forma buena.
    de_nuevo = c.get("/api/signals/today").json()
    assert "signals" in de_nuevo
    assert "thresholds" in de_nuevo
    assert de_nuevo["counts"]["favorables"] >= 0


def test_el_precio_viaja_con_cada_senal_y_con_su_procedencia(client):
    c, _ = client
    data = _completar(c)
    con_precio = [s for s in data["signals"] if s["price"]]
    assert len(con_precio) == data["scored"]
    for signal in con_precio[:5]:
        precio = signal["price"]
        assert precio["last"] > 0
        assert precio["low_52w"] <= precio["last"] <= precio["high_52w"]
        assert len(precio["spark"]) >= 2
        # Ninguna cifra se enseña sin decir de dónde sale y de cuándo es.
        assert precio["source"]
        assert precio["as_of"]


def test_el_precio_no_cuesta_ninguna_llamada_adicional(client):
    """Sale de la descarga masiva que el momentum ya hacía.

    Es la razón por la que se puede mostrar en 500 filas: pedir una cotización
    por empresa serían 500 llamadas contra un tier de 60/min.
    """
    c, service = client
    c.get("/api/signals/today?market=canada&budget=600")
    # Una descarga masiva por sector y ni una llamada de cotización o perfil.
    sectores_usables = len(load_market("canada")["sectors"])
    assert service.bulk_calls == sectores_usables
    assert service.profile_calls == 0


# ---------------------------------------------------------------------------
# Fallos: legibles y acotados
# ---------------------------------------------------------------------------


def test_un_fallo_inesperado_explica_la_causa_en_vez_de_un_500_vacio(client, monkeypatch):
    """Un 500 sin cuerpo dejaba la pantalla diciendo solo «Error HTTP 500».

    El frontend ya sabe leer `detail`; lo que faltaba era que el backend lo
    escribiera. Sin esto, un fallo real es indistinguible de cualquier otro y
    no hay por dónde empezar a arreglarlo.
    """
    c, _ = client
    from app.routers import signals as S

    def explota(*args, **kwargs):
        raise ValueError("algo muy concreto se rompió")

    monkeypatch.setattr(S, "_today", explota)
    resp = c.get("/api/signals/today?market=us_sp500")
    assert resp.status_code == 500
    detail = resp.json()["detail"]
    assert "ValueError" in detail
    assert "algo muy concreto se rompió" in detail


def test_una_empresa_con_datos_raros_no_tumba_la_lista_entera(client, monkeypatch):
    """500 empresas no pueden depender de que las 500 sean decidibles."""
    c, _ = client
    from app.routers import signals as S

    original = S.decide
    llamadas = {"n": 0}

    def falla_la_primera(signal, price, position=None, **kwargs):
        llamadas["n"] += 1
        if llamadas["n"] == 1:
            raise ZeroDivisionError("coste cero")
        return original(signal, price, position, **kwargs)

    monkeypatch.setattr(S, "decide", falla_la_primera)
    data = _completar(c)
    assert data["scored"] > 100, "las demás empresas deben seguir puntuadas"

    rotas = [s for s in data["signals"] if s["decision"]["action"] == "sin_datos"]
    assert len(rotas) == 1
    assert "ZeroDivisionError" in rotas[0]["decision"]["reasons"][0]
    # Y sigue teniendo la forma que la UI espera, no un hueco.
    assert rotas[0]["decision"]["levels"] is None
    assert rotas[0]["decision"]["owned"] is False


def test_una_descarga_cacheada_sin_precios_se_tira_y_se_repide(client):
    """La caché de momentum dura 6 h y no lleva versión.

    Tras actualizar la app, una entrada guardada por la versión anterior —sin
    `prices`— seguiría vigente y daría una lista sin precio ni minigráfico
    durante horas, sin decir por qué. Se detecta la forma vieja y se repide.
    """
    c, service = client
    market = load_market("us_sp500")
    symbols = [s["symbol"] for s in next(iter(market["sectors"].values()))]

    # Forma antigua: momentum sí, precios no.
    service.cache.set(
        "bulk_momentum",
        {"symbols": symbols},
        {"momentum": {s: 0.1 for s in symbols}, "as_of": iso_utc(), "source": "fake"},
    )
    antes = service.bulk_calls
    data = _completar(c)

    assert service.bulk_calls > antes, "debía volver a pedir la descarga"
    con_precio = [s for s in data["signals"] if s.get("price")]
    assert con_precio, "la lista no puede quedarse sin precios por caché vieja"


def test_la_lista_diaria_recoge_el_backtest_de_reglas_guardado(client, session_factory):
    """Sin esto, ejecutar el backtest no cambiaría nada en la pantalla que usas.

    Es la conexión que hace útil al backtest: si las reglas se probaron y
    perdieron dinero, cada fila tiene que decirlo.
    """
    import json

    from app.db.models import LlmOutput

    c, _ = client
    with session_factory() as session:
        session.add(
            LlmOutput(
                kind="rule_backtest",
                content_md=json.dumps(
                    {"fiable": True, "esperanza_pct": -1.2, "ventaja_pct": -3.4}
                ),
                model="reglas/6a",
            )
        )
        session.commit()

    data = _completar(c)
    decididas = [
        s for s in data["signals"] if s["decision"]["action"] not in {"sin_datos"}
    ]
    assert decididas, "hacen falta filas decididas para comprobar la confianza"
    assert all(s["decision"]["confidence"] == "refutada" for s in decididas)


def test_puntuar_el_indice_no_gasta_la_cuota_cara(session_factory):
    """La palanca de coste más grande de la app, fijada como garantía.

    `fundamentals` iba a Finnhub (60 llamadas/min): puntuar 502 empresas
    gastaba la cuota entera en los primeros 60 símbolos, dejaba el resto sin
    puntuar y secaba lo que necesitan noticias, calendario y cotizaciones.
    EDGAR da lo mismo gratis. Si alguien vuelve a invertir ese orden, esto
    tiene que romperse.
    """
    class ConEdgar(MarketService):
        def __init__(self):
            super().__init__()
            self.financial_calls = 0

        def get(self, data_type, **kwargs):
            if data_type == "financials":
                self.financial_calls += 1
                return {
                    "source": "edgar",
                    "as_of": iso_utc(),
                    "periods": [
                        {
                            "end_date": "2024-12-31",
                            "eps_diluted": 5.0,
                            "equity": 1000.0,
                            "revenue": 8000.0,
                            "net_income": 500.0,
                            "operating_income": 900.0,
                            "interest_expense": 40.0,
                            "shares_outstanding": 100.0,
                            "cfo": 800.0,
                            "capex": -150.0,
                        }
                    ],
                }
            return super().get(data_type, **kwargs)

    service = ConEdgar()

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
            data = _completar(c)
    finally:
        app.dependency_overrides.clear()

    assert data["scored"] > 400, "EDGAR debe cubrir el índice casi entero"
    assert service.financial_calls > 400
    # Y lo importante: ni una sola llamada al proveedor con cuota escasa.
    assert service.fundamental_calls == 0
