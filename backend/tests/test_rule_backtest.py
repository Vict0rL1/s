"""Tests del backtest de reglas: ¿ganan dinero, y no está haciendo trampa?

Un backtest que se engaña a sí mismo es peor que no tenerlo: da confianza
falsa sobre dinero real. La mitad de estos tests son sobre eso.
"""

from __future__ import annotations

from datetime import date, timedelta

from app.analysis.rule_backtest import (
    COMISION_PCT,
    DIVISA_PCT,
    _racha_perdedora,
    costes_por_lado,
    rebalance_dates_mensuales,
    run_rule_backtest,
    simular_operacion,
)


def serie_desde(precios: list[float], inicio=date(2020, 1, 1)):
    return [(inicio + timedelta(days=i), p) for i, p in enumerate(precios)]


# --- Que no haga trampa ------------------------------------------------------


def test_se_entra_al_cierre_siguiente_no_al_de_la_senal():
    """Comprar al precio del día de la señal es comprar con información que
    todavía no tenías. Es el error que hace brillar a los backtests caseros."""
    serie = serie_desde([100, 110, 120, 130])
    op = simular_operacion(serie, señal_en=serie[0][0], stop_pct=50, objetivo_pct=100, coste_lado=0)
    assert op["entrada"] == 110.0  # el cierre del día siguiente, no 100
    assert op["entrada_fecha"] == serie[1][0].isoformat()


def test_sin_futuro_no_hay_operacion():
    """Una señal en la última barra no se puede evaluar; inventarla sería
    rellenar el resultado con nada."""
    serie = serie_desde([100, 110])
    assert simular_operacion(serie, serie[-1][0], 10, 20, 0) is None


def test_el_coste_se_paga_dos_veces_y_reduce_el_resultado():
    serie = serie_desde([100, 100, 110])
    sin = simular_operacion(serie, serie[0][0], 50, 5, coste_lado=0)
    con = simular_operacion(serie, serie[0][0], 50, 5, coste_lado=1.5)
    assert sin["neto_pct"] == sin["bruto_pct"]
    assert abs((sin["neto_pct"] - con["neto_pct"]) - 3.0) < 1e-9


def test_los_costes_por_defecto_incluyen_la_divisa():
    """Comprar en EE. UU. desde Canadá: la conversión pesa más que la comisión."""
    assert costes_por_lado(con_divisa=True) > costes_por_lado(con_divisa=False)
    assert costes_por_lado(True) - costes_por_lado(False) == DIVISA_PCT
    assert costes_por_lado(False) > COMISION_PCT  # incluye deslizamiento


# --- Que las salidas funcionen ----------------------------------------------


def test_sale_por_stop_cuando_el_precio_lo_perfora():
    serie = serie_desde([100, 100, 95, 85, 120])
    op = simular_operacion(serie, serie[0][0], stop_pct=10, objetivo_pct=20, coste_lado=0)
    assert op["motivo"] == "stop"
    assert op["salida"] == 85.0
    assert op["ganadora"] is False


def test_sale_por_objetivo_cuando_lo_alcanza():
    serie = serie_desde([100, 100, 105, 125, 60])
    op = simular_operacion(serie, serie[0][0], stop_pct=10, objetivo_pct=20, coste_lado=0)
    assert op["motivo"] == "objetivo"
    assert op["salida"] == 125.0
    assert op["ganadora"] is True


def test_sale_por_plazo_si_no_pasa_nada():
    serie = serie_desde([100] * 10)
    op = simular_operacion(
        serie, serie[0][0], stop_pct=20, objetivo_pct=40, coste_lado=0, max_sesiones=5
    )
    assert op["motivo"] == "plazo"


