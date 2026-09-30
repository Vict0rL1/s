"""El ciclo completo, de un ticker a una alerta, con la pila REAL.

Fase 4 del RC1. Aquí no hay dobles de `MarketDataService`: se usa la caché
SQLite de verdad, el router de fuentes de verdad —con su validación, su
fallback y su rescate de dato viejo—, el limitador de llamadas y una base
migrada con Alembic. Lo único falso son las APIs externas, sustituidas por
proveedores deterministas que se pueden romper a voluntad.

    ticker → DataProvider → fundamentales → valoración → screener
           → motor de decisión → sizing → cartera → controles de riesgo
           → tesis → alerta → actualización posterior

Lo que se comprueba no es que cada módulo funcione —eso lo hacen sus tests—
sino que **comparten lo mismo**: el mismo precio, la misma moneda, la misma
fuente, el mismo estado del dato, y que un fallo en un punto llega a todos los
demás como fallo, no como cero.

Escenarios:
    A  todos los datos válidos
    B  falta el precio
    C  falla el tipo de cambio
    D  la correlación supera el límite
    E  el proveedor devuelve datos antiguos
    F  una API falla parcialmente
    G  una empresa de la cartera tiene datos corruptos
"""

from __future__ import annotations

import math
from datetime import date, datetime, timedelta, timezone

import pandas as pd
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import snapshots as sn
from app.analysis import decision as motor
from app.analysis import sizing
from app.cache.cache import CacheStore, MarketDataService
from app.db.engine import get_session
from app.db.migraciones import migrar
from app.db.models import DecisionSnapshot
from app.deps import get_service
from app.main import app
from app.providers.base import DataNotFoundError, DataProvider, ProviderError, iso_utc
from app.providers.router import DataRouter, RateLimiter
from app.providers.yfinance_provider import _price_summary
from tests.test_valuation_api import _periodos

NAN = float("nan")
HOY = date.today()


# --- El mundo: lo que «saben» las APIs, y cómo se rompen --------------------


def _camino(semilla: int, n: int = 320, inicio: float = 100.0) -> list[float]:
    """Un camino de precios determinista, sin aleatoriedad global."""
    x, salida = inicio, []
    for i in range(n):
        paso = math.sin(i * 0.37 + semilla) * 0.012 + math.cos(i * 0.11 * (semilla + 1)) * 0.008
        x *= 1 + paso
        salida.append(round(x, 4))
    return salida


class Mundo:
    def __init__(self):
        self.precios = {"AAPL": 190.0, "MSFT": 410.0, "RY": 137.0, "BAD": NAN}
        self.monedas = {"AAPL": "USD", "MSFT": "USD", "RY": "CAD", "BAD": "USD"}
        self.caidos: set[str] = set()                     # proveedores caídos
        self.sin_cotizacion: set[str] = set()             # símbolos sin precio en ningún sitio
        self.corrupto_en: dict[str, set[str]] = {}        # proveedor -> símbolos con precio NaN
        self.correlacionadas = False
        self.cad_por_usd = "1.37"

    def historia(self, symbol: str) -> list[float]:
        semilla = {"AAPL": 1, "MSFT": 2 if not self.correlacionadas else 1, "RY": 3, "BAD": 4}[symbol]
        camino = _camino(semilla)
        escala = self.precios.get(symbol, 100.0)
        escala = 100.0 if escala != escala else escala
        return [round(c / camino[-1] * escala, 4) for c in camino]

    def comprobar(self, proveedor: str):
        if proveedor in self.caidos:
            raise ProviderError(f"{proveedor}: 503 Service Unavailable")


class _Base(DataProvider):
    def __init__(self, mundo: Mundo):
        self.m = mundo
        self.llamadas: list[tuple[str, str]] = []

    def _precio(self, symbol):
        self.m.comprobar(self.name)
        self.llamadas.append(("quote", symbol))
        if symbol in self.m.sin_cotizacion or symbol not in self.m.precios:
            raise DataNotFoundError(f"{self.name}: sin cotización para {symbol}")
        if symbol in self.m.corrupto_en.get(self.name, set()):
            return NAN
        return self.m.precios[symbol]


