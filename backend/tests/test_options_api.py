"""`/api/options/{symbol}`: las señales servidas, y la base que se construye sola.

Lo que más fijan estos tests es el contrato de honestidad del endpoint: que la
primera visita diga que no tiene con qué comparar, que la enésima sí, y que abrir
el panel diez veces en una tarde no fabrique una «media» de diez lecturas
idénticas del mismo día.
"""

from __future__ import annotations

import math
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db.engine import get_session
from app.db.models import OptionsSnapshot
from app.deps import get_service
from app.main import app
from app.providers.base import DataNotFoundError, iso_utc
from tests.test_scan import FakeCache

HOY = date.today()


def _bs(spot, strike, iv, años, r=0.04, tipo="call"):
    from app.analysis.options import _norm_cdf as n

    if años <= 0 or iv <= 0:
        return max(0.0, (spot - strike) if tipo == "call" else (strike - spot))
    d1 = (math.log(spot / strike) + (r + iv * iv / 2) * años) / (iv * math.sqrt(años))
    d2 = d1 - iv * math.sqrt(años)
    if tipo == "call":
        return spot * n(d1) - strike * math.exp(-r * años) * n(d2)
    return strike * math.exp(-r * años) * n(-d2) - spot * n(-d1)


def _contratos(spot=100.0, dias=(14, 45, 120), iv_base=(0.42, 0.34, 0.32)):
    """Cadena con la MISMA forma que devuelve el proveedor: fechas en texto."""
    out = []
    for d, iv_atm in zip(dias, iv_base):
        venc = HOY + timedelta(days=d)
        for p in [0.7, 0.8, 0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.15, 1.2, 1.3]:
            k = round(spot * p, 2)
            iv = max(0.05, iv_atm + 0.25 * (1 - p))
            for tipo in ("call", "put"):
                precio = _bs(spot, k, iv, d / 365, tipo=tipo)
                if precio < 0.02:
                    continue
                out.append(
                    {
                        "tipo": tipo,
                        "strike": k,
                        "vencimiento": venc.isoformat(),
                        "iv": iv,
                        "bid": round(precio * 0.98, 2),
                        "ask": round(precio * 1.02, 2),
                        "volumen": 200,
                        "oi": 1000,
                        "ultimo_cruce": HOY.isoformat(),
                    }
                )
    return out


def _barras(dias=500, semilla=3):
    import random

    rng = random.Random(semilla)
    barras, p, d = [], 100.0, HOY - timedelta(days=int(dias * 1.45))
    while len(barras) < dias:
        if d.weekday() < 5:
            p *= math.exp(rng.gauss(0.0003, 0.0126))
            barras.append({"ts": d.isoformat(), "close": round(p, 4)})
        d += timedelta(days=1)
    return barras


class FakeService:
    """Cachea lo que descarga, igual que `MarketDataService`."""

    def __init__(self, *, con_opciones=True, con_precios=True, resultados=True):
        self.cache = FakeCache()
        self.con_opciones = con_opciones
        self.resultados = resultados
        self.llamadas: list[str] = []
        if con_precios:
            self.cache.set(
                "price_history_long", {"symbol": "AAPL"}, {"symbol": "AAPL", "bars": _barras()}
            )

    def _payload(self, tipo, kwargs):
        common = {"source": "fake", "as_of": iso_utc(), "cached": False}
        if tipo == "options_chain":
            if not self.con_opciones:
                raise DataNotFoundError("no cotiza opciones")
            return {
                **common,
                "symbol": kwargs["symbol"],
                "spot": 100.0,
                "contratos": _contratos(),
                "expiraciones": [
                    (HOY + timedelta(days=d)).isoformat() for d in (14, 45, 120)
                ],
                "expiraciones_totales": 18,
            }
        if tipo == "earnings_calendar":
            if not self.resultados:
                raise DataNotFoundError("sin calendario")
            eventos = [
                {"symbol": "AAPL", "date": (HOY - timedelta(days=d)).isoformat()}
                for d in (90, 180, 270, 360)
            ]
            eventos.append({"symbol": "AAPL", "date": (HOY + timedelta(days=20)).isoformat()})
            eventos.append({"symbol": "OTRA", "date": (HOY + timedelta(days=3)).isoformat()})
            return {**common, "events": eventos}
        raise AssertionError(f"tipo inesperado: {tipo}")

    def get(self, data_type, **kwargs):
        # Caché PRIMERO y descarga después, como `MarketDataService.get`. Solo
        # escribirla dejaría pasar un endpoint que se salta la caché.
        params = {k: v for k, v in kwargs.items() if not k.startswith("_")}
        cacheado = self.cache.get(data_type, params)
        if cacheado is not None:
            return cacheado
        self.llamadas.append(f"{data_type}:{kwargs.get('symbol', '')}")
        payload = self._payload(data_type, kwargs)
        self.cache.set(data_type, params, payload)
        return payload


