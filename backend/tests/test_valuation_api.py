"""El endpoint de valoración, y la regla que lo gobierna.

«Nunca un precio objetivo único» se fija aquí de la forma más dura posible:
recorriendo la respuesta ENTERA y comprobando que no existe ningún campo escalar
que contenga un precio. Una regla que solo vive en el docstring dura hasta el
siguiente que añada un campo con buena intención.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.db.engine import get_session
from app.deps import get_service
from app.main import app
from app.providers.base import DataNotFoundError, iso_utc

PRECIO = 140.0
ACCIONES = 100e6


def _periodos(n: int = 8) -> list[dict]:
    salida = []
    for i in range(n):
        e = 1.0 + i * 0.06  # ~6 % de crecimiento anual
        salida.append(
            {
                "fiscal_year": 2018 + i,
                "end_date": f"{2018 + i}-12-31",
                "revenue": 5000e6 * e,
                "operating_income": 1200e6 * e,
                "net_income": 800e6 * e,
                "eps_diluted": 8.0 * e,
                "equity": 4000e6,
                "total_assets": 9000e6,
                "current_assets": 3000e6,
                "current_liabilities": 1500e6,
                "long_term_debt": 2000e6,
                "short_term_debt": 500e6,
                "cash": 1000e6,
                "interest_expense": 100e6,
                "cfo": 1400e6 * e,
                "capex": 400e6,
                "shares_outstanding": ACCIONES,
            }
        )
    return salida


class FakeService:
    def __init__(self, con_pares=True, precio=PRECIO):
        self.con_pares = con_pares
        self.precio = precio
        self.llamadas: dict[str, int] = {}

    def get(self, data_type, **kwargs):
        self.llamadas[data_type] = self.llamadas.get(data_type, 0) + 1
        common = {"source": "fake", "as_of": iso_utc(), "cached": False}
        if data_type == "financials":
            return {**common, "symbol": kwargs["symbol"], "periods": _periodos()}
        if data_type == "quote":
            return {**common, "symbol": kwargs["symbol"], "price": self.precio}
        if data_type == "peers":
            if not self.con_pares:
                raise DataNotFoundError("sin pares")
            return {**common, "symbol": kwargs["symbol"],
                    "peers": ["PA", "PB", "PC", "PD", "PE", "PF"]}
        if data_type == "fundamentals":
            # Crecimiento y calidad varían de forma INDEPENDIENTE entre pares:
            # si fueran de la mano el ajuste se negaría por colinealidad y el
            # test acabaría probando el guardián en vez de la regresión.
            # Los múltiplos llevan ruido a propósito. Construirlos exactos con
            # la fórmula del ajuste daría R² = 1,00 y un intervalo de predicción
            # de cuatro décimas: el test pasaría y estaría mintiendo sobre lo que
            # el módulo produce con datos de verdad.
            combos = {
                "AAPL": (0.14, 0.26, 17.5), "PA": (0.03, 0.28, 16.1),
                "PB": (0.16, 0.10, 23.0), "PC": (0.06, 0.22, 16.2),
                "PD": (0.19, 0.31, 29.4), "PE": (0.02, 0.09, 11.6),
                "PF": (0.11, 0.18, 19.4),
            }
            g, q, pe = combos.get(kwargs["symbol"], (0.05, 0.15, 15.0))
            return {**common, "symbol": kwargs["symbol"],
                    "metrics": {"pe_ttm": pe, "revenue_growth_5y": g, "roe": q}}
        raise AssertionError(f"tipo inesperado: {data_type}")


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


def _valorar(c, **body):
    r = c.post("/api/valuation/AAPL", json=body or None)
    assert r.status_code == 200, r.text
    return r.json()


# --- La regla: nunca un precio objetivo único --------------------------------


PROHIBIDOS = {
    "precio_objetivo", "target_price", "valor_justo", "fair_value",
    "precio_justo", "valoracion_final", "valor_objetivo",
}


def _recorrer(nodo, ruta=""):
    if isinstance(nodo, dict):
        for k, v in nodo.items():
            yield f"{ruta}.{k}", k, v
            yield from _recorrer(v, f"{ruta}.{k}")
    elif isinstance(nodo, list):
        for i, v in enumerate(nodo):
            yield from _recorrer(v, f"{ruta}[{i}]")


def test_no_existe_ningun_campo_de_precio_objetivo_en_toda_la_respuesta(client):
    """La comprobación dura: no es que no se enseñe, es que no existe."""
    c, _ = client()
    encontrados = [
        ruta for ruta, clave, _ in _recorrer(_valorar(c)) if clave in PROHIBIDOS
    ]
    assert encontrados == [], encontrados


def test_cada_escenario_trae_un_rango_no_un_valor(client):
    c, _ = client()
    escenarios = _valorar(c)["escenarios"]
    assert set(escenarios) == {"bajista", "base", "alcista"}
    for nombre, e in escenarios.items():
        rango = e["rango"]
        assert rango["disponible"] is True, nombre
        assert rango["bajo"] < rango["centro"] < rango["alto"], nombre
        # Un `value_per_share` suelto sería exactamente el precio objetivo único.
        assert "value_per_share" not in rango


def test_el_rango_global_va_del_suelo_bajista_al_techo_alcista(client):
    c, _ = client()
    d = _valorar(c)
    g, esc = d["rango_global"], d["escenarios"]
    assert g["bajo"] == min(e["rango"]["bajo"] for e in esc.values())
    assert g["alto"] == max(e["rango"]["alto"] for e in esc.values())
    assert g["posicion"] in ("dentro", "por encima", "por debajo")


def test_el_disclaimer_dice_que_no_existe_el_campo_no_solo_que_no_se_enseña(client):
    c, _ = client()
    d = _valorar(c)["disclaimer"]
    assert "no existe en el código un campo donde quepa uno" in d


# --- Supuestos visibles y editables ------------------------------------------


def test_los_supuestos_de_partida_salen_del_historico_real_y_viajan_visibles(client):
    c, _ = client()
    d = _valorar(c)
    for nombre, e in d["escenarios"].items():
        assert set(e["supuestos"]) == {"growth_rate", "discount_rate", "terminal_growth"}
    # Bajista crece menos que base, y base menos que alcista.
    g = {k: v["supuestos"]["growth_rate"] for k, v in d["escenarios"].items()}
    assert g["bajista"] < g["base"] < g["alcista"]
    assert d["entradas"]["crecimiento_historico"]["revenue_cagr"] is not None


def test_el_crecimiento_de_partida_se_acota_para_no_extrapolar_el_mejor_quinquenio(client):
    from app.routers.valuation import CRECIMIENTO_MAXIMO

    c, _ = client()
    d = _valorar(c)
    for e in d["escenarios"].values():
        assert e["supuestos"]["growth_rate"] <= CRECIMIENTO_MAXIMO


def test_los_supuestos_del_usuario_mandan_sobre_los_propuestos(client):
    c, _ = client()
    mios = {
        "bajista": {"growth_rate": 0.01, "discount_rate": 0.12, "terminal_growth": 0.01},
        "base": {"growth_rate": 0.05, "discount_rate": 0.10, "terminal_growth": 0.02},
        "alcista": {"growth_rate": 0.09, "discount_rate": 0.08, "terminal_growth": 0.025},
    }
    d = _valorar(c, escenarios=mios)
    assert d["escenarios"]["base"]["supuestos"] == mios["base"]


def test_un_supuesto_que_hace_infinito_el_terminal_se_explica_sin_reventar(client):
    """Descuento por debajo del crecimiento a perpetuidad: no es un fallo de
    cálculo, es un supuesto que dice que la empresa crece más que el coste del
    dinero para siempre."""
    c, _ = client()
    d = _valorar(c, escenarios={
        "base": {"growth_rate": 0.05, "discount_rate": 0.02, "terminal_growth": 0.03}
    })
    rango = d["escenarios"]["base"]["rango"]
    assert rango["disponible"] is False
    assert "para siempre" in rango["nota"]


# --- DCF inverso --------------------------------------------------------------


def test_el_dcf_inverso_devuelve_una_curva_sobre_el_wacc(client):
    c, _ = client()
    inv = _valorar(c)["dcf_inverso"]
    assert inv["disponible"] is True
    puntos = inv["curva"]["puntos"]
    assert len(puntos) >= 5
    assert all("discount_rate" in p for p in puntos)
    assert inv["curva"]["rango"]["bajo"] < inv["curva"]["rango"]["alto"]


def test_el_inverso_contrasta_lo_implicito_con_el_historico_de_la_empresa(client):
    c, _ = client()
    contraste = _valorar(c)["dcf_inverso"]["contraste"]
    assert contraste["disponible"] is True
    assert contraste["mejor_historico"] is not None
    assert "rango_implicito" in contraste


def test_el_margen_implicito_dice_de_donde_tendria_que_salir(client):
    c, _ = client(precio=PRECIO * 2)
    m = _valorar(c)["dcf_inverso"]["margen"]
    assert m["disponible"] is True
    assert m["margen_implicito"] > m["margen_actual"]
    assert "Pregúntate de dónde saldría" in m["nota"]


def test_el_resumen_del_inverso_dice_que_no_juzga_si_esta_cara(client):
    c, _ = client()
    r = _valorar(c)["dcf_inverso"]["resumen"]
    assert "no dice si está cara o barata" in r
    assert "Esa parte la decides tú" in r


# --- Sensibilidad -------------------------------------------------------------


def test_la_sensibilidad_dice_que_supuesto_manda(client):
    c, _ = client()
    s = _valorar(c)["sensibilidad"]
    assert s["disponible"] is True
    assert s["dominante"] in {"growth_rate", "discount_rate", "terminal_growth", "base_fcf"}
    recorridos = [f["recorrido_pct"] for f in s["supuestos"]]
    assert recorridos == sorted(recorridos, reverse=True)


# --- Comparables --------------------------------------------------------------


def test_los_comparables_se_ajustan_por_crecimiento_y_calidad(client):
    c, _ = client()
    comp = _valorar(c)["comparables"]
    assert comp["disponible"] is True
    assert comp["pares_usables"] == 6
    assert comp["intervalo"]["bajo"] < comp["intervalo"]["alto"]
    assert comp["r2"] is not None
    # Con 3 grados de libertad el intervalo tiene que ser ANCHO. Uno estrecho
    # sería la señal de que algo finge una precisión que la muestra no da.
    ancho = comp["intervalo"]["alto"] - comp["intervalo"]["bajo"]
    assert ancho > 2.0, f"intervalo sospechosamente estrecho: {ancho}"


def test_el_precio_implicito_de_comparables_es_un_rango(client):
    c, _ = client()
    comp = _valorar(c)["comparables"]
    if comp.get("fiable"):
        p = comp["precio_implicito"]
        assert p["precio_bajo"] < p["precio_alto"]
        assert "no un precio objetivo" in p["nota"]


def test_sin_pares_se_dice_en_vez_de_omitir_la_seccion(client):
    c, _ = client(con_pares=False)
    comp = _valorar(c)["comparables"]
    assert comp["disponible"] is False
    assert "Sin lista de comparables" in comp["nota"]


# --- Coste y errores ----------------------------------------------------------


def test_el_dcf_y_el_inverso_no_gastan_ninguna_llamada_extra(client):
    """Aritmética local: solo se descargan los estados, el precio y los pares."""
    c, service = client()
    _valorar(c)
    assert service.llamadas.get("financials") == 1
    assert service.llamadas.get("quote") == 1
    assert service.llamadas.get("fundamentals", 0) <= 7  # objetivo + 6 pares


def test_una_empresa_sin_estados_en_la_sec_da_404(client):
    c, service = client()
    service.get = lambda data_type, **kw: (_ for _ in ()).throw(DataNotFoundError("no"))
    r = c.post("/api/valuation/AAPL", json={})
    assert r.status_code == 404
    assert "no presentan 10-K" in r.json()["detail"]


def test_un_simbolo_invalido_se_rechaza(client):
    c, _ = client()
    assert c.post("/api/valuation/@@@", json={}).status_code == 422


def test_el_precio_implicito_no_se_contradice_con_el_multiplo(client):
    """El bug que salió al mirar la pantalla: el P/E caía FUERA del intervalo y
    el precio implícito, DENTRO, en el mismo panel.

    Pasaba por mezclar espacios de múltiplos — los P/E de los pares vienen del
    proveedor de fundamentales (TTM, ajustado) y el BPA venía de EDGAR (anual,
    GAAP). Cada número era correcto y juntos no querían decir nada.
    """
    c, _ = client()
    comp = _valorar(c)["comparables"]
    if not (comp.get("fiable") and comp.get("precio_implicito", {}).get("disponible")):
        pytest.skip("el ajuste no salió fiable en esta muestra")

    dentro_por_multiplo = comp["dentro_del_intervalo"]
    dentro_por_precio = comp["precio_implicito"]["posicion"] == "dentro"
    assert dentro_por_multiplo == dentro_por_precio, (
        f"múltiplo dice {'dentro' if dentro_por_multiplo else 'fuera'} y precio "
        f"dice {comp['precio_implicito']['posicion']}"
    )
