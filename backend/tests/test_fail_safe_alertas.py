"""Alertas: cuatro estados, errores aislados, y ni un aviso repetido.

De la Fase 9 del RC1. Lo que faltaba:

- **«Error al evaluar» no se distinguía de «sin datos».** Las dos cosas
  acababan como `sin_precio`. No son lo mismo: «sin datos» es que el símbolo no
  tiene cotización; «error» es que algo se rompió, y exige mirar.
- **Una alerta rota tumbaba la pasada entera.** El comando del cron solo
  capturaba los fallos esperados del proveedor. Cualquier otra excepción con
  UNA alerta abortaba la revisión de TODAS — y la marca de vigilancia no se
  escribía, así que la pestaña acababa diciendo que el cron no corría.
- **No quedaba registro por alerta.** Sin `last_evaluated_at`, «no ha saltado»
  y «lleva tres días sin poder comprobarse» eran indistinguibles.
- **Un fallo persistente no avisaba nunca.** La alerta que no se puede
  comprobar es la más peligrosa, porque parece tranquila.
"""

from __future__ import annotations

import importlib.util
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from app import vigilancia
from app.analysis import alertas as al
from app.db.models import Alert, Instrument
from app.providers.base import DataNotFoundError
from app.providers.router import AllProvidersFailedError

AHORA = datetime(2026, 9, 29, 15, 0, tzinfo=timezone.utc)


# --- Los cuatro estados --------------------------------------------------


def _a(**kw):
    return {"id": 1, "symbol": "AAPL", "condition": {"op": "lt", "price": 150.0},
            "active": True, "triggered_at": None, **kw}


def test_evaluada_y_falsa():
    v = al.evaluar(_a(), 160.0, AHORA)
    assert v["evaluable"] and not v["cumple"] and v["estado"] == "ok"


def test_evaluada_y_verdadera():
    v = al.evaluar(_a(), 140.0, AHORA)
    assert v["evaluable"] and v["cumple"] and v["estado"] == "ok"


def test_no_evaluada_por_falta_de_datos():
    v = al.evaluar(_a(), None, AHORA)
    assert not v["evaluable"] and not v["cumple"] and v["estado"] == "sin_precio"


def test_error_al_evaluar_es_un_estado_propio():
    v = al.evaluar(_a(), None, AHORA, error="ProviderError: 503")
    assert not v["evaluable"] and not v["cumple"]
    assert v["estado"] == "error"
    assert "503" in v["motivo"]


def test_el_resumen_no_mezcla_sin_datos_con_errores():
    res = [
        {"symbol": "A", "veredicto": al.evaluar(_a(symbol="A"), None, AHORA), "nueva": False},
        {"symbol": "B", "veredicto": al.evaluar(_a(symbol="B"), None, AHORA, error="x"), "nueva": False},
        {"symbol": "C", "veredicto": al.evaluar(_a(symbol="C"), 160.0, AHORA), "nueva": False},
    ]
    s = al.resumir(res)
    assert [r["symbol"] for r in s["sin_datos"]] == ["A"]
    assert [r["symbol"] for r in s["errores"]] == ["B"]
    # Ninguna de las dos cuenta como «no salta».
    assert s["tranquilas"] == 1
    assert "error" in s["resumen"].lower()


# --- Obtener el precio: categorizar el fallo y reintentar ----------------


def test_sin_cotizacion_es_sin_datos():
    def fetch(_):
        raise DataNotFoundError("no existe")
    assert vigilancia.obtener_precio(fetch, "X", dormir=lambda s: None)[1] == "sin_datos"


def test_proveedores_caidos_se_reintentan_una_vez():
    llamadas = []

    def fetch(_):
        llamadas.append(1)
        if len(llamadas) == 1:
            raise AllProvidersFailedError("quote", {"a": "503"})
        return 140.0

    precio, fallo, _ = vigilancia.obtener_precio(fetch, "X", dormir=lambda s: None)
    assert precio == 140.0 and fallo is None and len(llamadas) == 2


def test_si_siguen_caidos_tras_reintentar_es_error():
    def fetch(_):
        raise AllProvidersFailedError("quote", {"a": "503"})
    precio, fallo, detalle = vigilancia.obtener_precio(fetch, "X", dormir=lambda s: None)
    assert precio is None and fallo == "error" and "503" in detalle


def test_una_excepcion_inesperada_se_captura_como_error():
    def fetch(_):
        raise KeyError("price")
    precio, fallo, detalle = vigilancia.obtener_precio(fetch, "X", dormir=lambda s: None)
    assert fallo == "error" and "KeyError" in detalle


def test_un_precio_corrupto_es_sin_datos_no_una_comparacion():
    precio, fallo, _ = vigilancia.obtener_precio(lambda _: float("nan"), "X", dormir=lambda s: None)
    assert precio is None and fallo == "sin_datos"


# --- El comando del cron: aislamiento, registro, avisos de error ---------


