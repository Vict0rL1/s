"""El flujo completo: tesis → puntos vigilables → aviso → decisión registrada.

Además de lo funcional, esto fija dos cosas de coste y una de rutas:

- las noticias solo se piden si alguna tesis tiene un disparador de ese tipo
  (Finnhub da 60 llamadas/minuto y pedirlas siempre las gastaría para nada);
- los estados financieros salen de EDGAR, que es gratis;
- y `/vigilancia` y `/decisiones` no chocan con `/{thesis_id}`.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.db.engine import get_session
from app.deps import get_service
from app.main import app
from app.providers.base import DataNotFoundError, iso_utc


def _periodos():
    """Márgenes que se deterioran ejercicio a ejercicio."""
    margenes = [0.25, 0.22, 0.19, 0.16]
    return [
        {
            "fiscal_year": 2022 + i,
            "revenue": 1000e6,
            "gross_profit": 400e6,
            "operating_income": 1000e6 * m,
            "net_income": 600e6 * m,
            "eps_diluted": 6.0,
            "equity": 2000e6,
            "total_assets": 5000e6,
            "current_assets": 1500e6,
            "current_liabilities": 800e6,
            "long_term_debt": 1000e6,
            "short_term_debt": 200e6,
            "cash": 500e6,
            "interest_expense": 50e6,
            "cfo": 800e6,
            "capex": 200e6,
            "shares_outstanding": 100e6,
        }
        for i, m in enumerate(margenes)
    ]


class FakeService:
    def __init__(self, titular="Resultados en línea con lo esperado"):
        self.titular = titular
        self.llamadas: dict[str, int] = {}

    def get(self, data_type, **kwargs):
        self.llamadas[data_type] = self.llamadas.get(data_type, 0) + 1
        common = {"source": "fake", "as_of": iso_utc(), "cached": False}
        if data_type == "quote":
            return {**common, "symbol": kwargs["symbol"], "price": 120.0}
        if data_type == "profile":
            return {**common, "symbol": kwargs["symbol"], "name": "Fake", "sector": "Tech"}
        if data_type == "financials":
            return {**common, "symbol": kwargs["symbol"], "periods": _periodos()}
        if data_type == "news":
            return {
                **common,
                "items": [
                    {
                        "headline": self.titular,
                        "summary": "",
                        "url": "https://news/1",
                        "source": "fake",
                        "published_at": iso_utc(),
                    }
                ],
            }
        raise DataNotFoundError(f"sin {data_type}")


@pytest.fixture
def client(session_factory):
    def _hacer(**kw):
        service = FakeService(**kw)

        def override_session():
            s = session_factory()
            try:
                yield s
            finally:
                s.close()

        app.dependency_overrides[get_service] = lambda: service
        app.dependency_overrides[get_session] = override_session
        return TestClient(app), service

    yield _hacer
    app.dependency_overrides.clear()


def _crear_tesis(c, symbol="AAPL"):
    r = c.post("/api/theses", json={
        "symbol": symbol,
        "title": "Los márgenes aguantan por el mix hacia servicios",
        "body_md": "El mix hacia servicios sostiene el margen operativo.",
        "invalidation_criteria": "Si el mix deja de mejorar y el margen se cae.",
    })
    assert r.status_code == 200, r.text
    return r.json()["id"]


# --- Rutas: las nuevas no chocan con /{thesis_id} ----------------------------


def test_las_rutas_nuevas_no_las_captura_el_patron_de_id(client):
    c, _ = client()
    assert c.get("/api/theses/vigilancia").status_code == 200
    assert c.get("/api/theses/vigilancia/metricas").status_code == 200
    assert c.get("/api/theses/decisiones").status_code == 200


def test_solo_se_vigilan_metricas_del_negocio_no_multiplos(client):
    """Vigilar el P/E sería vigilar la cotización; para eso están las alertas."""
    c, _ = client()
    m = c.get("/api/theses/vigilancia/metricas").json()
    claves = {x["clave"] for x in m["metricas"]}
    assert "operating_margin" in claves
    assert not {"pe_ttm", "pb", "price"} & claves
    assert "habla del NEGOCIO" in m["nota"]


# --- Crear disparadores -------------------------------------------------------


def test_se_añade_un_punto_de_invalidacion_vigilable(client):
    c, _ = client()
    tid = _crear_tesis(c)
    r = c.post(f"/api/theses/{tid}/triggers", json={
        "kind": "metrica",
        "descripcion": "Si el margen operativo baja del 18 %, el mix no está funcionando",
        "config": {"metrica": "operating_margin", "op": "lt", "umbral": 0.18},
    })
    assert r.status_code == 200, r.text
    assert r.json()["kind"] == "metrica"
    assert r.json()["activo"] is True


def test_una_metrica_no_vigilable_se_rechaza_con_el_catalogo(client):
    c, _ = client()
    tid = _crear_tesis(c)
    r = c.post(f"/api/theses/{tid}/triggers", json={
        "kind": "metrica", "descripcion": "x",
        "config": {"metrica": "pe_ttm", "op": "lt", "umbral": 15},
    })
    assert r.status_code == 422
    assert "vigilancia/metricas" in r.json()["detail"]


def test_un_disparador_de_noticias_sin_palabras_se_rechaza(client):
    c, _ = client()
    tid = _crear_tesis(c)
    r = c.post(f"/api/theses/{tid}/triggers", json={
        "kind": "noticia", "descripcion": "x", "config": {"palabras": []},
    })
    assert r.status_code == 422


def test_un_disparador_sin_descripcion_se_rechaza(client):
    """La descripción es el porqué: sin ella, dentro de un año el umbral es un
    número sin historia."""
    c, _ = client()
    tid = _crear_tesis(c)
    r = c.post(f"/api/theses/{tid}/triggers", json={
        "kind": "metrica", "descripcion": "",
        "config": {"metrica": "roe", "op": "lt", "umbral": 0.1},
    })
    assert r.status_code == 422


# --- La vigilancia ------------------------------------------------------------


def test_el_sistema_detecta_el_punto_cruzado_y_no_lo_llama_venta(client):
    c, _ = client()
    tid = _crear_tesis(c)
    c.post(f"/api/theses/{tid}/triggers", json={
        "kind": "metrica",
        "descripcion": "Si el margen operativo baja del 18 %",
        "config": {"metrica": "operating_margin", "op": "lt", "umbral": 0.18},
    })
    d = c.get("/api/theses/vigilancia").json()
    assert d["total_saltan"] == 1
    disparador = d["tesis"][0]["vigilancia"]["disparadores"][0]
    assert disparador["salta"] is True
    assert disparador["valor"] == 0.16
    assert disparador["tendencia"] == "bajando"
    assert "no es una señal de venta" in d["nota"]
    assert "releer la tesis" in d["nota"]


def test_una_tesis_sin_disparadores_se_señala(client):
    """El texto libre sirve para pensar, pero no lo mira nadie."""
    c, _ = client()
    _crear_tesis(c)
    d = c.get("/api/theses/vigilancia").json()
    assert d["sin_disparadores"] == ["AAPL"]
    assert "no lo mira nadie" in d["aviso_sin_disparadores"]


def test_una_noticia_sobre_el_riesgo_vigilado_salta(client):
    c, _ = client(titular="Regulators open an investigación into the company")
    tid = _crear_tesis(c)
    c.post(f"/api/theses/{tid}/triggers", json={
        "kind": "noticia",
        "descripcion": "Si hay una investigación regulatoria, la tesis cambia",
        "config": {"palabras": ["investigación", "recall"]},
    })
    d = c.get("/api/theses/vigilancia").json()
    disparador = d["tesis"][0]["vigilancia"]["disparadores"][0]
    assert disparador["salta"] is True
    assert disparador["coincidencias"][0]["url"] == "https://news/1"
    assert "BUSCA PALABRAS" in disparador["aviso"]


def test_las_noticias_solo_se_piden_si_alguna_tesis_las_vigila(client):
    """Finnhub da 60 llamadas/minuto: pedirlas siempre las gastaría para nada."""
    c, service = client()
    tid = _crear_tesis(c)
    c.post(f"/api/theses/{tid}/triggers", json={
        "kind": "metrica", "descripcion": "margen",
        "config": {"metrica": "operating_margin", "op": "lt", "umbral": 0.18},
    })
    c.get("/api/theses/vigilancia")
    assert service.llamadas.get("news", 0) == 0

    c.post(f"/api/theses/{tid}/triggers", json={
        "kind": "noticia", "descripcion": "riesgo",
        "config": {"palabras": ["recall"]},
    })
    c.get("/api/theses/vigilancia")
    assert service.llamadas.get("news", 0) == 1


def test_los_estados_financieros_salen_de_edgar_que_es_gratis(client):
    c, service = client()
    tid = _crear_tesis(c)
    c.post(f"/api/theses/{tid}/triggers", json={
        "kind": "crecimiento", "descripcion": "crecimiento",
        "config": {"metrica": "revenue_cagr", "op": "lt", "umbral": 0.05},
    })
    c.get("/api/theses/vigilancia")
    assert service.llamadas.get("financials", 0) >= 1
    assert service.llamadas.get("fundamentals", 0) == 0


# --- Registro de decisiones ---------------------------------------------------


def test_una_decision_guarda_el_razonamiento_y_el_contexto_de_entonces(client):
    c, _ = client()
    tid = _crear_tesis(c)
    c.post(f"/api/theses/{tid}/triggers", json={
        "kind": "metrica", "descripcion": "Si el margen baja del 18 %",
        "config": {"metrica": "operating_margin", "op": "lt", "umbral": 0.18},
    })
    r = c.post("/api/theses/decisiones", json={
        "symbol": "AAPL", "accion": "reforzar", "thesis_id": tid,
        "razonamiento": "El margen cae pero por el mix de producto, no por precio.",
        "quantity": 10,
    })
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["price_at_decision"] == 120.0
    ctx = d["contexto"]
    assert ctx["precio"] == 120.0
    assert ctx["tesis"]["id"] == tid
    # Lo importante: queda grabado que se reforzó CON el punto ya cruzado.
    assert len(ctx["disparadores_saltando"]) == 1


def test_una_decision_sin_razonamiento_se_rechaza(client):
    """Sin porqué no es un registro, es una fila."""
    c, _ = client()
    r = c.post("/api/theses/decisiones", json={
        "symbol": "AAPL", "accion": "comprar", "razonamiento": "pq si",
    })
    assert r.status_code == 422


def test_el_diario_trae_el_precio_de_entonces_y_el_de_ahora(client):
    c, _ = client()
    tid = _crear_tesis(c)
    c.post("/api/theses/decisiones", json={
        "symbol": "AAPL", "accion": "comprar", "thesis_id": tid,
        "razonamiento": "Compro porque el mix hacia servicios sostiene el margen.",
    })
    d = c.get("/api/theses/decisiones").json()
    assert len(d["decisiones"]) == 1
    fila = d["decisiones"][0]
    assert fila["price_at_decision"] == 120.0
    assert fila["precio_actual"] == 120.0
    assert fila["cambio_pct"] == 0.0
    assert "NO se hace es puntuar el razonamiento por el resultado" in d["nota"]


def test_el_diario_se_puede_filtrar_por_simbolo(client):
    c, _ = client()
    for s in ("AAPL", "MSFT"):
        c.post("/api/theses/decisiones", json={
            "symbol": s, "accion": "comprar",
            "razonamiento": "Una razón suficientemente larga para pasar el filtro.",
        })
    d = c.get("/api/theses/decisiones?symbol=MSFT").json()
    assert [x["symbol"] for x in d["decisiones"]] == ["MSFT"]


def test_la_coherencia_señala_las_decisiones_sin_tesis(client):
    c, _ = client()
    c.post("/api/theses/decisiones", json={
        "symbol": "AAPL", "accion": "comprar",
        "razonamiento": "Me gusta la empresa y creo que va a subir bastante.",
    })
    d = c.get("/api/theses/decisiones").json()
    assert d["coherencia"]["sin_tesis"] == 1
    assert "no se puede revisar después" in d["coherencia"]["nota"]


def test_una_decision_con_tesis_inexistente_da_404(client):
    c, _ = client()
    r = c.post("/api/theses/decisiones", json={
        "symbol": "AAPL", "accion": "comprar", "thesis_id": 999,
        "razonamiento": "Una razón suficientemente larga para pasar el filtro.",
    })
    assert r.status_code == 404


# --- La tesis se escribe al añadir, y lo que falta se dice --------------------


def test_se_puede_escribir_la_tesis_al_añadir_la_posicion(client):
    """El único momento en que uno tiene clara la razón es cuando decide. Una
    semana después, «me pareció barata» es todo lo que queda."""
    c, _ = client()
    r = c.post("/api/portfolio/positions", json={
        "symbol": "AAPL", "quantity": 10, "cost_basis": 100.0,
        "tesis": {
            "title": "Mix hacia servicios",
            "body_md": "El margen se sostiene por el mix, no por precio.",
            "invalidation_criteria": "Si el margen operativo baja del 18 %.",
        },
    })
    assert r.status_code == 200, r.text
    assert r.json()["thesis_id"] is not None
    assert c.get("/api/theses").json()["theses"][0]["title"] == "Mix hacia servicios"


def test_tambien_al_añadir_a_la_watchlist(client):
    c, _ = client()
    r = c.post("/api/watchlist", json={
        "symbol": "MSFT",
        "tesis": {"title": "Nube", "body_md": "Azure sigue ganando cuota."},
    })
    assert r.json()["thesis_id"] is not None


def test_añadir_sin_tesis_sigue_funcionando(client):
    """Bloquearlo solo conseguiría que dejara de anotar posiciones."""
    c, _ = client()
    r = c.post("/api/portfolio/positions", json={
        "symbol": "AAPL", "quantity": 10, "cost_basis": 100.0,
    })
    assert r.status_code == 200
    assert r.json()["thesis_id"] is None


def test_lo_que_no_tiene_tesis_se_cuenta_y_se_dice(client):
    c, _ = client()
    c.post("/api/portfolio/positions", json={
        "symbol": "AAPL", "quantity": 10, "cost_basis": 100.0,
    })
    c.post("/api/watchlist", json={"symbol": "MSFT"})
    c.post("/api/portfolio/positions", json={
        "symbol": "NVDA", "quantity": 5, "cost_basis": 200.0,
        "tesis": {"title": "GPUs", "body_md": "La demanda de cómputo sigue."},
    })

    d = c.get("/api/theses/sin-tesis").json()
    assert d["posiciones_sin_tesis"] == ["AAPL"]
    assert d["watchlist_sin_tesis"] == ["MSFT"]
    assert "NVDA" not in d["posiciones_sin_tesis"]
    assert "recordarás el resultado, no el porqué" in d["nota"]


def test_con_todo_documentado_no_se_inventa_un_reproche(client):
    c, _ = client()
    c.post("/api/portfolio/positions", json={
        "symbol": "AAPL", "quantity": 10, "cost_basis": 100.0,
        "tesis": {"title": "T", "body_md": "Razón escrita."},
    })
    d = c.get("/api/theses/sin-tesis").json()
    assert d["posiciones_sin_tesis"] == []
    assert "Todas tus posiciones abiertas tienen una tesis escrita" in d["nota"]
