"""Tests de la capa de caché: TTL, expiración y marcado de frescura."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.cache.cache import CacheStore, MarketDataService, params_hash


class Clock:
    """Reloj controlable para probar expiración sin dormir."""

    def __init__(self):
        self.now = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)

    def __call__(self):
        return self.now

    def advance(self, seconds: float):
        self.now += timedelta(seconds=seconds)


def test_params_hash_estable_y_sensible_a_valores():
    a = params_hash({"symbol": "AAPL", "interval": "1day"})
    b = params_hash({"interval": "1day", "symbol": "AAPL"})  # orden distinto
    c = params_hash({"symbol": "MSFT", "interval": "1day"})
    assert a == b
    assert a != c


def test_cache_roundtrip_y_expiracion(session_factory):
    clock = Clock()
    store = CacheStore(session_factory, ttls={"quote": 60}, now=clock)
    params = {"symbol": "AAPL"}

    assert store.get("quote", params) is None

    store.set("quote", params, {"symbol": "AAPL", "price": 190.5, "source": "finnhub"})
    hit = store.get("quote", params)
    assert hit is not None
    assert hit["price"] == 190.5
    assert hit["cached"] is True
    assert hit["source"] == "finnhub"  # conserva la fuente original
    assert hit["fetched_at"] == clock.now.isoformat()

    clock.advance(59)
    assert store.get("quote", params) is not None
    clock.advance(2)  # TTL de 60 s superado
    assert store.get("quote", params) is None


def test_cache_sobrescribe_al_refrescar(session_factory):
    clock = Clock()
    store = CacheStore(session_factory, ttls={"quote": 60}, now=clock)
    params = {"symbol": "AAPL"}
    store.set("quote", params, {"price": 100.0})
    clock.advance(10)
    store.set("quote", params, {"price": 101.0})
    hit = store.get("quote", params)
    assert hit["price"] == 101.0
    assert hit["fetched_at"] == clock.now.isoformat()


class FakeRouter:
    def __init__(self):
        self.calls = 0

    def fetch(self, data_type, **kwargs):
        self.calls += 1
        return {"symbol": kwargs["symbol"], "price": 42.0, "source": "fake"}


def test_service_no_llama_al_router_si_hay_cache_vigente(session_factory):
    clock = Clock()
    router = FakeRouter()
    service = MarketDataService(
        router, CacheStore(session_factory, ttls={"quote": 60}, now=clock)
    )

    first = service.get("quote", symbol="AAPL")
    assert first["cached"] is False
    assert router.calls == 1

    second = service.get("quote", symbol="AAPL")
    assert second["cached"] is True
    assert router.calls == 1  # servido desde caché: no gastó llamada

    clock.advance(61)
    third = service.get("quote", symbol="AAPL")
    assert third["cached"] is False
    assert router.calls == 2  # expiró: vuelve a la fuente

    # Símbolo distinto = clave distinta: no puede servir el caché de AAPL.
    service.get("quote", symbol="MSFT")
    assert router.calls == 3