GUION = Path(__file__).resolve().parent.parent / "scripts" / "revisar_alertas.py"


def _cargar():
    spec = importlib.util.spec_from_file_location("revisar_alertas_fs", GUION)
    modulo = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(modulo)
    return modulo


class Servicio:
    def __init__(self, comportamiento):
        self.comportamiento = comportamiento
        self.cache = None

    def get(self, data_type, **kw):
        r = self.comportamiento[kw["symbol"]]
        if isinstance(r, Exception):
            raise r
        return {"symbol": kw["symbol"], "price": r}


@pytest.fixture
def cron(session_factory, tmp_path, monkeypatch):
    modulo = _cargar()
    avisos: list[tuple[str, str]] = []

    def preparar(simbolos):
        with session_factory() as s:
            for sym, umbral in simbolos:
                inst = Instrument(symbol=sym, name=sym)
                s.add(inst)
                s.flush()
                s.add(Alert(instrument_id=inst.id, kind="price",
                            condition={"op": "lt", "price": umbral}, active=True))
            s.commit()

    def correr(comportamiento, cuando=AHORA):
        monkeypatch.setattr(modulo, "init_db", lambda: None)
        monkeypatch.setattr(modulo, "SessionLocal", session_factory)
        monkeypatch.setattr(modulo, "get_service", lambda: Servicio(comportamiento))
        monkeypatch.setattr(modulo, "notificar",
                            lambda t, c: avisos.append((t, c)) or {"enviado": True, "via": "x"})
        monkeypatch.setattr(modulo, "_ahora", lambda: cuando)
        monkeypatch.setattr(modulo.settings, "database_path", str(tmp_path / "app.db"))
        monkeypatch.setattr(vigilancia, "PAUSA_REINTENTO_S", 0)
        return modulo.revisar()

    return preparar, correr, avisos, session_factory


def _alerta(factory, sym):
    with factory() as s:
        return (s.query(Alert).join(Instrument, Alert.instrument_id == Instrument.id)
                .filter(Instrument.symbol == sym).one())


def test_una_alerta_rota_no_tumba_la_revision_de_las_demas(cron):
    preparar, correr, avisos, factory = cron
    preparar([("ROTA", 100.0), ("AAPL", 150.0)])
    salida = correr({"ROTA": RuntimeError("fallo raro"), "AAPL": 140.0})
    # AAPL se evaluó y saltó pese a que ROTA reventó.
    assert [n["symbol"] for n in salida["nuevas"]] == ["AAPL"]
    assert [e["symbol"] for e in salida["errores"]] == ["ROTA"]


def test_cada_evaluacion_queda_registrada_en_la_alerta(cron):
    preparar, correr, _, factory = cron
    preparar([("ROTA", 100.0), ("AAPL", 150.0)])
    correr({"ROTA": RuntimeError("fallo raro"), "AAPL": 160.0})

    ok = _alerta(factory, "AAPL")
    assert al.como_utc(ok.last_evaluated_at) == AHORA
    assert ok.last_result == "no_cumplida" and ok.last_error is None

    rota = _alerta(factory, "ROTA")
    assert rota.last_result == "error"
    assert "fallo raro" in rota.last_error
    assert rota.consecutive_errors == 1


def test_un_fallo_persistente_avisa_una_vez_y_no_repite(cron):
    """La alerta que no se puede comprobar parece tranquila: hay que decirlo.

    Pero una sola vez: tres pasadas seguidas sin poder comprobar → un aviso; las
    siguientes, silencio hasta que pase el enfriamiento o se recupere.
    """
    preparar, correr, avisos, _ = cron
    preparar([("ROTA", 100.0)])
    fallo = {"ROTA": AllProvidersFailedError("quote", {"a": "503"})}
    for i in range(vigilancia.UMBRAL_ERRORES_AVISO - 1):
        correr(fallo, AHORA + timedelta(minutes=15 * i))
    assert avisos == []

    correr(fallo, AHORA + timedelta(minutes=15 * vigilancia.UMBRAL_ERRORES_AVISO))
    assert len(avisos) == 1
    titulo, cuerpo = avisos[0]
    assert "ROTA" in titulo + cuerpo and "no se" in titulo.lower()

    for i in range(5):
        correr(fallo, AHORA + timedelta(hours=1, minutes=15 * i))
    assert len(avisos) == 1, "el mismo fallo se avisó más de una vez"


def test_pasado_el_enfriamiento_un_fallo_que_sigue_se_recuerda(cron):
    preparar, correr, avisos, _ = cron
    preparar([("ROTA", 100.0)])
    fallo = {"ROTA": AllProvidersFailedError("quote", {"a": "503"})}
    for i in range(vigilancia.UMBRAL_ERRORES_AVISO):
        correr(fallo, AHORA + timedelta(minutes=15 * i))
    assert len(avisos) == 1
    correr(fallo, AHORA + vigilancia.ENFRIAMIENTO_AVISO_ERROR + timedelta(hours=1))
    assert len(avisos) == 2