def test_ante_la_duda_dentro_de_una_sesion_se_asume_lo_malo():
    """Un cierre que perfora el stop se cuenta como stop aunque ese mismo día
    también superara el objetivo: con datos diarios no se sabe qué se tocó
    primero, y suponer lo favorable es como se fabrica un backtest mentiroso."""
    serie = serie_desde([100, 100, 80])
    op = simular_operacion(serie, serie[0][0], stop_pct=10, objetivo_pct=20, coste_lado=0)
    assert op["motivo"] == "stop"


def test_la_salida_usa_el_cierre_real_no_el_precio_del_stop():
    """Si abre con hueco a la baja no te llenan en tu stop. Asumir que sí
    maquilla justo las peores operaciones."""
    serie = serie_desde([100, 100, 70])
    op = simular_operacion(serie, serie[0][0], stop_pct=10, objetivo_pct=20, coste_lado=0)
    assert op["salida"] == 70.0  # no 90.0
    assert op["neto_pct"] < -25


# --- Resumen y honestidad ----------------------------------------------------


def _universo_sintetico(n=12, sube=True):
    """Empresas con fundamentales publicados y una tendencia clara.

    La dispersión importa: con fundamentales casi idénticos ningún z-score
    llega al umbral y el backtest no abriría ni una operación, que es un
    artefacto del fixture y no del sistema.
    """
    universo = {}
    for i in range(n):
        bueno = i < n // 3  # un tercio claramente mejor que el resto
        precios = [50 + (i * 2) + (t * (0.35 if sube else -0.15)) for t in range(700)]
        universo[f"S{i}"] = {
            "periods": [
                {
                    "end_date": "2019-12-31",
                    "eps_diluted": 18.0 if bueno else 1.5 + i * 0.1,
                    "equity": 400 if bueno else 1800 + i * 40,
                    "revenue": 5000,
                    "net_income": 900 if bueno else 90 + i * 5,
                    "operating_income": 1400 if bueno else 150,
                    "interest_expense": 8 if bueno else 60,
                    "shares_outstanding": 100,
                }
            ],
            "filings": [{"type": "10-K", "filed_at": "2020-02-20"}],
            "bars": [
                {"ts": (date(2020, 1, 1) + timedelta(days=t)).isoformat(), "close": p}
                for t, p in enumerate(precios)
            ],
        }
    return universo


def test_el_resumen_trae_lo_que_hace_falta_para_decidir():
    fechas = rebalance_dates_mensuales(date(2021, 3, 1), date(2021, 8, 1))
    r = run_rule_backtest(_universo_sintetico(), fechas)
    assert r["n_operaciones"] > 0
    for campo in (
        "tasa_acierto",
        "esperanza_pct",
        "factor_beneficio",
        "racha_perdedora",
        "referencia_pct",
        "ventaja_pct",
        "coste_total_por_operacion_pct",
        "salidas",
    ):
        assert campo in r, campo


def test_siempre_se_compara_contra_comprar_a_ciegas():
    """Un 55 % de aciertos no significa nada si comprar cualquier cosa daba 60 %."""
    fechas = rebalance_dates_mensuales(date(2021, 3, 1), date(2021, 8, 1))
    r = run_rule_backtest(_universo_sintetico(), fechas)
    assert r["referencia_pct"] is not None
    # La ventaja se calcula sin redondear y luego se redondea, que es más
    # preciso que restar dos cifras ya redondeadas: se compara con holgura.
    assert abs(r["ventaja_pct"] - (r["esperanza_pct"] - r["referencia_pct"])) < 0.01


def test_menos_de_30_operaciones_no_se_declara_fiable():
    """El mismo listón que el resto de la app usa para publicar probabilidades."""
    fechas = rebalance_dates_mensuales(date(2021, 3, 1), date(2021, 4, 1))
    r = run_rule_backtest(_universo_sintetico(n=4), fechas)
    if r["n_operaciones"] < 30:
        assert r["fiable"] is False


