"""Divisas: la moneda desconocida no es el dólar, y la conversión deja traza.

De la Fase 6 del RC1. La auditoría encontró que la conversión de divisas —que
funciona y está bien probada en `fx.py`— podía no ejecutarse nunca en la
cartera real:

- **Finnhub, el primer proveedor de cotizaciones, SIEMPRE devuelve
  `currency: None`**: su endpoint `/quote` no la incluye.
- `convertir_cartera` hacía `normalizar(None) or base`, o sea, la moneda
  desconocida se suponía dólar.
- El perfil de la empresa trae la moneda, pero `get_or_create_instrument` se
  quedaba con el nombre y el sector y la tiraba; `Instrument.currency` existía y
  nunca se rellenaba.

Resultado: con Finnhub configurado, una acción canadiense se sumaba en dólares
canadienses como si fueran estadounidenses. Un 37 % de más en el caso de la
auditoría, sin un aviso: la regla existía y no se ejecutaba.

Y el camino alternativo tampoco servía: si Finnhub no cubría el símbolo —su
plan gratuito devuelve ceros para Toronto— lanzaba `DataNotFoundError` y el
router cortaba la cadena ahí, sin preguntar a yfinance, que sí lo cubre.

Todos los tipos de cambio de estos tests son fixtures deterministas. Ninguno es
un valor de mercado: no se puede escribir un test que caduque con el mercado.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app.analysis import fx
from app.db.engine import get_session
from app.db.models import Instrument, Position
from app.deps import get_service
from app.main import app
from app.providers.base import DataNotFoundError, ProviderError
from app.providers.router import AllProvidersFailedError
from tests.test_fx_api import FakeService
from tests.test_router import FakeProvider, make_router

# Fixture determinista: 1 USD = 1,25 CAD. Elegido lejos de cualquier tipo real
# a propósito, para que nadie lo confunda con un dato de mercado.
CAD_POR_USD = 1.25
EUR_USD = 1.10  # dólares por euro, en la dirección de DEXUSEU
TIPOS = {
    "CAD": {"por_usd": CAD_POR_USD, "fecha": "2026-01-02", "serie": "DEXCAUS"},
    "EUR": {"por_usd": 1 / EUR_USD, "fecha": "2026-01-02", "serie": "DEXUSEU"},
}


# --- Reciprocidad --------------------------------------------------------


def test_usd_a_cad_y_vuelta_es_la_identidad():
    ida = fx.convertir(100.0, "USD", "CAD", TIPOS)
    vuelta = fx.convertir(ida, "CAD", "USD", TIPOS)
    assert ida == pytest.approx(125.0)
    assert vuelta == pytest.approx(100.0)


def test_el_tipo_cad_usd_es_el_inverso_del_usd_cad():
    usd_cad = fx.convertir(1.0, "USD", "CAD", TIPOS)
    cad_usd = fx.convertir(1.0, "CAD", "USD", TIPOS)
    assert cad_usd == pytest.approx(1 / usd_cad, rel=1e-12)


def test_la_reciprocidad_vale_tambien_para_series_en_la_otra_direccion():
    """DEXUSEU va al revés que DEXCAUS. La reciprocidad no puede depender de eso."""
    eur_usd = fx.convertir(1.0, "EUR", "USD", TIPOS)
    usd_eur = fx.convertir(1.0, "USD", "EUR", TIPOS)
    assert eur_usd == pytest.approx(EUR_USD)
    assert usd_eur == pytest.approx(1 / EUR_USD)


def test_el_cruce_entre_dos_monedas_no_usd_es_reciproco():
    cad_eur = fx.convertir(1.0, "CAD", "EUR", TIPOS)
    eur_cad = fx.convertir(1.0, "EUR", "CAD", TIPOS)
    assert cad_eur * eur_cad == pytest.approx(1.0)


def test_la_direccion_de_cada_serie_se_lee_bien_desde_la_observacion():
    """Del número que publica FRED al tipo por dólar, en las dos direcciones."""
    assert fx.a_por_usd("CAD", 1.25) == pytest.approx(1.25)       # CAD por USD
    assert fx.a_por_usd("EUR", 1.10) == pytest.approx(1 / 1.10)   # USD por EUR


def test_toda_serie_configurada_tiene_banda():
    """La banda es lo único que para un NaN en `tipo_desde_observaciones`.

    `NaN <= 0` es False, así que un NaN sobrevive a la comprobación de positivo y
    solo lo caza `comprobar_banda`. Una divisa añadida sin banda sería una puerta
    abierta para un tipo NaN. Este test cierra esa puerta para siempre.
    """
    assert set(fx.SERIES) <= set(fx.BANDAS_POR_USD)


def test_un_tipo_nan_de_fred_se_rechaza():
    with pytest.raises(fx.SinTipo):
        fx.tipo_desde_observaciones("CAD", [{"ts": "2026-01-02", "value": "nan"}])


# --- La traza de cada conversión -----------------------------------------


def test_cada_conversion_registra_origen_destino_tipo_fecha_y_fuente():
    r = fx.convertir_con_traza(100.0, "CAD", "USD", TIPOS)
    assert r["importe"] == pytest.approx(80.0)
    t = r["traza"]
    assert t["desde"] == "CAD" and t["hacia"] == "USD"
    assert t["tipo"] == pytest.approx(1 / CAD_POR_USD)
    assert t["fecha_tipo"] == "2026-01-02"
    assert t["fuente"] == "FRED DEXCAUS"


def test_la_traza_de_una_conversion_nula_lo_dice():
    r = fx.convertir_con_traza(100.0, "USD", "USD", TIPOS)
    assert r["importe"] == 100.0
    assert r["traza"]["tipo"] == 1.0
    assert r["traza"]["fuente"] == "misma moneda"


def test_la_cartera_guarda_la_traza_de_cada_posicion():
    r = fx.convertir_cartera(
        [{"symbol": "RY", "market_value": 125.0, "invested": 100.0, "currency": "CAD"}], TIPOS
    )
    traza = r["posiciones"][0]["conversion"]
    assert traza["desde"] == "CAD" and traza["hacia"] == "USD"
    assert traza["fuente"] == "FRED DEXCAUS"


# --- La moneda desconocida no es el dólar --------------------------------


def test_una_posicion_sin_moneda_queda_fuera_del_total_y_se_nombra():
    """Antes se suponía dólar. Una canadiense sumaba un 25-37 % de más."""
    r = fx.convertir_cartera(
        [{"symbol": "RY", "market_value": 125.0, "invested": 100.0, "currency": None}], TIPOS
    )
    assert r["posiciones"] == []
    assert r["sin_convertir"][0]["symbol"] == "RY"
    assert "moneda" in r["sin_convertir"][0]["motivo"].lower()


# --- La moneda se resuelve con lo que ya se sabe -------------------------


class ServicioSinMonedaEnQuote(FakeService):
    """Como Finnhub: precio sí, moneda no. El perfil sí la trae."""

    def __init__(self, precios, monedas_de_perfil):
        super().__init__(precios)
        self.monedas_de_perfil = monedas_de_perfil

    def get(self, data_type, **kw):
        r = super().get(data_type, **kw)
        if data_type == "quote":
            r["currency"] = None
        if data_type == "profile":
            r["currency"] = self.monedas_de_perfil.get(kw["symbol"])
        return r


@pytest.fixture
def cartera(session_factory):
    def override_session():
        s = session_factory()
        try:
            yield s
        finally:
            s.close()

    def _hacer(posiciones, service):
        session = session_factory()
        for symbol, cantidad, coste, moneda_guardada in posiciones:
            inst = Instrument(symbol=symbol, name=symbol, sector="Tech", currency=moneda_guardada)
            session.add(inst)
            session.flush()
            session.add(Position(instrument_id=inst.id, quantity=cantidad, cost_basis=coste,
                                 opened_at=datetime.now(timezone.utc)))
        session.commit()
        session.close()
        app.dependency_overrides[get_service] = lambda: service
        app.dependency_overrides[get_session] = override_session
        return TestClient(app).get("/api/portfolio").json(), session_factory

    yield _hacer
    app.dependency_overrides.clear()


def test_sin_moneda_en_la_cotizacion_se_usa_la_guardada_del_instrumento(cartera):
    """El caso Finnhub: la cotización no la trae, pero la sabemos de antes."""
    service = ServicioSinMonedaEnQuote(
        {"AAPL": (100.0, None), "RY": (137.0, None)}, monedas_de_perfil={}
    )
    d, _ = cartera([("AAPL", 10, 90.0, "USD"), ("RY", 10, 120.0, "CAD")], service)
    # 10×100 USD + 10×137 CAD / 1,37 = 1000 + 1000 (FakeService usa 1,37)
    assert d["summary"]["total_market_value"] == pytest.approx(2000.0, rel=1e-3)
    assert d["divisas"]["sin_convertir"] == []


def test_sin_moneda_en_ningun_sitio_se_aprende_del_perfil_y_se_guarda(cartera):
    service = ServicioSinMonedaEnQuote(
        {"RY": (137.0, None)}, monedas_de_perfil={"RY": "CAD"}
    )
    d, factory = cartera([("RY", 10, 120.0, None)], service)
    assert d["summary"]["total_market_value"] == pytest.approx(1000.0, rel=1e-3)
    with factory() as s:
        assert s.query(Instrument).filter_by(symbol="RY").one().currency == "CAD"


def test_sin_moneda_en_ningun_sitio_la_posicion_sale_del_total(cartera):
    """Ni cotización, ni instrumento, ni perfil: NO se supone dólar."""
    service = ServicioSinMonedaEnQuote({"RY": (137.0, None)}, monedas_de_perfil={})
    d, _ = cartera([("RY", 10, 120.0, None)], service)
    assert d["divisas"]["sin_convertir"][0]["symbol"] == "RY"
    assert not d["summary"]["total_market_value"]


# --- Router: «no lo tengo» no es «no existe» -----------------------------


def test_si_el_primero_no_cubre_el_simbolo_se_pregunta_al_siguiente(session_factory):
    """Finnhub gratuito devuelve ceros para Toronto; yfinance sí lo cubre."""
    a = FakeProvider("a", [DataNotFoundError("sin cobertura")])
    b = FakeProvider("b", [{"symbol": "RY.TO", "price": 137.0, "currency": "CAD"}])
    router = make_router(session_factory, {"a": a, "b": b})
    out = router.fetch("quote", symbol="RY.TO")
    assert out["source"] == "b"


def test_si_ninguno_lo_tiene_si_es_que_no_existe(session_factory):
    a = FakeProvider("a", [DataNotFoundError("no")])
    b = FakeProvider("b", [DataNotFoundError("no")])
    router = make_router(session_factory, {"a": a, "b": b})
    with pytest.raises(DataNotFoundError):
        router.fetch("quote", symbol="NOEXISTE")


def test_si_uno_no_lo_tiene_y_otro_esta_caido_no_se_sabe_si_existe(session_factory):
    """Ambiguo: no se puede afirmar «no existe» con una fuente caída."""
    a = FakeProvider("a", [DataNotFoundError("no")])
    b = FakeProvider("b", [ProviderError("caído")])
    router = make_router(session_factory, {"a": a, "b": b})
    with pytest.raises(AllProvidersFailedError):
        router.fetch("quote", symbol="RY.TO")


# --- /riesgo también convierte antes de pesar -----------------------------
#
# El análisis de cartera (296eeb3) es anterior a la conversión de divisas
# (5aaaba1), y la conversión solo se conectó al endpoint principal. `/riesgo`
# siguió sumando `market_value` en la moneda de cada posición: con una acción
# canadiense, todos sus pesos —concentración, exposición, estrés— estaban mal.


def test_riesgo_pesa_con_importes_convertidos(session_factory):
    from tests.test_portfolio_risk_api import LARGO, FakeService as RiesgoFake

    class ConMonedas(RiesgoFake):
        def _payload(self, data_type, symbol):
            r = super()._payload(data_type, symbol)
            if data_type == "quote":
                # Mismo valor en dólares: 100 USD y 137 CAD a 1,37.
                r["price"], r["currency"] = (137.0, "CAD") if symbol == "RY" else (100.0, "USD")
            return r

        def get(self, data_type, **kw):
            if data_type == "macro":
                return {"series_id": kw["series_id"], "source": "fake",
                        "points": [{"ts": "2026-01-02", "value": "1.37"}]}
            return super().get(data_type, **kw)

    service = ConMonedas({"AAPL": LARGO, "RY": LARGO})
    session = session_factory()
    for symbol, sector in (("AAPL", "Technology"), ("RY", "Financials")):
        inst = Instrument(symbol=symbol, name=symbol, sector=sector)
        session.add(inst)
        session.flush()
        session.add(Position(instrument_id=inst.id, quantity=10, cost_basis=90.0,
                             opened_at=datetime.now(timezone.utc)))
    session.commit()
    session.close()

    def override_session():
        s = session_factory()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_service] = lambda: service
    app.dependency_overrides[get_session] = override_session
    try:
        d = TestClient(app).get("/api/portfolio/riesgo?descargar=false").json()
    finally:
        app.dependency_overrides.clear()

    pesos = {p["symbol"]: p["peso_pct"] for p in d["posiciones"]}
    # Mismo valor en dólares → mismo peso. Sin convertir salía 42/58.
    assert pesos["AAPL"] == pytest.approx(pesos["RY"], rel=1e-3), pesos


def test_la_curva_historica_no_supone_dolar_para_la_moneda_desconocida():
    from datetime import date

    from app.analysis import historial as hist

    serie = [(date(2026, 1, d), 100.0) for d in range(2, 30)]
    r = hist.historial(
        [{"symbol": "RY", "quantity": 1, "cost_basis": 90.0, "currency": None,
          "opened_at": date(2026, 1, 2), "closed_at": None}],
        {"RY": serie}, {}, base="USD", hoy=date(2026, 1, 29),
    )
    assert r["excluidas"] == [{"symbol": "RY", "motivo": "moneda desconocida"}]


# --- El coste se convierte al tipo del día de compra ---------------------
#
# `convertir_cartera` convertía el coste de compra al tipo de HOY. Para un
# inversor en dólares eso borra la pérdida o ganancia cambiaria desde la compra:
# si compraste con el dólar a 1,25 CAD y hoy está a 1,37, el dólar canadiense se
# ha depreciado un 9 % y ese 9 % es dinero perdido — que desaparecía del P&L.


def test_el_pnl_incluye_el_efecto_divisa_desde_la_compra(session_factory):
    from datetime import date, timedelta

    compra = date.today() - timedelta(days=200)

    class ConSerie(FakeService):
        def get(self, data_type, **kw):
            if data_type == "macro":
                # Tipo 1,25 hasta hace 100 días, 1,37 desde entonces.
                pts, d = [], compra - timedelta(days=10)
                while d <= date.today():
                    v = "1.25" if d < date.today() - timedelta(days=100) else "1.37"
                    pts.append({"ts": d.isoformat(), "value": v})
                    d += timedelta(days=1)
                return {"series_id": kw["series_id"], "source": "fake", "points": pts}
            return super().get(data_type, **kw)

    service = ConSerie({"RY": (110.0, "CAD")})
    session = session_factory()
    inst = Instrument(symbol="RY", name="RY", sector="Financials", currency="CAD")
    session.add(inst)
    session.flush()
    session.add(Position(instrument_id=inst.id, quantity=10, cost_basis=100.0,
                         opened_at=datetime.combine(compra, datetime.min.time(), timezone.utc)))
    session.commit()
    session.close()

    def override_session():
        s = session_factory()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_service] = lambda: service
    app.dependency_overrides[get_session] = override_session
    try:
        d = TestClient(app).get("/api/portfolio").json()
    finally:
        app.dependency_overrides.clear()

    pos = d["positions"][0]
    # Coste: 1000 CAD al 1,25 del día de compra = 800 USD (no 729,93 al 1,37).
    assert pos["invested_base"] == pytest.approx(800.0, rel=1e-3)
    # Valor: 1100 CAD al 1,37 de hoy = 802,92 USD. P&L real ≈ +2,92 USD, no +72,99.
    assert d["summary"]["unrealized_pnl"] == pytest.approx(1100 / 1.37 - 800, rel=1e-3)
    # Y el efecto divisa se enseña aparte: el CAD se depreció y costó ~70 USD.
    assert pos["efecto_divisa_base"] == pytest.approx(1000 / 1.37 - 800, rel=1e-3)


# --- El P&L realizado también se convierte -------------------------------


def _cartera_con_cerrada(session_factory, service, moneda, compra, venta, coste, pnl_local):
    session = session_factory()
    inst = Instrument(symbol="RY", name="RY", sector="Financials", currency=moneda)
    session.add(inst)
    session.flush()
    session.add(Position(
        instrument_id=inst.id, quantity=10, cost_basis=coste,
        opened_at=datetime.combine(compra, datetime.min.time(), timezone.utc),
        closed_at=datetime.combine(venta, datetime.min.time(), timezone.utc),
        realized_pnl=pnl_local,
    ))
    session.commit()
    session.close()

    def override_session():
        s = session_factory()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_service] = lambda: service
    app.dependency_overrides[get_session] = override_session
    try:
        return TestClient(app).get("/api/portfolio").json()
    finally:
        app.dependency_overrides.clear()


def test_el_pnl_realizado_de_una_cerrada_en_cad_se_da_en_dolares(session_factory):
    """Antes se sumaba en CAD como si fueran dólares."""
    from datetime import date, timedelta

    compra = date.today() - timedelta(days=300)
    venta = date.today() - timedelta(days=50)

    class ConSerie(FakeService):
        def get(self, data_type, **kw):
            if data_type == "macro":
                pts, d = [], compra - timedelta(days=5)
                while d <= date.today():
                    v = "1.25" if d < venta - timedelta(days=10) else "1.37"
                    pts.append({"ts": d.isoformat(), "value": v})
                    d += timedelta(days=1)
                return {"series_id": kw["series_id"], "source": "fake", "points": pts}
            return super().get(data_type, **kw)

    # Compra 10 a 100 CAD (1000 CAD al 1,25 = 800 USD); vende con +370 CAD de
    # beneficio, o sea cobra 1370 CAD al 1,37 = 1000 USD. Realizado: +200 USD.
    d = _cartera_con_cerrada(session_factory, ConSerie({}), "CAD", compra, venta, 100.0, 370.0)
    assert d["summary"]["realized_pnl"] == pytest.approx(200.0, rel=1e-3)


def test_una_cerrada_sin_moneda_no_entra_en_el_realizado(session_factory):
    from datetime import date, timedelta

    class SinMoneda(ServicioSinMonedaEnQuote):
        pass

    d = _cartera_con_cerrada(
        session_factory, SinMoneda({}, monedas_de_perfil={}), None,
        date.today() - timedelta(days=30), date.today() - timedelta(days=5), 100.0, 50.0,
    )
    assert d["summary"]["realized_pnl"] is None or d["summary"]["realized_pnl"] == 0
    assert "RY" in d["summary"]["realizado_sin_convertir"]


def test_todos_los_universos_de_la_lista_diaria_cotizan_en_dolares():
    """Invariante del que depende el dimensionador de la lista diaria.

    `_cartera_actual` (routers/signals.py) pesa las posiciones con el precio de
    la señal, que no trae moneda. Eso solo es correcto porque todos los mercados
    del barrido cotizan en dólares: «Canadá» son canadienses cotizadas EN EE.
    UU., y cripto va en pares -USD. Si alguien añade un universo con sufijo de
    bolsa extranjera (.TO, .L…), los pesos del dimensionador mezclarían monedas
    en silencio. Este test es la alarma.
    """
    import csv
    import re
    from pathlib import Path

    from app.analysis.markets import DATA_DIR, MARKETS

    extranjeros = []
    for m in MARKETS.values():
        with open(Path(DATA_DIR) / m["file"]) as f:
            for row in csv.DictReader(f):
                s = row["symbol"]
                if re.search(r"\.(TO|V|CN|NE|L|PA|DE|AS|MI|MC|SW|HK|T|AX)$", s):
                    extranjeros.append(s)
                if "-" in s and not s.endswith("-USD"):
                    extranjeros.append(s)
    assert extranjeros == []
