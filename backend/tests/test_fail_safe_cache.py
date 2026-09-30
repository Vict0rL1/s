"""La caché ante proveedores caídos y payloads corruptos.

Tres comportamientos que la auditoría de RC1 echó en falta:

1. **Un payload inválido no se cachea ni gana la carrera.** Antes, el primer
   proveedor que devolvía `{"price": None}` se llevaba la respuesta —la cadena
   de fallback ni se tocaba— y eso quedaba guardado durante todo el TTL. El
   reintento que lo habría arreglado no llegaba a hacerse porque la caché
   contestaba antes.

2. **Si todo falla, un dato viejo marcado es mejor que un apagón.** Pero
   marcado: servir un precio de hace media hora como si fuera de ahora es
   justo el tipo de mentira silenciosa que este trabajo persigue.

3. **Lo caducado se borra.** No por estética: una caché que solo crece acaba
   siendo el fichero más grande del disco.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.cache.cache import CacheStore, MarketDataService
from app.datos import Estado
from app.providers.base import DataNotFoundError, ProviderError
from app.providers.router import AllProvidersFailedError
from app.validacion import PayloadInvalido, validar

AHORA = datetime(2026, 9, 29, 12, 0, tzinfo=timezone.utc)


@pytest.fixture
def cache(session_factory):
    reloj = {"t": AHORA}
    store = CacheStore(session_factory, ttls={"quote": 60}, now=lambda: reloj["t"])
    return store, reloj


class RouterFalso:
    def __init__(self, respuestas=None, error=None):
        self.respuestas = respuestas or []
        self.error = error
        self.llamadas = 0

    def fetch(self, data_type, **kw):
        self.llamadas += 1
        if self.error:
            raise self.error
        return dict(self.respuestas.pop(0))


# --- 1. Validación en la frontera ----------------------------------------


@pytest.mark.parametrize(
    "malo", [None, float("nan"), 0, -10.0, "caro", float("inf")]
)
def test_una_cotizacion_sin_precio_utilizable_se_rechaza(malo):
    with pytest.raises(PayloadInvalido):
        validar("quote", {"symbol": "AAPL", "price": malo})


def test_una_cotizacion_buena_pasa_y_se_normaliza_la_divisa():
    r = validar("quote", {"symbol": "AAPL", "price": "150.5", "currency": " usd "})
    assert r["price"] == 150.5
    assert r["currency"] == "USD"


def test_los_acompanantes_corruptos_no_tumban_la_cotizacion():
    """Sin `change` se puede vivir; sin `price` no."""
    r = validar("quote", {"symbol": "A", "price": 10.0, "change": float("nan")})
    assert r["price"] == 10.0 and r["change"] is None


def test_una_barra_corrupta_se_tira_y_se_cuenta():
    r = validar(
        "price_history",
        {"bars": [
            {"ts": "2026-01-02", "close": 10.0},
            {"ts": "2026-01-03", "close": float("nan")},
            {"ts": "2026-01-04", "close": -5.0},
            {"ts": None, "close": 11.0},
        ]},
    )
    assert len(r["bars"]) == 1
    assert r["barras_descartadas"] == 3


def test_un_historico_entero_corrupto_se_rechaza():
    """Mejor un fallo que un histórico con un solo punto disfrazado de serie."""
    with pytest.raises(PayloadInvalido):
        validar("price_history", {"bars": [{"ts": "2026-01-02", "close": None}]})


def test_un_volumen_de_cero_es_legitimo():
    r = validar("price_history", {"bars": [{"ts": "2026-01-02", "close": 10.0, "volume": 0}]})
    assert r["bars"][0]["volume"] == 0


def test_un_nan_en_fundamentales_no_atraviesa_un_filtro():
    r = validar("fundamentals", {"metrics": {"pe_ttm": float("nan"), "roe": 0.15}})
    assert r["metrics"]["pe_ttm"] is None
    assert r["metrics"]["roe"] == 0.15


def test_un_tipo_sin_validador_pasa_tal_cual():
    payload = {"items": [{"headline": "algo"}]}
    assert validar("news", payload) == payload


def test_un_payload_invalido_no_llega_a_la_cache(session_factory):
    store = CacheStore(session_factory, ttls={"quote": 60})
    router = RouterFalso(error=AllProvidersFailedError("quote", {"x": "respuesta inválida"}))
    service = MarketDataService(router, store)
    with pytest.raises(AllProvidersFailedError):
        service.get("quote", symbol="AAPL")
    assert store.get("quote", {"symbol": "AAPL"}) is None


# --- 2. Caída a caché vieja, MARCADA -------------------------------------


def test_si_todo_falla_se_sirve_lo_viejo_diciendo_que_es_viejo(cache):
    store, reloj = cache
    router = RouterFalso([{"symbol": "AAPL", "price": 150.0, "source": "finnhub"}])
    service = MarketDataService(router, store)

    fresco = service.get("quote", symbol="AAPL")
    assert fresco["price"] == 150.0
    assert fresco["estado"] == Estado.VALIDO.value

    # Pasan diez minutos: el TTL de 60 s venció hace mucho y ahora todo falla.
    reloj["t"] = AHORA + timedelta(minutes=10)
    service.router = RouterFalso(error=AllProvidersFailedError("quote", {"finnhub": "503"}))

    viejo = service.get("quote", symbol="AAPL")
    assert viejo["price"] == 150.0          # el dato sigue sirviendo
    assert viejo["estado"] == Estado.VIEJO.value   # pero no se disfraza
    assert viejo["antiguedad_segundos"] >= 600
    assert "viejo" in viejo["aviso"].lower() or "antig" in viejo["aviso"].lower()


def test_lo_demasiado_viejo_no_se_sirve_ni_marcado(cache):
    """Un precio de hace tres días es peor que un error honesto."""
    store, reloj = cache
    router = RouterFalso([{"symbol": "AAPL", "price": 150.0}])
    service = MarketDataService(router, store)
    service.get("quote", symbol="AAPL")

    reloj["t"] = AHORA + timedelta(days=3)
    service.router = RouterFalso(error=AllProvidersFailedError("quote", {"finnhub": "503"}))
    with pytest.raises(AllProvidersFailedError):
        service.get("quote", symbol="AAPL")


def test_sin_nada_en_cache_el_fallo_se_propaga(cache):
    store, _ = cache
    service = MarketDataService(
        RouterFalso(error=AllProvidersFailedError("quote", {"finnhub": "503"})), store
    )
    with pytest.raises(AllProvidersFailedError):
        service.get("quote", symbol="NUEVA")


def test_un_simbolo_inexistente_no_se_tapa_con_cache_vieja(cache):
    """DataNotFoundError es una respuesta, no un fallo: no se sustituye."""
    store, reloj = cache
    service = MarketDataService(RouterFalso([{"symbol": "A", "price": 10.0}]), store)
    service.get("quote", symbol="A")
    reloj["t"] = AHORA + timedelta(minutes=10)
    service.router = RouterFalso(error=DataNotFoundError("no existe"))
    with pytest.raises(DataNotFoundError):
        service.get("quote", symbol="A")


def test_un_dato_fresco_nunca_se_marca_como_viejo(cache):
    store, _ = cache
    service = MarketDataService(RouterFalso([{"symbol": "A", "price": 10.0}]), store)
    assert service.get("quote", symbol="A")["estado"] == Estado.VALIDO.value
    # Y la segunda, servida de caché vigente, tampoco.
    servido = service.get("quote", symbol="A")
    assert servido["cached"] is True
    assert servido["estado"] == Estado.VALIDO.value


# --- 3. Limpieza ---------------------------------------------------------


def test_lo_caducado_se_borra_y_lo_vigente_se_queda(cache):
    store, reloj = cache
    store.set("quote", {"symbol": "VIEJA"}, {"price": 1.0})
    reloj["t"] = AHORA + timedelta(days=40)
    store.set("quote", {"symbol": "NUEVA"}, {"price": 2.0})

    borradas = store.limpiar()
    assert borradas == 1
    assert store.get("quote", {"symbol": "NUEVA"}) is not None


def test_la_limpieza_respeta_el_margen_para_servir_viejo(cache):
    """Lo recién caducado NO se borra: es lo que sostiene la caída a STALE."""
    store, reloj = cache
    store.set("quote", {"symbol": "A"}, {"price": 1.0})
    reloj["t"] = AHORA + timedelta(minutes=5)  # caducado, pero utilizable
    assert store.limpiar() == 0


def test_limpiar_una_cache_vacia_no_falla(cache):
    store, _ = cache
    assert store.limpiar() == 0


# --- La frontera dentro del router: lo inválido cede el turno ------------


def test_un_precio_corrupto_del_primer_proveedor_cede_al_segundo(session_factory):
    """Antes, el primero que respondía ganaba aunque respondiera basura."""
    from tests.test_router import FakeProvider, make_router

    a = FakeProvider("a", [{"symbol": "AAPL", "price": float("nan")}])
    b = FakeProvider("b", [{"symbol": "AAPL", "price": 150.0}])
    router = make_router(session_factory, {"a": a, "b": b})

    out = router.fetch("quote", symbol="AAPL")
    assert out["source"] == "b"
    assert out["price"] == 150.0
    assert a.calls == 1  # no se reintenta: reintentar no arregla un payload roto


def test_si_todos_responden_basura_el_fallo_dice_por_que(session_factory):
    from tests.test_router import FakeProvider, make_router

    a = FakeProvider("a", [{"symbol": "AAPL", "price": None}])
    b = FakeProvider("b", [{"symbol": "AAPL", "price": -3.0}])
    router = make_router(session_factory, {"a": a, "b": b})

    with pytest.raises(AllProvidersFailedError) as exc:
        router.fetch("quote", symbol="AAPL")
    assert "respuesta inválida" in exc.value.reasons["a"]
    assert "respuesta inválida" in exc.value.reasons["b"]


# --- Limpieza automática -------------------------------------------------


def test_el_registro_de_llamadas_borra_lo_que_ya_no_cuenta(session_factory):
    from app.db.models import ApiCallLog
    from app.providers.router import RateLimiter

    limiter = RateLimiter(session_factory, {"a": ((60, 60), (800, 86400))})
    with session_factory() as s:
        s.add(ApiCallLog(provider="a", endpoint="quote", status="ok",
                         called_at=datetime.now(timezone.utc) - timedelta(days=3)))
        s.add(ApiCallLog(provider="a", endpoint="quote", status="ok",
                         called_at=datetime.now(timezone.utc) - timedelta(minutes=5)))
        s.commit()

    assert limiter.limpiar() == 1
    # La reciente se queda: sigue contando contra el límite DIARIO, y borrarla
    # regalaría cuota. (`usage()` devuelve la ventana más restrictiva —aquí la
    # de un minuto, donde ya no cuenta—, así que se mira la tabla directamente.)
    with session_factory() as s:
        assert s.query(ApiCallLog).count() == 1


def test_mantener_no_lanza_aunque_la_base_falle():
    """Una limpieza rota no puede impedir que la app arranque."""
    from sqlalchemy.exc import OperationalError

    from app.mantenimiento import mantener

    def rota():
        raise OperationalError("SELECT", {}, Exception("disco lleno"))

    r = mantener(rota)
    assert r["cache_borradas"] is None
    assert len(r["errores"]) == 2


def test_mantener_limpia_las_dos_cosas(session_factory):
    from app.mantenimiento import mantener

    r = mantener(session_factory)
    assert r["cache_borradas"] == 0 and r["llamadas_borradas"] == 0
    assert r["errores"] == []


# --- La cartera dice qué precios son viejos --------------------------------


def test_la_cartera_marca_los_precios_viejos(session_factory):
    """Visto en el navegador: la cartera sumaba 4.205 con dos precios rescatados
    de hace 11 minutos y no lo decía en ninguna parte."""
    from datetime import datetime, timezone

    from fastapi.testclient import TestClient

    from app.db.engine import get_session
    from app.db.models import Instrument, Position
    from app.deps import get_service
    from app.main import app

    class Servicio:
        def get(self, data_type, **kw):
            if data_type == "quote":
                return {"symbol": kw["symbol"], "price": 100.0, "currency": "USD",
                        "source": "finnhub", "as_of": "x", "estado": "viejo",
                        "antiguedad_segundos": 660}
            raise DataNotFoundError(data_type)

    with session_factory() as s:
        inst = Instrument(symbol="AAPL", name="AAPL", currency="USD")
        s.add(inst)
        s.flush()
        s.add(Position(instrument_id=inst.id, quantity=10, cost_basis=90.0,
                       opened_at=datetime.now(timezone.utc), stop=80.0))
        s.commit()

    def override_session():
        s = session_factory()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_service] = lambda: Servicio()
    app.dependency_overrides[get_session] = override_session
    try:
        d = TestClient(app).get("/api/portfolio").json()
    finally:
        app.dependency_overrides.clear()
    assert d["positions"][0]["precio_estado"] == "viejo"
    assert d["summary"]["precios_viejos"] == ["AAPL"]
