"""Tests del router de fuentes: orden, fallback, rate limits y backoff."""

from __future__ import annotations

import pytest
from sqlalchemy import select

from app.db.models import ApiCallLog
from app.providers.base import (
    DataNotFoundError,
    DataProvider,
    ProviderError,
    RateLimitError,
)
from app.providers.router import AllProvidersFailedError, DataRouter, RateLimiter


class FakeProvider(DataProvider):
    capabilities = frozenset({"quote"})

    def __init__(self, name, behavior):
        self.name = name
        self.behavior = behavior  # lista de excepciones/valores por llamada
        self.calls = 0

    def get_quote(self, symbol):
        action = self.behavior[min(self.calls, len(self.behavior) - 1)]
        self.calls += 1
        if isinstance(action, Exception):
            raise action
        return dict(action)


def make_router(session_factory, providers, limits=None):
    limiter = RateLimiter(session_factory, limits or {"a": (100, 60), "b": (100, 60)})
    order = {"quote": ["a", "b"]}
    return DataRouter(providers, limiter, source_order=order, sleep=lambda s: None)


def test_usa_la_primera_fuente_disponible(session_factory):
    a = FakeProvider("a", [{"symbol": "AAPL", "price": 1.0}])
    b = FakeProvider("b", [{"symbol": "AAPL", "price": 2.0}])
    router = make_router(session_factory, {"a": a, "b": b})

    out = router.fetch("quote", symbol="AAPL")
    assert out["price"] == 1.0
    assert out["source"] == "a"  # el router etiqueta la fuente
    assert b.calls == 0


def test_fallback_ante_rate_limit_del_api(session_factory):
    a = FakeProvider("a", [RateLimitError("límite")])
    b = FakeProvider("b", [{"symbol": "AAPL", "price": 2.0}])
    router = make_router(session_factory, {"a": a, "b": b})

    out = router.fetch("quote", symbol="AAPL")
    assert out["source"] == "b"
    assert a.calls == 1  # no reintenta contra un rate limit


def test_salta_proveedor_sin_llamadas_restantes(session_factory):
    a = FakeProvider("a", [{"symbol": "AAPL", "price": 1.0}])
    b = FakeProvider("b", [{"symbol": "AAPL", "price": 2.0}])
    # Límite 0 para "a": el limiter debe saltarlo sin gastar la llamada.
    router = make_router(session_factory, {"a": a, "b": b}, {"a": (0, 60), "b": (100, 60)})

    out = router.fetch("quote", symbol="AAPL")
    assert out["source"] == "b"
    assert a.calls == 0


def test_salta_proveedor_no_configurado(session_factory):
    b = FakeProvider("b", [{"symbol": "AAPL", "price": 2.0}])
    router = make_router(session_factory, {"b": b})  # "a" sin instancia (sin key)
    out = router.fetch("quote", symbol="AAPL")
    assert out["source"] == "b"


def test_reintenta_con_backoff_ante_error_transitorio(session_factory):
    sleeps = []
    a = FakeProvider(
        "a", [ProviderError("timeout"), ProviderError("timeout"), {"symbol": "A", "price": 1.0}]
    )
    limiter = RateLimiter(session_factory, {"a": (100, 60)})
    router = DataRouter({"a": a}, limiter, source_order={"quote": ["a"]}, sleep=sleeps.append)

    out = router.fetch("quote", symbol="AAPL")
    assert out["price"] == 1.0
    assert a.calls == 3
    assert sleeps == [1.0, 2.0]  # backoff exponencial


def test_data_not_found_se_propaga_sin_fallback(session_factory):
    # Si el símbolo no existe, probar otra fuente solo quema llamadas.
    a = FakeProvider("a", [DataNotFoundError("no existe")])
    b = FakeProvider("b", [{"symbol": "X", "price": 2.0}])
    router = make_router(session_factory, {"a": a, "b": b})

    with pytest.raises(DataNotFoundError):
        router.fetch("quote", symbol="NOEXISTE")
    assert b.calls == 0


def test_error_agregado_si_todo_falla(session_factory):
    a = FakeProvider("a", [RateLimitError("límite")])
    b = FakeProvider("b", [ProviderError("caído")])
    router = make_router(session_factory, {"a": a, "b": b})

    with pytest.raises(AllProvidersFailedError) as excinfo:
        router.fetch("quote", symbol="AAPL")
    assert "a" in excinfo.value.reasons
    assert "b" in excinfo.value.reasons


def test_las_llamadas_quedan_registradas(session_factory):
    a = FakeProvider("a", [RateLimitError("límite")])
    b = FakeProvider("b", [{"symbol": "AAPL", "price": 2.0}])
    router = make_router(session_factory, {"a": a, "b": b})
    router.fetch("quote", symbol="AAPL")

    with session_factory() as session:
        rows = session.execute(select(ApiCallLog)).scalars().all()
    estados = {(r.provider, r.status) for r in rows}
    assert ("a", "rate_limited") in estados
    assert ("b", "ok") in estados


def test_el_limiter_cuenta_uso_por_ventana(session_factory):
    limiter = RateLimiter(session_factory, {"a": (5, 60)})
    assert limiter.usage("a")["remaining"] == 5
    limiter.record("a", "quote")
    limiter.record("a", "quote")
    usage = limiter.usage("a")
    assert usage["used"] == 2
    assert usage["remaining"] == 3