class FinnhubFalso(_Base):
    """Como Finnhub: cotización SIN moneda; perfil CON moneda."""

    name = "finnhub"
    capabilities = frozenset({"quote", "fundamentals", "profile"})

    def get_quote(self, symbol):
        return {"symbol": symbol, "price": self._precio(symbol), "currency": None,
                "as_of": iso_utc(), "freshness": "live"}

    def get_profile(self, symbol):
        self.m.comprobar(self.name)
        return {"symbol": symbol, "name": symbol, "sector": "Technology",
                "country": "US", "currency": self.m.monedas.get(symbol)}

    def get_fundamentals(self, symbol):
        self.m.comprobar(self.name)
        if symbol == "BAD":
            return {"symbol": symbol, "period": "ttm", "as_of": iso_utc(),
                    "metrics": {"pe_ttm": NAN, "roe": float("inf")}}
        return {"symbol": symbol, "period": "ttm", "as_of": iso_utc(),
                "metrics": {"pe_ttm": 24.0, "roe": 0.30, "revenue_growth_5y": 0.09}}


class YahooFalso(_Base):
    """Como yfinance: cotización CON moneda e histórico largo."""

    name = "yfinance"
    capabilities = frozenset({"quote", "price_history_long", "profile", "fundamentals"})

    def get_quote(self, symbol):
        return {"symbol": symbol, "price": self._precio(symbol),
                "currency": self.m.monedas.get(symbol), "as_of": iso_utc(),
                "freshness": "delayed"}

    def get_profile(self, symbol):
        self.m.comprobar(self.name)
        return {"symbol": symbol, "name": symbol, "sector": "Technology",
                "country": "US", "currency": self.m.monedas.get(symbol)}

    def get_fundamentals(self, symbol):
        self.m.comprobar(self.name)
        return {"symbol": symbol, "period": "ttm", "as_of": iso_utc(),
                "metrics": {"pe_ttm": 22.0, "roe": 0.25}}

    def get_price_history_long(self, symbol):
        self.m.comprobar(self.name)
        cierres = self.m.historia(symbol)
        dias = []
        d = HOY
        while len(dias) < len(cierres):
            if d.weekday() < 5:
                dias.append(d)
            d -= timedelta(days=1)
        dias.reverse()
        return {"symbol": symbol, "bars": [{"ts": x.isoformat(), "close": c}
                                           for x, c in zip(dias, cierres)]}


class EdgarFalso(_Base):
    name = "edgar"
    capabilities = frozenset({"financials"})

    def get_financials(self, symbol):
        self.m.comprobar(self.name)
        return {"symbol": symbol, "periods": _periodos()}


class FredFalso(_Base):
    name = "fred"
    capabilities = frozenset({"macro"})

    def get_macro(self, series_id, start):
        self.m.comprobar(self.name)
        puntos, d = [], date.fromisoformat(start)
        while d <= HOY:
            puntos.append({"ts": d.isoformat(), "value": self.m.cad_por_usd})
            d += timedelta(days=7)
        puntos.append({"ts": HOY.isoformat(), "value": self.m.cad_por_usd})
        return {"series_id": series_id, "points": puntos}


# --- La pila real ---------------------------------------------------------


class Pila:
    def __init__(self, tmp_path):
        self.engine = create_engine(f"sqlite:///{tmp_path / 'e2e.db'}",
                                    connect_args={"check_same_thread": False})
        migrar(self.engine)
        self.factory = sessionmaker(bind=self.engine, autoflush=False, expire_on_commit=False)
        self.mundo = Mundo()
        self.reloj = {"t": datetime.now(timezone.utc)}
        self.proveedores = {
            "finnhub": FinnhubFalso(self.mundo),
            "yfinance": YahooFalso(self.mundo),
            "edgar": EdgarFalso(self.mundo),
            "fred": FredFalso(self.mundo),
        }
        limites = {n: (10_000, 60) for n in self.proveedores}
        router = DataRouter(self.proveedores, RateLimiter(self.factory, limites), sleep=lambda s: None)
        cache = CacheStore(self.factory, now=lambda: self.reloj["t"])
        self.service = MarketDataService(router, cache)

    def avanzar(self, **kw):
        self.reloj["t"] += timedelta(**kw)

    def cliente(self) -> TestClient:
        def sesion():
            s = self.factory()
            try:
                yield s
            finally:
                s.close()

        app.dependency_overrides[get_service] = lambda: self.service
        app.dependency_overrides[get_session] = sesion
        return TestClient(app)

    # Glue mínimo: lo que la lista diaria hace para decidir, con piezas reales.
    def bloque_de_precio(self, symbol: str) -> dict | None:
        try:
            q = self.service.get("quote", symbol=symbol)
            h = self.service.get("price_history_long", symbol=symbol)
        except Exception:  # noqa: BLE001 — el test mira el resultado, no el tipo
            return None
        cierres = [b["close"] for b in h["bars"]][:-1] + [q["price"]]
        bloque = _price_summary(pd.Series(cierres)) or {}
        return {**bloque, "last": q["price"], "source": q["source"],
                "as_of": q.get("as_of"), "estado": q["estado"], "currency": q.get("currency")}

    def retornos(self, symbol: str) -> list[float]:
        h = self.service.get("price_history_long", symbol=symbol)
        c = [b["close"] for b in h["bars"]][-120:]
        return [c[i] / c[i - 1] - 1 for i in range(1, len(c))]


