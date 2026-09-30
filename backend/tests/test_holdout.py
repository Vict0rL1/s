"""El holdout bloqueado, bloqueado de verdad.

Fase 10 del RC1. La auditoría encontró dos caminos por los que el holdout —el
tramo final que ningún experimento puede tocar— se tocaba sin que quedara
constancia:

1. **El botón de la interfaz lo miraba siempre.** El comando
   `scripts/run_rule_backtest.py` partía el periodo y usaba solo el desarrollo,
   pero el endpoint `POST /api/signals/rule-backtest` corría sobre TODAS las
   fechas, no registraba el experimento y no contaba la apertura. Cada pulsación
   quemaba el holdout en silencio, y su resultado alimentaba la «confianza» de
   las decisiones de la lista diaria.

2. **El corte se movía con la ventana.** El holdout era «el último 30 % de las
   fechas que pidas». Con 8 años y luego con 5, los cortes caían en sitios
   distintos: parte del holdout de una ejecución era desarrollo en la otra.

Ahora el corte se fija la primera vez y se guarda; nunca se mueve, y nunca cae
antes de una fecha ya usada en desarrollo.
"""

from __future__ import annotations

from datetime import date, datetime, timezone

import pytest

from app.analysis import experiments as ex
from app.analysis.rule_backtest import rebalance_dates_mensuales
from app.db.models import Experiment


def _fechas(desde: str, hasta: str) -> list[date]:
    return rebalance_dates_mensuales(date.fromisoformat(desde), date.fromisoformat(hasta))


def test_el_corte_se_fija_la_primera_vez_y_no_se_mueve(session_factory):
    with session_factory() as s:
        corte_8 = ex.corte_fijo(s, _fechas("2016-01-01", "2024-01-01"))
        corte_5 = ex.corte_fijo(s, _fechas("2019-01-01", "2024-01-01"))
        corte_12 = ex.corte_fijo(s, _fechas("2012-01-01", "2025-06-01"))
    assert corte_8 == corte_5 == corte_12


def test_ninguna_ventana_posterior_mete_el_holdout_en_desarrollo(session_factory):
    """El fallo de antes: con otra ventana, el holdout de ayer era desarrollo hoy."""
    with session_factory() as s:
        corte = ex.corte_fijo(s, _fechas("2016-01-01", "2024-01-01"))
        for desde, hasta in (("2019-01-01", "2024-01-01"), ("2010-01-01", "2026-01-01")):
            p = ex.partir_con_corte(_fechas(desde, hasta), corte)
            assert all(f < corte for f in p["desarrollo"])
            assert all(f >= corte for f in p["holdout"])


def test_el_corte_no_cae_antes_de_lo_ya_usado_en_desarrollo(session_factory):
    """Si el historial ya miró hasta 2023, el holdout no puede empezar en 2022."""
    with session_factory() as s:
        s.add(Experiment(hipotesis="h", estrategia="e", parametros={}, periodo_desde="2015-01-01",
                         periodo_hasta="2023-06-01", universo={}, resultado={}, sharpe=0.1,
                         uso_holdout=False, created_at=datetime.now(timezone.utc)))
        s.commit()
        corte = ex.corte_fijo(s, _fechas("2014-01-01", "2023-12-01"))
    assert corte > date(2023, 6, 1)


def test_sin_fechas_suficientes_no_se_fija_nada(session_factory):
    with session_factory() as s:
        assert ex.corte_fijo(s, _fechas("2023-01-01", "2023-04-01")) is None
        assert ex.corte_fijo(s, _fechas("2016-01-01", "2024-01-01")) is not None


# --- El endpoint de la interfaz ------------------------------------------


@pytest.fixture
def backtest_http(session_factory, monkeypatch):
    from fastapi.testclient import TestClient

    from app.db.engine import get_session
    from app.deps import get_service
    from app.main import app
    from app.routers import signals

    vistas: list[list[date]] = []

    def run_falso(universo, fechas, **kw):
        vistas.append(list(fechas))
        return {"n_operaciones": 0, "operaciones": []}

    monkeypatch.setattr(signals, "run_rule_backtest", run_falso)

    class Servicio:
        def get(self, data_type, **kw):
            if data_type == "financials":
                return {"periods": [{"fiscal_year": 2020}]}
            if data_type == "filings":
                return {"filings": []}
            if data_type == "price_history":
                return {"bars": [{"ts": "2020-01-02", "close": 1.0}]}
            raise AssertionError(data_type)

    def override_session():
        s = session_factory()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_service] = lambda: Servicio()
    app.dependency_overrides[get_session] = override_session
    yield TestClient(app), vistas
    app.dependency_overrides.clear()