def test_al_recuperarse_se_rearma_el_aviso_de_error(cron):
    preparar, correr, avisos, factory = cron
    preparar([("ROTA", 100.0)])
    fallo = {"ROTA": AllProvidersFailedError("quote", {"a": "503"})}
    for i in range(vigilancia.UMBRAL_ERRORES_AVISO):
        correr(fallo, AHORA + timedelta(minutes=15 * i))
    correr({"ROTA": 120.0}, AHORA + timedelta(hours=2))
    a = _alerta(factory, "ROTA")
    assert a.consecutive_errors == 0 and a.last_error is None and a.error_notified_at is None


def test_una_alerta_cumplida_no_se_vuelve_a_avisar_en_horas(cron):
    """El anti-spam de siempre, ahora con test explícito a lo largo de horas."""
    preparar, correr, avisos, _ = cron
    preparar([("AAPL", 150.0)])
    for i in range(12):  # tres horas de cron cada quince minutos
        correr({"AAPL": 140.0}, AHORA + timedelta(minutes=15 * i))
    assert len(avisos) == 1


def test_el_endpoint_distingue_error_de_sin_datos(session_factory, tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from app.config import settings
    from app.db.engine import get_session
    from app.deps import get_service
    from app.main import app

    monkeypatch.setattr(settings, "database_path", str(tmp_path / "app.db"))
    with session_factory() as s:
        for sym in ("CAIDA", "NOEXISTE"):
            inst = Instrument(symbol=sym, name=sym)
            s.add(inst)
            s.flush()
            s.add(Alert(instrument_id=inst.id, kind="price",
                        condition={"op": "lt", "price": 10.0}, active=True))
        s.commit()

    servicio = Servicio({
        "CAIDA": AllProvidersFailedError("quote", {"finnhub": "503"}),
        "NOEXISTE": DataNotFoundError("sin cotización"),
    })

    def override_session():
        s = session_factory()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_service] = lambda: servicio
    app.dependency_overrides[get_session] = override_session
    try:
        d = {a["symbol"]: a for a in TestClient(app).get("/api/portfolio/alerts").json()["alerts"]}
    finally:
        app.dependency_overrides.clear()

    assert d["CAIDA"]["estado"] == "error" and d["CAIDA"]["triggered"] is None
    assert "503" in d["CAIDA"]["last_error"]
    assert d["NOEXISTE"]["estado"] == "sin_precio" and d["NOEXISTE"]["triggered"] is None
    assert d["CAIDA"]["last_evaluated_at"].endswith("+00:00")


# --- Con un precio VIEJO: «saltó» se puede afirmar, «no salta» no -----------
#
# Visto en el navegador: la alerta de MSFT salía «no cumplida» evaluada contra
# un precio rescatado de hace 11 minutos. Con un precio viejo se puede afirmar
# que la condición SE CUMPLIÓ —el cruce ocurrió—, pero no que no se cumple
# ahora: en esos minutos el precio pudo cruzar el umbral.


def _viejo(precio, minutos=11):
    return {"price": precio, "estado": "viejo", "antiguedad_segundos": minutos * 60}


def test_un_precio_viejo_se_reconoce_como_tal():
    precio, fallo, detalle = vigilancia.obtener_precio(lambda _: _viejo(412.0), "MSFT",
                                                       dormir=lambda s: None)
    assert precio == 412.0 and fallo == "viejo" and "11 min" in detalle


def test_con_precio_viejo_no_cumplida_es_sin_comprobar(session_factory):
    with session_factory() as s:
        inst = Instrument(symbol="MSFT", name="MSFT")
        s.add(inst)
        s.flush()
        a = Alert(instrument_id=inst.id, kind="price", condition={"op": "lt", "price": 350.0},
                  active=True)
        s.add(a)
        s.flush()
        r = vigilancia.evaluar_y_registrar(a, "MSFT", 412.0, "viejo", "de hace 11 min", AHORA)
        assert r["veredicto"]["estado"] == "sin_precio" and not r["veredicto"]["evaluable"]
        assert "viejo" in r["veredicto"]["motivo"].lower()
        assert a.last_result == "sin_precio" and a.consecutive_errors == 1


def test_con_precio_viejo_cumplida_si_salta_y_lo_dice(session_factory):
    with session_factory() as s:
        inst = Instrument(symbol="MSFT", name="MSFT")
        s.add(inst)
        s.flush()
        a = Alert(instrument_id=inst.id, kind="price", condition={"op": "lt", "price": 450.0},
                  active=True)
        s.add(a)
        s.flush()
        r = vigilancia.evaluar_y_registrar(a, "MSFT", 412.0, "viejo", "de hace 11 min", AHORA)
        assert r["veredicto"]["cumple"] and r["nueva"]
        assert "11 min" in r["veredicto"]["motivo"]