@pytest.fixture
def client(session_factory):
    def override_session():
        s = session_factory()
        try:
            yield s
        finally:
            s.close()

    def _hacer(**kw):
        service = FakeService(**kw)
        app.dependency_overrides[get_service] = lambda: service
        app.dependency_overrides[get_session] = override_session
        return TestClient(app), service, session_factory

    yield _hacer
    app.dependency_overrides.clear()


def test_las_cuatro_señales_llegan_separadas_y_sin_score(client):
    """La petición explícita: al lado del fundamental, no mezcladas."""
    c, _, _ = client()
    r = c.get("/api/options/AAPL").json()

    assert r["disponible"] is True
    for bloque in ("prima_de_riesgo", "skew", "estructura_temporal",
                   "movimiento_esperado", "actividad"):
        assert bloque in r
    assert not any("score" in k or "puntuacion" in k for k in r)
    assert "no hay un score" in r["aviso"].lower()


def test_la_primera_visita_dice_que_no_tiene_con_que_comparar(client):
    c, _, _ = client()
    r = c.get("/api/options/AAPL").json()
    assert r["base_historica"]["n"] == 0
    assert "Primera lectura" in r["base_historica"]["nota"]
    assert r["prima_de_riesgo"]["percentil"] is None
    assert r["actividad"]["inusual"] is None


def test_cada_consulta_guarda_una_instantanea(client):
    c, _, factory = client()
    c.get("/api/options/AAPL")

    with factory() as s:
        filas = s.execute(select(OptionsSnapshot)).scalars().all()
    assert len(filas) == 1
    assert filas[0].symbol == "AAPL"
    assert filas[0].iv_30d is not None
    assert filas[0].prima is not None
    assert filas[0].volumen_total > 0


def test_abrir_el_panel_diez_veces_no_falsea_la_media(client):
    """Diez lecturas del mismo día no son diez datos: son uno repetido."""
    c, _, factory = client()
    for _ in range(10):
        c.get("/api/options/AAPL")

    with factory() as s:
        filas = s.execute(select(OptionsSnapshot)).scalars().all()
    assert len(filas) == 1, "una fila por símbolo y día"


def test_con_base_suficiente_aparecen_los_percentiles(client, session_factory):
    """El juicio se emite contra la historia de la empresa, no contra un umbral."""
    with session_factory() as s:
        for i in range(12):
            s.add(
                OptionsSnapshot(
                    symbol="AAPL",
                    fecha=(HOY - timedelta(days=i + 1)).isoformat(),
                    prima=0.01 + i * 0.002,
                    volumen_total=3000 + i * 50,
                )
            )
        s.commit()

    c, _, _ = client()
    r = c.get("/api/options/AAPL").json()
    assert r["base_historica"]["n"] == 12
    assert r["prima_de_riesgo"]["percentil"] is not None
    assert r["actividad"]["inusual"] is not None


def test_una_empresa_sin_opciones_da_404_explicado(client):
    c, _, _ = client(con_opciones=False)
    r = c.get("/api/options/AAPL")
    assert r.status_code == 404
    assert "no cotiza opciones" in r.json()["detail"]