@pytest.fixture
def pila(tmp_path, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "database_path", str(tmp_path / "e2e.db"))
    p = Pila(tmp_path)
    yield p
    app.dependency_overrides.clear()


def _decidir(pila: Pila, symbol: str, score: float = 0.6, position=None):
    return motor.decide({"symbol": symbol, "score": score}, pila.bloque_de_precio(symbol),
                        position=position)


# ===========================================================================
# A — Todos los datos válidos: el ciclo entero comparte lo mismo
# ===========================================================================


def test_A_ciclo_completo_con_datos_validos(pila):
    c = pila.cliente()

    # 1. Ticker → proveedor: precio con fuente, fecha y estado.
    q = c.get("/api/stocks/AAPL/quote").json()
    assert q["price"] == 190.0 and q["source"] == "finnhub"
    assert q["estado"] == "valido" and q["as_of"]

    # 2. Fundamentales, 3. valoración, 4. screener.
    f = c.get("/api/stocks/AAPL/fundamentals").json()
    assert f["metrics"]["pe_ttm"] == 24.0 and f["source"] == "finnhub"
    v = c.post("/api/valuation/AAPL", json=None)
    assert v.status_code == 200, v.text
    assert v.json()["escenarios"]["base"]["rango"]["disponible"] is True
    s = c.post("/api/screener/run", json={"symbols": ["AAPL"],
                                          "filters": {"pe_ttm": {"op": "lte", "value": 30}}}).json()
    assert s["results"][0]["passes"] is True

    # 5. Motor de decisión con el MISMO precio que vio la cotización.
    d = _decidir(pila, "AAPL")
    assert d["action"] in ("comprar", "vigilar")
    precio_motor = pila.bloque_de_precio("AAPL")
    assert precio_motor["last"] == q["price"] and precio_motor["source"] == q["source"]

    # 6. Sizing sobre la cartera, con los límites declarados.
    cand = [{"symbol": "AAPL", "sector": "Technology",
             "peso_bruto_pct": (d["levels"] or {}).get("peso_bruto_pct") or 8.0,
             "vol_anual_pct": precio_motor["daily_vol_pct"] * 252 ** 0.5}]
    sz = sizing.dimensionar(cand, retornos={"AAPL": pila.retornos("AAPL")})
    assert 0 < sz["pesos"]["AAPL"] <= sizing.MAX_POR_POSICION_PCT
    assert {x["limite"] for x in sz["controles"]} == {"posición", "sector", "correlación", "volatilidad"}

    # 7. Cartera: el precio, la moneda y el valor son los mismos.
    assert c.post("/api/portfolio/positions",
                  json={"symbol": "AAPL", "quantity": 10, "cost_basis": 150.0}).status_code == 200
    port = c.get("/api/portfolio").json()
    pos = port["positions"][0]
    assert pos["price"] == q["price"] and pos["currency"] == "USD"
    assert port["summary"]["total_market_value"] == pytest.approx(1900.0)

    # 8. Controles de riesgo: el stop del libro es el mismo que el del motor.
    rb = port["risk_budget"]
    assert rb["sin_calcular"] == 0 and rb["riesgo_total_pct"] > 0
    riesgo = c.get("/api/portfolio/riesgo?descargar=true").json()
    assert riesgo["disponible"] and riesgo["posiciones"][0]["peso_pct"] == pytest.approx(100.0)

    # 9. Tesis con punto de invalidación medible.
    t = c.post("/api/theses", json={"symbol": "AAPL", "title": "Calidad",
                                    "body_md": "ROE alto y sostenido."}).json()
    c.post(f"/api/theses/{t['id']}/triggers",
           json={"kind": "metrica", "descripcion": "ROE bajo",
                 "config": {"metrica": "roe", "op": "lt", "umbral": 0.05}})
    vig = c.get("/api/theses/vigilancia").json()
    disparador = vig["tesis"][0]["vigilancia"]["disparadores"][0]
    assert disparador["medible"] is True and disparador["salta"] is False

    # 10. Alerta: evaluada, no cumplida, con el MISMO precio.
    c.post("/api/portfolio/alerts", json={"symbol": "AAPL", "op": "lt", "price": 150.0})
    a = c.get("/api/portfolio/alerts").json()["alerts"][0]
    assert a["current_price"] == q["price"] and a["triggered"] is False

    # 11. Actualización posterior: el precio cae por debajo del stop y del umbral.
    pila.mundo.precios["AAPL"] = 120.0
    pila.avanzar(minutes=10)  # caduca la cotización cacheada
    q2 = c.get("/api/stocks/AAPL/quote").json()
    assert q2["price"] == 120.0
    a2 = c.get("/api/portfolio/alerts").json()["alerts"][0]
    assert a2["triggered"] is True and a2["current_price"] == 120.0
    # El stop que usa el motor es el que la cartera FIJÓ al abrir. Antes se
    # recalculaba con la volatilidad de hoy: la caída la disparaba, el stop se
    # alejaba solo hasta 112,50 y a 120 el motor decía «reducir».
    stop_guardado = port["positions"][0]["stop"]
    assert port["positions"][0]["stop_fijado_al_abrir"] is True
    d2 = _decidir(pila, "AAPL", position={"cost_basis": 150.0, "quantity": 10,
                                          "stop": stop_guardado})
    assert 120.0 < stop_guardado < 150.0
    assert d2["action"] == "vender" and d2["levels"]["stop"] == stop_guardado
    port2 = c.get("/api/portfolio").json()
    assert port2["positions"][0]["price"] == 120.0
    assert port2["summary"]["unrealized_pnl"] == pytest.approx(-300.0)