def test_el_sesgo_de_supervivencia_se_declara_siempre():
    """Está presente y no tiene arreglo gratis: callarlo sería lo grave."""
    fechas = rebalance_dates_mensuales(date(2021, 3, 1), date(2021, 5, 1))
    for universo in (_universo_sintetico(), {}):
        r = run_rule_backtest(universo, fechas)
        assert "supervivencia" in r["sesgo_supervivencia"].lower()
        assert "inflados" in r["sesgo_supervivencia"]


def test_sin_operaciones_lo_dice_en_vez_de_fingir_resultados():
    r = run_rule_backtest({}, rebalance_dates_mensuales(date(2021, 1, 1), date(2021, 3, 1)))
    assert r["n_operaciones"] == 0
    assert r["fiable"] is False
    assert r["operaciones"] == []


def test_el_filtro_de_tendencia_se_puede_apagar_para_medirlo():
    """Mantener una regla sin poder comprobar si aporta es un acto de fe."""
    fechas = rebalance_dates_mensuales(date(2021, 3, 1), date(2021, 8, 1))
    universo = _universo_sintetico(sube=False)  # todo en tendencia bajista
    con = run_rule_backtest(universo, fechas, exigir_tendencia=True)
    sin = run_rule_backtest(universo, fechas, exigir_tendencia=False)
    # Con todo cayendo, el filtro debe bloquear entradas que sin él se abren.
    assert con["n_operaciones"] < sin["n_operaciones"]
    assert con["filtro_tendencia"] is True and sin["filtro_tendencia"] is False


def test_la_racha_perdedora_se_cuenta_en_orden_cronologico():
    ops = [
        {"entrada_fecha": "2021-01-01", "ganadora": False},
        {"entrada_fecha": "2021-03-01", "ganadora": False},
        {"entrada_fecha": "2021-02-01", "ganadora": False},
        {"entrada_fecha": "2021-04-01", "ganadora": True},
        {"entrada_fecha": "2021-05-01", "ganadora": False},
    ]
    assert _racha_perdedora(ops) == 3


# --- El endpoint y su conexión con la lista diaria ---------------------------


def test_el_endpoint_valida_reglas_y_lo_deja_guardado(session_factory, monkeypatch):
    """Tras ejecutarlo, la lista diaria debe poder decir si el sistema está
    probado. Si el resultado no se guarda, cada decisión vuelve a nacer sin
    respaldo y el backtest no habría servido para nada."""
    from fastapi.testclient import TestClient
    from sqlalchemy import select

    from app.db.engine import get_session
    from app.db.models import LlmOutput
    from app.deps import get_llm, get_service
    from app.main import app
    from app.routers import signals as S

    universo = _universo_sintetico(n=9)

    def fake_get(service, data_type, **kwargs):
        symbol = kwargs.get("symbol")
        if symbol not in universo:
            return None
        if data_type == "financials":
            return {"periods": universo[symbol]["periods"]}
        if data_type == "filings":
            return {"filings": universo[symbol]["filings"]}
        if data_type == "price_history":
            return {"bars": universo[symbol]["bars"]}
        return None

    monkeypatch.setattr(S, "_safe_get", fake_get)

    def override_session():
        session = session_factory()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_service] = lambda: object()
    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_llm] = lambda: None
    try:
        with TestClient(app) as c:
            resp = c.post(
                "/api/signals/rule-backtest",
                json={"symbols": list(universo), "years": 3},
            )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert "sesgo_supervivencia" in data and "veredicto" in data
        # El coste por defecto incluye la divisa: no se desactiva por olvido.
        assert data["coste_por_lado_pct"] > COMISION_PCT
        # Y siempre se mide contra no hacer nada.
        assert "comparativa_sin_filtro_tendencia" in data

        if data["n_operaciones"] > 0:
            with session_factory() as session:
                guardado = session.execute(
                    select(LlmOutput).where(LlmOutput.kind == "rule_backtest")
                ).scalars().first()
            assert guardado is not None, "sin guardar, la lista diaria no puede usarlo"
    finally:
        app.dependency_overrides.clear()
