"""Instantáneas de decisión: congeladas de verdad, reconstruibles, medibles.

Lo que se comprueba, por orden de importancia:

1. Que una instantánea NO se puede modificar ni borrar — ni desde la app, ni
   desde SQL directo sobre una base migrada. Si se pudiera, el forward testing
   mediría lo que alguien quiso que el sistema supiera.
2. Que con la instantánea sola se contesta «¿por qué dijo esto aquel día?»,
   aunque la base haya cambiado después.
3. Que el resultado se mide después sin tocar la instantánea, y que una cuenta
   cerrada no se reabre.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import DatabaseError
from sqlalchemy.orm import sessionmaker

from app import snapshots as sn
from app.db.migraciones import migrar
from app.db.models import DecisionOutcome, DecisionSnapshot

AHORA = datetime(2026, 9, 12, 14, 30, tzinfo=timezone.utc)


def _senal(symbol="AAPL", accion="comprar", precio=100.0, owned=False):
    return {
        "symbol": symbol,
        "score": 0.62,
        "price": {"last": precio, "sma200": 90.0, "daily_vol_pct": 1.5,
                  "source": "finnhub", "as_of": "2026-09-12T14:00:00+00:00", "estado": "valido"},
        "context": {"sector_name": "Technology"},
        "decision": {
            "action": accion,
            "reasons": ["Puntuación +0,62 y precio sobre su media de 200 sesiones."],
            "triggers": ["Vender si cierra por debajo de 88"],
            "levels": {"stop": 88.0, "objetivo": 124.0, "peso_bruto_pct": 8.3},
            "confidence": "sin validar",
            "owned": owned,
        },
    }


def _payload(ideas=None, evitar=None, signals=None):
    return {
        "market": "sp500",
        "complete": True,
        "scored": 480,
        "requested": 500,
        "calibrated": False,
        "unavailable": [],
        "signals": signals or [],
        "shortlist": {
            "ideas": ideas or [],
            "evitar": evitar or [],
            "sizing": {
                "controles": [{"limite": "correlación", "aplicado": False,
                               "motivo": "Solo se pudieron medir 3 de 10 parejas"}],
                "todos_los_limites_aplicados": False,
                "recortes": ["«Technology»: 30 % → 25 %"],
            },
        },
    }


# --- Congelar --------------------------------------------------------------


def test_se_congela_lo_accionable_con_todo_lo_que_se_vio(session_factory):
    idea = {**_senal(), "peso_final_pct": 6.1}
    with session_factory() as s:
        r = sn.congelar_lista_diaria(s, _payload(ideas=[idea]), "hoy:sp500", AHORA)
        assert r == {"guardadas": 1, "ya_existian": 0, "error": None}
        snap = s.query(DecisionSnapshot).one()
    assert snap.accion == "comprar" and snap.precio == 100.0
    assert snap.peso_final_pct == 6.1 and snap.stop == 88.0
    assert snap.reglas_version == sn.version_de_reglas()
    # El contexto lleva la señal entera y los límites que NO se pudieron aplicar.
    assert snap.contexto["senal"]["price"]["source"] == "finnhub"
    assert snap.contexto["sizing"]["todos_los_limites_aplicados"] is False


def test_la_primera_del_dia_gana(session_factory):
    """Recalcular por la tarde no reescribe lo que se vio por la mañana."""
    with session_factory() as s:
        sn.congelar_lista_diaria(s, _payload(ideas=[_senal(precio=100.0)]), "hoy:sp500", AHORA)
        r = sn.congelar_lista_diaria(
            s, _payload(ideas=[_senal(precio=105.0)]), "hoy:sp500", AHORA + timedelta(hours=4)
        )
        assert r["guardadas"] == 0 and r["ya_existian"] == 1
        assert s.query(DecisionSnapshot).one().precio == 100.0


def test_el_dia_siguiente_es_otra_instantanea(session_factory):
    with session_factory() as s:
        sn.congelar_lista_diaria(s, _payload(ideas=[_senal()]), "hoy:sp500", AHORA)
        sn.congelar_lista_diaria(s, _payload(ideas=[_senal()]), "hoy:sp500", AHORA + timedelta(days=1))
        assert s.query(DecisionSnapshot).count() == 2


def test_se_congelan_evitar_y_las_ventas_de_lo_que_tienes(session_factory):
    evitar = _senal("BAD", "evitar")
    vender = _senal("OWN", "vender", owned=True)
    neutral = _senal("MEH", "vigilar")
    with session_factory() as s:
        sn.congelar_lista_diaria(
            s, _payload(evitar=[evitar], signals=[vender, neutral]), "hoy:sp500", AHORA
        )
        acciones = {x.symbol: x.accion for x in s.query(DecisionSnapshot)}
    assert acciones == {"BAD": "evitar", "OWN": "vender"}  # «vigilar» no es una afirmación


def test_un_nan_en_la_senal_no_corrompe_el_registro(session_factory):
    senal = _senal()
    senal["score"] = float("nan")
    senal["factors"] = {"valor": float("inf")}
    with session_factory() as s:
        sn.congelar_lista_diaria(s, _payload(ideas=[senal]), "hoy:sp500", AHORA)
        snap = s.query(DecisionSnapshot).one()
    assert snap.score is None
    assert snap.contexto["senal"]["factors"]["valor"] is None


def test_la_version_de_reglas_cambia_si_cambia_un_parametro(monkeypatch):
    antes = sn.version_de_reglas()
    monkeypatch.setattr(sn.sizing, "MAX_POR_SECTOR_PCT", 30.0)
    assert sn.version_de_reglas() != antes


# --- Inmutable -------------------------------------------------------------


def test_el_orm_no_deja_modificar_una_instantanea(session_factory):
    with session_factory() as s:
        sn.congelar_lista_diaria(s, _payload(ideas=[_senal()]), "hoy:sp500", AHORA)
        snap = s.query(DecisionSnapshot).one()
        snap.accion = "vender"
        with pytest.raises(ValueError, match="no se modifica"):
            s.commit()


def test_el_orm_no_deja_borrar_una_instantanea(session_factory):
    with session_factory() as s:
        sn.congelar_lista_diaria(s, _payload(ideas=[_senal()]), "hoy:sp500", AHORA)
        s.delete(s.query(DecisionSnapshot).one())
        with pytest.raises(ValueError, match="no se borra"):
            s.commit()


def test_ni_siquiera_con_sql_directo_sobre_una_base_migrada(tmp_path):
    """El ORM se puede saltar; los triggers de la migración 0004, no."""
    engine = create_engine(f"sqlite:///{tmp_path / 'x.db'}")
    migrar(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with factory() as s:
        sn.congelar_lista_diaria(s, _payload(ideas=[_senal()]), "hoy:sp500", AHORA)
    for sql in ("UPDATE decision_snapshots SET accion = 'vender'", "DELETE FROM decision_snapshots"):
        with pytest.raises(DatabaseError):
            with engine.begin() as c:
                c.execute(text(sql))
    with engine.connect() as c:
        assert c.execute(text("SELECT accion FROM decision_snapshots")).scalar() == "comprar"


# --- Reconstruir -----------------------------------------------------------


def test_se_puede_contestar_por_que_dijo_esto_aquel_dia(session_factory):
    idea = {**_senal(), "peso_final_pct": 6.1}
    with session_factory() as s:
        sn.congelar_lista_diaria(s, _payload(ideas=[idea]), "hoy:sp500", AHORA)
        r = sn.reconstruir(s.query(DecisionSnapshot).one())
    assert r["fecha"] == "2026-09-12" and r["accion"] == "comprar"
    assert r["precio"]["fuente"] == "finnhub" and r["precio"]["estado"] == "valido"
    assert "media de 200" in r["razones"][0]
    assert r["tamano"]["todos_los_limites_aplicados"] is False
    assert r["integridad"]["huella_coincide"] is True


def test_una_instantanea_manipulada_se_detecta(session_factory):
    """Si alguien salta ORM y triggers, la huella lo delata."""
    with session_factory() as s:
        sn.congelar_lista_diaria(s, _payload(ideas=[_senal()]), "hoy:sp500", AHORA)
        snap = s.query(DecisionSnapshot).one()
    snap.contexto = {**snap.contexto, "senal": {**snap.contexto["senal"], "score": 0.99}}
    r = sn.reconstruir(snap)
    assert r["integridad"]["huella_coincide"] is False
    assert "modificado" in r["integridad"]["nota"]


# --- Medir después ---------------------------------------------------------


def _snap(accion="comprar", precio=100.0, stop=88.0, objetivo=124.0):
    return DecisionSnapshot(
        id=1, fecha="2026-09-12", accion=accion, precio=precio, stop=stop,
        objetivo=objetivo, horizonte_dias=sn.HORIZONTE_DIAS,
    )


def _cierres(valores, desde=date(2026, 9, 12)):
    return [(desde + timedelta(days=i), v) for i, v in enumerate(valores)]


def test_una_compra_que_toca_el_stop_se_cierra_en_el_stop():
    r = sn.evaluar_resultado(_snap(), _cierres([100, 97, 92, 87, 110, 130]), date(2026, 10, 30))
    assert r["estado"] == "stop" and r["precio"] == 87 and r["retorno_pct"] == -13.0


def test_una_compra_que_toca_el_objetivo_se_cierra_en_el_objetivo():
    r = sn.evaluar_resultado(_snap(), _cierres([100, 110, 125, 80]), date(2026, 10, 30))
    assert r["estado"] == "objetivo" and r["retorno_pct"] == 25.0


def test_el_cierre_del_dia_de_la_instantanea_no_cuenta():
    """Solo lo POSTERIOR a la decisión. El día 0 ya estaba en el precio."""
    r = sn.evaluar_resultado(_snap(), _cierres([50, 101]), date(2026, 9, 20))
    assert r["estado"] == "abierta" and r["precio"] == 101


def test_sin_tocar_nada_y_antes_del_horizonte_sigue_abierta():
    r = sn.evaluar_resultado(_snap(), _cierres([100, 102, 104]), date(2026, 9, 20))
    assert r["estado"] == "abierta" and r["retorno_pct"] == 4.0


def test_pasado_el_horizonte_se_cierra():
    r = sn.evaluar_resultado(
        _snap(), _cierres([100] + [101] * 250), date(2026, 9, 12) + timedelta(days=300)
    )
    assert r["estado"] == "horizonte"


def test_una_venta_se_mide_por_lo_que_hizo_el_precio_despues():
    r = sn.evaluar_resultado(_snap("vender", stop=None, objetivo=None),
                             _cierres([100, 90, 80]), date(2026, 9, 20))
    assert r["retorno_pct"] == -20.0 and r["detalle"]["a_favor"] == "bajada"


def test_sin_precios_posteriores_es_sin_datos_no_un_cero():
    r = sn.evaluar_resultado(_snap(), [], date(2026, 9, 20))
    assert r["estado"] == "sin_datos" and r["retorno_pct"] is None


def test_una_cuenta_cerrada_no_se_reabre(session_factory):
    with session_factory() as s:
        sn.congelar_lista_diaria(s, _payload(ideas=[_senal()]), "hoy:sp500", AHORA)
        snap = s.query(DecisionSnapshot).one()
        cerrado = sn.evaluar_resultado(snap, _cierres([100, 87]), date(2026, 9, 20))
        assert sn.registrar_resultado(s, snap, cerrado, AHORA + timedelta(days=8))
        s.commit()
        despues = sn.evaluar_resultado(snap, _cierres([100, 87, 130]), date(2026, 9, 25))
        assert sn.registrar_resultado(s, snap, despues, AHORA + timedelta(days=13)) is None
        assert s.query(DecisionOutcome).count() == 1
        # Y la instantánea sigue exactamente igual.
        assert sn.reconstruir(snap)["integridad"]["huella_coincide"]


def test_como_mucho_una_evaluacion_abierta_al_dia(session_factory):
    with session_factory() as s:
        sn.congelar_lista_diaria(s, _payload(ideas=[_senal()]), "hoy:sp500", AHORA)
        snap = s.query(DecisionSnapshot).one()
        r = sn.evaluar_resultado(snap, _cierres([100, 101]), date(2026, 9, 14))
        dia = AHORA + timedelta(days=2)
        assert sn.registrar_resultado(s, snap, r, dia)
        s.commit()
        assert sn.registrar_resultado(s, snap, r, dia + timedelta(hours=3)) is None


# --- El endpoint -----------------------------------------------------------


def test_el_endpoint_devuelve_la_instantanea_reconstruida(session_factory):
    from fastapi.testclient import TestClient

    from app.db.engine import get_session
    from app.main import app

    with session_factory() as s:
        sn.congelar_lista_diaria(s, _payload(ideas=[{**_senal(), "peso_final_pct": 6.1}]),
                                 "hoy:sp500", AHORA)

    def override_session():
        s = session_factory()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_session] = override_session
    try:
        c = TestClient(app)
        lista = c.get("/api/snapshots?symbol=aapl&desde=2026-09-01").json()
        assert [x["symbol"] for x in lista["instantaneas"]] == ["AAPL"]
        d = c.get(f"/api/snapshots/{lista['instantaneas'][0]['id']}").json()
        assert d["fecha"] == "2026-09-12" and d["integridad"]["huella_coincide"]
        assert c.get("/api/snapshots?desde=ayer").status_code == 422
        assert c.get("/api/snapshots/999").status_code == 404
        # Solo lectura: no hay forma de escribir por la API.
        assert c.post("/api/snapshots", json={}).status_code == 405
    finally:
        app.dependency_overrides.clear()


def test_el_comando_diario_mide_sin_tocar_las_instantaneas(session_factory, monkeypatch):
    import importlib.util
    from pathlib import Path

    ruta = Path(__file__).resolve().parent.parent / "scripts" / "evaluar_instantaneas.py"
    spec = importlib.util.spec_from_file_location("evaluar_instantaneas", ruta)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    with session_factory() as s:
        sn.congelar_lista_diaria(s, _payload(ideas=[_senal()]), "hoy:sp500", AHORA)

    class Servicio:
        def get(self, data_type, **kw):
            assert data_type == "price_history_long"
            return {"bars": [{"ts": "2026-09-12", "close": 100.0},
                             {"ts": "2026-09-15", "close": 126.0}]}

    monkeypatch.setattr(mod, "init_db", lambda: None)
    monkeypatch.setattr(mod, "SessionLocal", session_factory)
    monkeypatch.setattr(mod, "get_service", lambda: Servicio())
    cuenta = mod.evaluar(ahora=AHORA + timedelta(days=5))
    assert cuenta["cerradas_ahora"] == 1
    # Segunda pasada: ya cerrada, no añade nada.
    assert mod.evaluar(ahora=AHORA + timedelta(days=6))["evaluadas"] == 0
    with session_factory() as s:
        assert s.query(DecisionOutcome).one().estado == "objetivo"
        assert sn.reconstruir(s.query(DecisionSnapshot).one())["integridad"]["huella_coincide"]