def test_A_la_decision_queda_congelada_y_se_mide_despues(pila):
    senal = {"symbol": "AAPL", "score": 0.6, "price": pila.bloque_de_precio("AAPL")}
    senal["decision"] = motor.decide(senal, senal["price"])
    senal["decision"]["action"] = "comprar"  # forzado: aquí se prueba el registro
    payload = {"shortlist": {"ideas": [{**senal, "peso_final_pct": 5.0}], "evitar": [],
                             "sizing": {}}, "signals": []}
    ahora = datetime.now(timezone.utc)
    with pila.factory() as s:
        assert sn.congelar_lista_diaria(s, payload, "e2e", ahora)["guardadas"] == 1
        snap = s.query(DecisionSnapshot).one()
        r = sn.reconstruir(snap)
    assert r["precio"]["valor"] == 190.0 and r["precio"]["fuente"] == "finnhub"
    assert r["precio"]["estado"] == "valido" and r["integridad"]["huella_coincide"]


# ===========================================================================
# B — Falta el precio
# ===========================================================================


def test_B_sin_precio_nada_se_rellena_con_cero(pila):
    c = pila.cliente()
    for sym, qty in (("AAPL", 10), ("MSFT", 5)):
        c.post("/api/portfolio/positions", json={"symbol": sym, "quantity": qty, "cost_basis": 100.0})
    c.post("/api/portfolio/alerts", json={"symbol": "MSFT", "op": "lt", "price": 300.0})
    pila.mundo.sin_cotizacion.add("MSFT")
    pila.avanzar(minutes=10)

    # Cotización: 404, no un precio 0.
    assert c.get("/api/stocks/MSFT/quote").status_code == 404
    # Motor: sin_datos, diciendo qué falta, sin niveles ni peso.
    d = _decidir(pila, "MSFT")
    assert d["action"] == "sin_datos" and "precio" in d["faltan"] and d["levels"] is None
    # Cartera: MSFT fuera del total, NO valorada a cero.
    port = c.get("/api/portfolio").json()
    msft = next(p for p in port["positions"] if p["symbol"] == "MSFT")
    assert msft["market_value"] is None
    assert port["summary"]["total_market_value"] == pytest.approx(1900.0)
    assert port["summary"]["priced_positions"] == 1 and port["summary"]["total_positions"] == 2
    # Riesgo: la posición sin precio se cuenta como no calculada y se avisa.
    assert port["risk_budget"]["sin_calcular"] == 1
    # Alerta: «no se sabe», no «no salta».
    a = c.get("/api/portfolio/alerts").json()["alerts"][0]
    assert a["estado"] == "sin_precio" and a["triggered"] is None


