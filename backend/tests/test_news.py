"""Tests del endpoint de interpretación por IA: caché por prompt y etiquetado."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.db.engine import get_session
from app.deps import get_llm
from app.llm.base import LLMProvider
from app.main import app


class FakeLLM(LLMProvider):
    name = "fake"
    model = "fake-model"

    def __init__(self):
        self.calls = 0

    def interpret(self, system, prompt):
        self.calls += 1
        return {"content": "Interpretación de prueba.", "model": self.model}


@pytest.fixture
def client_with_llm(session_factory):
    fake = FakeLLM()

    def override_session():
        session = session_factory()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_llm] = lambda: fake
    app.dependency_overrides[get_session] = override_session
    with TestClient(app) as client:
        yield client, fake
    app.dependency_overrides.clear()


def test_interpretacion_marcada_como_ia_y_cacheada(client_with_llm):
    client, fake = client_with_llm
    body = {"headline": "Empresa X anuncia resultados", "symbol": "X"}

    first = client.post("/api/news/interpret", json=body)
    assert first.status_code == 200
    data = first.json()
    assert data["generated_by"] == "llm"  # etiquetado obligatorio como IA
    assert data["model"] == "fake-model"
    assert data["cached"] is False
    assert "disclaimer" in data
    assert fake.calls == 1

    # Misma noticia otra vez: sale de la base, no gasta API de Anthropic.
    second = client.post("/api/news/interpret", json=body)
    assert second.json()["cached"] is True
    assert fake.calls == 1

    # Noticia distinta: hash distinto, sí llama.
    client.post("/api/news/interpret", json={"headline": "Otra noticia"})
    assert fake.calls == 2


def test_sin_api_key_da_503_claro(session_factory):
    def override_session():
        session = session_factory()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_llm] = lambda: None
    app.dependency_overrides[get_session] = override_session
    try:
        with TestClient(app) as client:
            resp = client.post("/api/news/interpret", json={"headline": "X"})
            assert resp.status_code == 503
            assert "ANTHROPIC_API_KEY" in resp.json()["detail"]
    finally:
        app.dependency_overrides.clear()