def test_el_boton_de_la_interfaz_no_mira_el_holdout(backtest_http, session_factory):
    c, vistas = backtest_http
    r = c.post("/api/signals/rule-backtest", json={"symbols": ["AAA", "BBB", "CCC"], "years": 8})
    assert r.status_code == 200, r.text
    d = r.json()
    corte = date.fromisoformat(d["particion"]["corte"])
    assert vistas and all(f < corte for lote in vistas for f in lote)
    assert d["particion"]["holdout_mirado"] is False


def test_cada_ejecucion_desde_la_interfaz_cuenta_como_experimento(backtest_http, session_factory):
    """Si las pruebas de la interfaz no se anotan, el Sharpe deflactado sale inflado."""
    c, _ = backtest_http
    for anos in (8, 5):
        c.post("/api/signals/rule-backtest", json={"symbols": ["AAA", "BBB", "CCC"], "years": anos})
    with session_factory() as s:
        filas = s.query(Experiment).all()
    assert len(filas) == 2
    assert not any(f.uso_holdout for f in filas)


def test_la_interfaz_no_ofrece_ninguna_forma_de_abrir_el_holdout(backtest_http):
    c, vistas = backtest_http
    r = c.post("/api/signals/rule-backtest",
               json={"symbols": ["AAA", "BBB", "CCC"], "years": 8,
                     "abrir_holdout": "SI, QUEMAR EL HOLDOUT"})
    assert r.status_code == 200
    corte = date.fromisoformat(r.json()["particion"]["corte"])
    assert all(f < corte for lote in vistas for f in lote)


# --- Lo guardado antes del RC1 no cuenta como validación ------------------


def test_un_backtest_guardado_sin_particion_no_valida_las_decisiones(session_factory):
    """Los resultados anteriores al RC1 se calcularon mirando el holdout y no lo
    registraron. No pueden seguir convirtiendo «razonable» en «probada»."""
    import json

    from app.db.models import LlmOutput
    from app.routers.signals import _stored_rule_backtest

    with session_factory() as s:
        s.add(LlmOutput(kind="rule_backtest", model="reglas/6a",
                        content_md=json.dumps({"n_operaciones": 120, "esperanza_pct": 0.9})))
        s.commit()
        assert _stored_rule_backtest(s) is None

        s.add(LlmOutput(kind="rule_backtest", model="reglas/6a",
                        content_md=json.dumps({"n_operaciones": 80, "esperanza_pct": 0.2,
                                               "particion": {"corte": "2023-01-01",
                                                             "holdout_mirado": False}})))
        s.commit()
        assert _stored_rule_backtest(s)["n_operaciones"] == 80


def test_el_endpoint_guarda_la_particion_con_el_resultado(backtest_http, session_factory, monkeypatch):
    import json

    from app.db.models import LlmOutput
    from app.routers import signals

    # La forma que devuelve el backtest de verdad con operaciones: el endpoint
    # redacta su veredicto con estos campos.
    resultado = {"n_operaciones": 5, "operaciones": [], "fiable": False,
                 "esperanza_pct": 0.4, "tasa_acierto": 0.6, "referencia_pct": 0.1,
                 "ventaja_pct": 0.3, "racha_perdedora": 2}
    monkeypatch.setattr(signals, "run_rule_backtest", lambda u, f, **kw: dict(resultado))
    c, _ = backtest_http
    c.post("/api/signals/rule-backtest", json={"symbols": ["AAA", "BBB", "CCC"], "years": 8})
    with session_factory() as s:
        guardado = json.loads(s.query(LlmOutput).one().content_md)
    assert guardado["particion"]["holdout_mirado"] is False and guardado["particion"]["corte"]