# ===========================================================================
# C — Falla el tipo de cambio
# ===========================================================================


def test_C_sin_tipo_de_cambio_la_posicion_extranjera_queda_fuera_y_se_nombra(pila):
    c = pila.cliente()
    c.post("/api/portfolio/positions", json={"symbol": "AAPL", "quantity": 10, "cost_basis": 150.0})
    c.post("/api/portfolio/positions", json={"symbol": "RY", "quantity": 10, "cost_basis": 120.0})
    pila.mundo.caidos.add("fred")

    port = c.get("/api/portfolio").json()
    assert [x["symbol"] for x in port["divisas"]["sin_convertir"]] == ["RY"]
    # El total es SOLO lo convertible: no suma 1370 CAD como si fueran dólares.
    assert port["summary"]["total_market_value"] == pytest.approx(1900.0)
    riesgo = c.get("/api/portfolio/riesgo?descargar=true").json()
    assert [x["symbol"] for x in riesgo["sin_convertir"]] == ["RY"]
    assert riesgo["posiciones"][0]["symbol"] == "AAPL"


def test_C_con_tipo_de_cambio_la_misma_cartera_suma_bien(pila):
    """Contraste de C: cuando FRED responde, RY entra convertido."""
    c = pila.cliente()
    c.post("/api/portfolio/positions", json={"symbol": "AAPL", "quantity": 10, "cost_basis": 150.0})
    c.post("/api/portfolio/positions", json={"symbol": "RY", "quantity": 10, "cost_basis": 120.0})
    port = c.get("/api/portfolio").json()
    # 1900 USD + 1370 CAD / 1,37 = 2900 USD.
    assert port["summary"]["total_market_value"] == pytest.approx(2900.0, rel=1e-3)
    ry = next(p for p in port["positions"] if p["symbol"] == "RY")
    assert ry["currency"] == "CAD"  # aprendida del perfil: Finnhub no la trae


# ===========================================================================
# D — La correlación supera el límite
# ===========================================================================


def test_D_dos_posiciones_que_se_mueven_juntas_cuentan_como_una(pila):
    pila.mundo.correlacionadas = True
    cands = [
        {"symbol": s, "sector": sec, "peso_bruto_pct": 20.0, "vol_anual_pct": 20.0}
        for s, sec in (("AAPL", "Technology"), ("MSFT", "Software"))
    ]
    sz = sizing.dimensionar(cands, retornos={s: pila.retornos(s) for s in ("AAPL", "MSFT")},
                            max_posicion_pct=20.0)
    control = next(x for x in sz["controles"] if x["limite"] == "correlación")
    assert control["aplicado"] is True
    assert sz["clusters"] == [["AAPL", "MSFT"]]
    assert sum(sz["pesos"].values()) <= sizing.MAX_POR_CLUSTER_PCT + 0.01

    pila.mundo.correlacionadas = False
    pila.service.cache.limpiar(ahora=pila.reloj["t"] + timedelta(days=365))
    sueltas = sizing.dimensionar(cands, retornos={s: pila.retornos(s) for s in ("AAPL", "MSFT")},
                                 max_posicion_pct=20.0)
    assert sum(sueltas["pesos"].values()) > sum(sz["pesos"].values())


# ===========================================================================
# E — Datos antiguos
# ===========================================================================