def test_sin_precios_en_cache_se_dice_que_falta_y_no_se_descarga(client):
    """El histórico ya lo baja Cartera; pedirlo aquí sería pagarlo dos veces."""
    c, service, _ = client(con_precios=False)
    r = c.get("/api/options/AAPL").json()

    assert r["sin_precios"] is True
    assert "Sin histórico de precios" in r["nota_precios"]
    assert not [x for x in service.llamadas if x.startswith("price_history")]
    # Sin realizada no hay prima, y se dice en vez de dar media comparación.
    assert r["prima_de_riesgo"]["disponible"] is False


def test_el_movimiento_implicito_usa_el_vencimiento_tras_los_resultados(client):
    c, _, _ = client()
    imp = c.get("/api/options/AAPL").json()["movimiento_esperado"]["implicito"]
    assert imp["disponible"] is True
    # Resultados en +20 días: el vencimiento de +14 no sirve, el de +45 sí.
    assert imp["vencimiento"] == (HOY + timedelta(days=45)).isoformat()
    assert imp["dias_tras_resultados"] == 25


def test_el_calendario_de_otra_empresa_no_contamina(client):
    """El endpoint de Finnhub devuelve el calendario entero, no solo el símbolo."""
    c, _, _ = client()
    hist = c.get("/api/options/AAPL").json()["movimiento_esperado"]["historico"]
    assert hist["disponible"] is True
    assert hist["n"] == 4          # las cuatro de AAPL, no la de OTRA


def test_sin_calendario_el_panel_sigue_sirviendo_lo_demas(client):
    """Que falle Finnhub no debe llevarse por delante la IV ni el skew."""
    c, _, _ = client(resultados=False)
    r = c.get("/api/options/AAPL").json()

    assert r["disponible"] is True
    assert r["fallo_calendario"] is not None
    assert r["skew"]["disponible"] is True
    assert r["estructura_temporal"]["disponible"] is True
    assert r["movimiento_esperado"]["implicito"]["disponible"] is False


def test_la_cadena_se_cachea_y_no_se_vuelve_a_pedir(client):
    c, service, _ = client()
    c.get("/api/options/AAPL")
    primera = len([x for x in service.llamadas if x.startswith("options_chain")])
    c.get("/api/options/AAPL")
    assert len([x for x in service.llamadas if x.startswith("options_chain")]) == primera


def test_simbolo_invalido_se_rechaza(client):
    c, _, _ = client()
    assert c.get("/api/options/no-es-un-simbolo-larguisimo").status_code == 422


def test_la_segunda_consulta_del_dia_no_se_compara_consigo_misma(client, session_factory):
    """La instantánea se escribe al final de cada consulta. Si la base la
    incluyera, la variación de open interest daría 0 % siempre a partir de la
    segunda visita: la señal entera apagada, sin avisar."""
    with session_factory() as s:
        for i in range(12):
            s.add(
                OptionsSnapshot(
                    symbol="AAPL",
                    fecha=(HOY - timedelta(days=i + 1)).isoformat(),
                    oi_total=50_000 + i * 100,
                    volumen_total=30_000 + i * 50,
                    prima=0.03 + i * 0.001,
                )
            )
        s.commit()

    c, _, _ = client()
    primera = c.get("/api/options/AAPL").json()["actividad"]["variacion_oi"]
    segunda = c.get("/api/options/AAPL").json()["actividad"]["variacion_oi"]

    assert primera["disponible"] is True
    # La referencia es la lectura de AYER en ambas, no la que acaba de escribirse.
    assert segunda["anterior"] == primera["anterior"]
    assert segunda["cambio_pct"] == primera["cambio_pct"]


def test_el_open_interest_se_percentiliza_igual_que_el_volumen(client, session_factory):
    """Se pedían las dos cosas; el OI se guardaba y no se comparaba con nada."""
    with session_factory() as s:
        for i in range(12):
            s.add(
                OptionsSnapshot(
                    symbol="AAPL",
                    fecha=(HOY - timedelta(days=i + 1)).isoformat(),
                    oi_total=50_000 + (i % 5) * 800,
                    volumen_total=30_000 + (i % 4) * 600,
                )
            )
        s.commit()

    c, _, _ = client()
    act = c.get("/api/options/AAPL").json()["actividad"]
    assert act["open_interest"]["disponible"] is True
    assert act["open_interest"]["detalle"]["z"] is not None
    assert act["volumen"]["disponible"] is True
