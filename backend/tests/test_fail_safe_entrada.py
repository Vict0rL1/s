"""Lo que entra por la API: ni infinitos, ni fechas imposibles, ni dobles clics.

De la Fase 8 del RC1. Tres agujeros en los endpoints que escriben:

- `quantity: float = Field(gt=0)` rechaza NaN (porque `NaN > 0` es False) pero
  ACEPTA `Infinity`, que el `json` de Python lee sin quejarse. Una posición de
  infinitas acciones hace infinito el valor, el peso y el riesgo de la cartera.
- `opened_at` mal escrito reventaba con 500 en vez de 422, y una fecha futura
  se aceptaba: una compra de 2031 descoloca la curva histórica y el tipo de
  cambio de compra.
- Un doble clic en «añadir» creaba dos posiciones idénticas. La cartera sale
  con el doble de exposición sin que nadie lo decidiera.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.db.engine import get_session
from app.db.models import Alert, Position
from app.deps import get_service
from app.main import app
from app.providers.base import iso_utc


def _crudo(c, ruta, cuerpo: str):
    """Envía el JSON tal cual. httpx se niega a CODIFICAR `Infinity`, pero un
    cliente que lo mande crudo sí llega al servidor, y el `json` de Python lo lee."""
    return c.post(ruta, content=cuerpo, headers={"content-type": "application/json"})


class Servicio:
    def get(self, data_type, **kw):
        common = {"source": "fake", "as_of": iso_utc(), "cached": False}
        if data_type == "profile":
            return {**common, "symbol": kw["symbol"], "name": kw["symbol"],
                    "sector": "Tech", "currency": "USD"}
        if data_type == "quote":
            return {**common, "symbol": kw["symbol"], "price": 100.0, "currency": "USD"}
        raise AssertionError(data_type)


@pytest.fixture
def api(session_factory):
    def override_session():
        s = session_factory()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_service] = lambda: Servicio()
    app.dependency_overrides[get_session] = override_session
    yield TestClient(app), session_factory
    app.dependency_overrides.clear()


# --- Infinitos -----------------------------------------------------------


@pytest.mark.parametrize("campo", ["quantity", "cost_basis"])
def test_una_posicion_infinita_se_rechaza(api, campo):
    c, factory = api
    cuerpo = {"symbol": '"AAPL"', "quantity": "10", "cost_basis": "100.0", campo: "Infinity"}
    r = _crudo(c, "/api/portfolio/positions",
               "{" + ", ".join(f'"{k}": {v}' for k, v in cuerpo.items()) + "}")
    assert r.status_code == 422, r.text
    with factory() as s:
        assert s.query(Position).count() == 0


def test_un_precio_de_venta_infinito_se_rechaza(api):
    c, _ = api
    pid = c.post("/api/portfolio/positions",
                 json={"symbol": "AAPL", "quantity": 10, "cost_basis": 100.0}).json()["id"]
    r = _crudo(c, f"/api/portfolio/positions/{pid}/close", '{"exit_price": Infinity}')
    assert r.status_code == 422


def test_una_alerta_con_umbral_infinito_se_rechaza(api):
    c, _ = api
    r = _crudo(c, "/api/portfolio/alerts", '{"symbol": "AAPL", "op": "gt", "price": Infinity}')
    assert r.status_code == 422


# --- Fechas --------------------------------------------------------------


def test_una_fecha_mal_escrita_es_un_422_no_un_500(api):
    c, _ = api
    r = c.post("/api/portfolio/positions",
               json={"symbol": "AAPL", "quantity": 10, "cost_basis": 100.0, "opened_at": "ayer"})
    assert r.status_code == 422
    assert "fecha" in r.text.lower()


def test_una_compra_en_el_futuro_se_rechaza(api):
    c, _ = api
    futuro = (datetime.now(timezone.utc) + timedelta(days=30)).date().isoformat()
    r = c.post("/api/portfolio/positions",
               json={"symbol": "AAPL", "quantity": 10, "cost_basis": 100.0, "opened_at": futuro})
    assert r.status_code == 422


def test_una_fecha_sin_zona_se_guarda_como_utc(api):
    c, factory = api
    r = c.post("/api/portfolio/positions",
               json={"symbol": "AAPL", "quantity": 10, "cost_basis": 100.0,
                     "opened_at": "2026-01-15"})
    assert r.status_code == 200, r.text


# --- Duplicados ----------------------------------------------------------


def test_un_doble_clic_no_crea_dos_posiciones(api):
    c, factory = api
    cuerpo = {"symbol": "AAPL", "quantity": 10, "cost_basis": 100.0}
    assert c.post("/api/portfolio/positions", json=cuerpo).status_code == 200
    r = c.post("/api/portfolio/positions", json=cuerpo)
    assert r.status_code == 409
    assert "duplicad" in r.json()["detail"].lower()
    with factory() as s:
        assert s.query(Position).count() == 1


def test_un_segundo_lote_de_verdad_se_puede_confirmar(api):
    """Comprar otra vez lo mismo al mismo precio existe: se permite, a sabiendas."""
    c, factory = api
    cuerpo = {"symbol": "AAPL", "quantity": 10, "cost_basis": 100.0}
    c.post("/api/portfolio/positions", json=cuerpo)
    r = c.post("/api/portfolio/positions", json={**cuerpo, "confirmar_duplicado": True})
    assert r.status_code == 200
    with factory() as s:
        assert s.query(Position).count() == 2


def test_un_lote_distinto_no_es_un_duplicado(api):
    c, factory = api
    c.post("/api/portfolio/positions", json={"symbol": "AAPL", "quantity": 10, "cost_basis": 100.0})
    r = c.post("/api/portfolio/positions", json={"symbol": "AAPL", "quantity": 5, "cost_basis": 100.0})
    assert r.status_code == 200


def test_la_misma_alerta_dos_veces_no_se_duplica(api):
    """Dos alertas idénticas mandarían dos avisos idénticos."""
    c, factory = api
    cuerpo = {"symbol": "AAPL", "op": "lt", "price": 140.0}
    a = c.post("/api/portfolio/alerts", json=cuerpo).json()
    b = c.post("/api/portfolio/alerts", json=cuerpo).json()
    assert a["id"] == b["id"]
    assert b["duplicada"] is True
    with factory() as s:
        assert s.query(Alert).count() == 1


def test_una_alerta_con_otro_umbral_no_es_duplicada(api):
    c, factory = api
    c.post("/api/portfolio/alerts", json={"symbol": "AAPL", "op": "lt", "price": 140.0})
    c.post("/api/portfolio/alerts", json={"symbol": "AAPL", "op": "lt", "price": 130.0})
    with factory() as s:
        assert s.query(Alert).count() == 2


# --- El stop se congela al abrir la posición ------------------------------


def test_abrir_una_posicion_fija_su_stop(api):
    c, factory = api
    c.post("/api/portfolio/positions", json={"symbol": "AAPL", "quantity": 10, "cost_basis": 150.0})
    with factory() as s:
        p = s.query(Position).one()
    assert p.stop is not None and 0 < p.stop < 150.0


def test_el_stop_se_puede_dar_a_mano(api):
    c, factory = api
    r = c.post("/api/portfolio/positions",
               json={"symbol": "AAPL", "quantity": 10, "cost_basis": 150.0, "stop": 140.0})
    assert r.status_code == 200
    with factory() as s:
        assert s.query(Position).one().stop == 140.0


@pytest.mark.parametrize("stop", [150.0, 160.0, 0.0, -5.0])
def test_un_stop_por_encima_del_coste_o_no_positivo_se_rechaza(api, stop):
    c, _ = api
    r = c.post("/api/portfolio/positions",
               json={"symbol": "AAPL", "quantity": 10, "cost_basis": 150.0, "stop": stop})
    assert r.status_code == 422


def test_la_cartera_usa_el_stop_fijado_no_uno_recalculado(api):
    c, factory = api
    c.post("/api/portfolio/positions",
           json={"symbol": "AAPL", "quantity": 10, "cost_basis": 150.0, "stop": 140.0})
    port = c.get("/api/portfolio").json()
    assert port["positions"][0]["stop"] == 140.0
    assert port["positions"][0]["stop_fijado_al_abrir"] is True


# --- Fechas con zona, siempre ---------------------------------------------


def test_las_fechas_de_posiciones_y_watchlist_llevan_zona(api):
    """SQLite pierde la zona al guardar: sin marcarla al servir, el navegador
    lee el instante como hora local y una compra a medianoche UTC cambia de DÍA
    en husos negativos. Mismo fallo que se arregló en las alertas (e3265f5)."""
    c, _ = api
    pid = c.post("/api/portfolio/positions",
                 json={"symbol": "AAPL", "quantity": 10, "cost_basis": 100.0,
                       "opened_at": "2026-01-15"}).json()["id"]
    c.post("/api/watchlist", json={"symbol": "MSFT"})
    port = c.get("/api/portfolio").json()
    assert port["positions"][0]["opened_at"].endswith("+00:00")
    c.post(f"/api/portfolio/positions/{pid}/close", json={"exit_price": 110.0})
    cerrada = c.get("/api/portfolio").json()["closed_positions"][0]
    assert cerrada["opened_at"].endswith("+00:00") and cerrada["closed_at"].endswith("+00:00")
    wl = c.get("/api/watchlist").json()
    items = wl.get("items") or wl.get("watchlist") or []
    assert items and all(i["added_at"].endswith("+00:00") for i in items)


# --- Fijar el stop de una posición abierta: subir sí, bajar nunca -----------
#
# Las posiciones anteriores al RC1 no tienen stop fijado. Poder fijarlo evita
# tener que cerrarlas y reabrirlas. Pero BAJAR un stop es exactamente la evasión
# que se cerró en f124d24 —alejarlo cuando el precio se acerca—, así que eso no
# se permite. Subirlo (asegurar beneficio) sí.


def _posicion_sin_stop(factory):
    from app.db.models import Instrument

    with factory() as s:
        inst = Instrument(symbol="OLD", name="OLD", currency="USD")
        s.add(inst)
        s.flush()
        p = Position(instrument_id=inst.id, quantity=10, cost_basis=100.0,
                     opened_at=datetime.now(timezone.utc), stop=None)
        s.add(p)
        s.commit()
        return p.id


def test_se_puede_fijar_el_stop_de_una_posicion_antigua(api):
    c, factory = api
    pid = _posicion_sin_stop(factory)
    r = c.post(f"/api/portfolio/positions/{pid}/stop", json={"stop": 90.0})
    assert r.status_code == 200, r.text
    with factory() as s:
        assert s.get(Position, pid).stop == 90.0


def test_un_stop_se_puede_subir(api):
    c, factory = api
    pid = _posicion_sin_stop(factory)
    c.post(f"/api/portfolio/positions/{pid}/stop", json={"stop": 90.0})
    assert c.post(f"/api/portfolio/positions/{pid}/stop", json={"stop": 105.0}).status_code == 200


def test_un_stop_no_se_puede_bajar(api):
    c, factory = api
    pid = _posicion_sin_stop(factory)
    c.post(f"/api/portfolio/positions/{pid}/stop", json={"stop": 90.0})
    r = c.post(f"/api/portfolio/positions/{pid}/stop", json={"stop": 80.0})
    assert r.status_code == 409
    assert "bajar" in r.json()["detail"].lower()
    with factory() as s:
        assert s.get(Position, pid).stop == 90.0


@pytest.mark.parametrize("stop", [0.0, -5.0])
def test_un_stop_no_positivo_se_rechaza_al_fijarlo(api, stop):
    c, factory = api
    pid = _posicion_sin_stop(factory)
    assert c.post(f"/api/portfolio/positions/{pid}/stop", json={"stop": stop}).status_code == 422


def test_no_se_fija_el_stop_de_una_posicion_cerrada_o_inexistente(api):
    c, factory = api
    pid = _posicion_sin_stop(factory)
    c.post(f"/api/portfolio/positions/{pid}/close", json={"exit_price": 110.0})
    assert c.post(f"/api/portfolio/positions/{pid}/stop", json={"stop": 90.0}).status_code == 409
    assert c.post("/api/portfolio/positions/9999/stop", json={"stop": 90.0}).status_code == 404