def test_E_con_las_fuentes_caidas_el_dato_viejo_se_sirve_marcado(pila):
    c = pila.cliente()
    assert c.get("/api/stocks/AAPL/quote").json()["estado"] == "valido"
    pila.mundo.caidos |= {"finnhub", "yfinance"}
    pila.avanzar(minutes=10)
    viejo = c.get("/api/stocks/AAPL/quote").json()
    assert viejo["price"] == 190.0
    assert viejo["estado"] == "viejo" and viejo["antiguedad_segundos"] >= 600
    # Y el motor lo sabe: el bloque de precio lleva el estado viejo.
    assert pila.bloque_de_precio("AAPL") is None or pila.bloque_de_precio("AAPL")["estado"] == "viejo"


def test_E_demasiado_viejo_no_se_sirve_ni_marcado(pila):
    c = pila.cliente()
    c.get("/api/stocks/AAPL/quote")
    pila.mundo.caidos |= {"finnhub", "yfinance"}
    pila.avanzar(days=3)
    assert c.get("/api/stocks/AAPL/quote").status_code == 502


# ===========================================================================
# F — Una API falla parcialmente
# ===========================================================================


def test_F_si_la_primera_fuente_cae_responde_la_segunda(pila):
    c = pila.cliente()
    pila.mundo.caidos.add("finnhub")
    q = c.get("/api/stocks/AAPL/quote").json()
    assert q["price"] == 190.0 and q["source"] == "yfinance" and q["estado"] == "valido"


def test_F_si_la_primera_fuente_devuelve_basura_responde_la_segunda(pila):
    c = pila.cliente()
    pila.mundo.corrupto_en["finnhub"] = {"AAPL"}
    q = c.get("/api/stocks/AAPL/quote").json()
    assert q["price"] == 190.0 and q["source"] == "yfinance"


def test_F_un_simbolo_que_una_fuente_no_cubre_llega_por_la_otra(pila):
    """Finnhub gratuito no cubre Toronto: «no lo tengo» no corta la cadena."""
    c = pila.cliente()
    pila.mundo.sin_cotizacion.discard("RY")
    fh = pila.proveedores["finnhub"]
    original = fh.get_quote
    def sin_toronto(symbol):
        if symbol == "RY":
            raise DataNotFoundError("sin cobertura")
        return original(symbol)

    fh.get_quote = sin_toronto
    q = c.get("/api/stocks/RY/quote").json()
    assert q["source"] == "yfinance" and q["currency"] == "CAD"


# ===========================================================================
# G — Una empresa de la cartera tiene datos corruptos
# ===========================================================================


def test_G_una_empresa_corrupta_se_aisla_y_el_resto_se_calcula(pila):
    c = pila.cliente()
    c.post("/api/portfolio/positions", json={"symbol": "AAPL", "quantity": 10, "cost_basis": 150.0})
    c.post("/api/portfolio/positions", json={"symbol": "BAD", "quantity": 10, "cost_basis": 50.0})

    # Cotización corrupta en TODAS las fuentes: fallo explícito, no NaN.
    assert c.get("/api/stocks/BAD/quote").status_code == 502
    # Motor: sin_datos. Nunca una compra dimensionada sobre un NaN.
    assert _decidir(pila, "BAD")["action"] == "sin_datos"
    # Screener: el NaN de sus fundamentales NO pasa un filtro.
    s = c.post("/api/screener/run", json={"symbols": ["AAPL", "BAD"],
                                          "filters": {"pe_ttm": {"op": "lte", "value": 30}}}).json()
    filas = {r["symbol"]: r for r in s["results"]}
    assert filas["AAPL"]["passes"] is True and filas["BAD"]["passes"] is False
    assert filas["BAD"]["metrics"]["pe_ttm"] is None
    # Cartera: BAD fuera, AAPL intacta.
    port = c.get("/api/portfolio").json()
    assert port["summary"]["total_market_value"] == pytest.approx(1900.0)
    bad = next(p for p in port["positions"] if p["symbol"] == "BAD")
    assert bad["market_value"] is None
    riesgo = c.get("/api/portfolio/riesgo?descargar=true").json()
    assert riesgo["disponible"] and "BAD" in riesgo["sin_precio"]
