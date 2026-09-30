"""La valoración no puede inventar deuda ni crecimiento.

De la auditoría de RC1. Dos líneas de `routers/valuation.py` y sus gemelas en
`routers/deep_dive.py` convertían la ausencia en el supuesto más favorable:

    "net_debt": (deuda - cash) if deuda is not None else 0.0
    historico = crec.get("fcf_cagr") or crec.get("revenue_cagr") or 0.03

La primera vale un 95 % de valoración. En `analysis/valuation.py` el equity es
`enterprise_value − net_debt`, así que una empresa sobre la que no sabemos la
deuda se valora **como si no tuviera ninguna** — el supuesto más optimista
posible, aplicado justo cuando menos se sabe.

La segunda tiene dos fallos en una línea: convierte un crecimiento ausente en
un 3 % que nunca se declara como supuesto, y convierte un crecimiento real de
`0.0` en ese mismo 3 %, porque `0.0` es *falsy*. Una empresa que no crece se
valora como si creciera.
"""

from __future__ import annotations

import pytest

from app.analysis.valuation import dcf
from app.routers.valuation import _escenarios_por_defecto, CRECIMIENTO_MAXIMO

BASE = dict(
    base_fcf=1_000_000_000,
    growth_rate=0.05,
    discount_rate=0.10,
    terminal_growth=0.025,
    years=10,
    shares_outstanding=100_000_000,
)


# --- P0-6: la deuda desconocida no es deuda cero -------------------------


def test_la_deuda_desconocida_vale_un_95_por_ciento_de_valoracion():
    """El número que motivó el hallazgo, congelado como test."""
    con = dcf(net_debt=8_000_000_000, **BASE)["value_per_share"]
    sin = dcf(net_debt=0.0, **BASE)["value_per_share"]
    assert sin > con * 1.9, "tratar la deuda como cero tiene que notarse mucho"


def test_un_dcf_sin_deuda_conocida_no_devuelve_un_valor_por_accion():
    """La respuesta correcta es «no se puede valorar», no un número optimista."""
    r = dcf(net_debt=None, **BASE)
    assert r["value_per_share"] is None
    assert r.get("indeterminado") is True
    assert "deuda" in " ".join(r.get("faltan", [])).lower() or "deuda" in (
        r.get("motivo") or ""
    ).lower()


def test_una_deuda_de_cero_si_es_un_dato():
    """Una empresa sin deuda existe. Cero conocido ≠ desconocido."""
    r = dcf(net_debt=0.0, **BASE)
    assert r["value_per_share"] is not None
    assert not r.get("indeterminado")


def test_una_deuda_nan_se_trata_como_desconocida():
    r = dcf(net_debt=float("nan"), **BASE)
    assert r["value_per_share"] is None


def test_caja_neta_negativa_es_legitima():
    """Más caja que deuda: net_debt negativo sube el valor, y es correcto."""
    r = dcf(net_debt=-2_000_000_000, **BASE)
    base = dcf(net_debt=0.0, **BASE)["value_per_share"]
    assert r["value_per_share"] > base


def test_sin_acciones_en_circulacion_no_hay_valor_por_accion():
    r = dcf(**{**BASE, "shares_outstanding": None}, net_debt=0.0)
    assert r["value_per_share"] is None


# --- P0-7: el crecimiento ausente no es un 3 % ---------------------------


def test_un_crecimiento_real_de_cero_no_se_convierte_en_el_supuesto():
    """`or` encadenado: `0.0` es falsy y caía al 3 % por defecto.

    Una empresa que no crece no puede valorarse como si creciera.
    """
    esc = _escenarios_por_defecto({"fcf_cagr": 0.0, "revenue_cagr": 0.0})
    assert esc["base"]["growth_rate"] == 0.0
    assert esc["base"]["supuesto"] is False


def test_sin_crecimiento_conocido_el_supuesto_se_declara():
    esc = _escenarios_por_defecto({})
    assert esc["base"]["supuesto"] is True
    assert esc["base"]["motivo"]
    assert "supuesto" in esc["base"]["motivo"].lower()


def test_con_crecimiento_conocido_no_hay_supuesto():
    esc = _escenarios_por_defecto({"fcf_cagr": 0.08})
    assert esc["base"]["supuesto"] is False
    assert esc["base"]["motivo"] is None


def test_un_crecimiento_nan_no_pasa_por_dato():
    esc = _escenarios_por_defecto({"fcf_cagr": float("nan")})
    assert esc["base"]["supuesto"] is True


def test_el_tope_de_crecimiento_sigue_aplicandose():
    """Extrapolar el mejor quinquenio a perpetuidad es el error caro del DCF."""
    esc = _escenarios_por_defecto({"fcf_cagr": 0.80})
    assert esc["alcista"]["growth_rate"] <= CRECIMIENTO_MAXIMO


def test_un_crecimiento_negativo_no_se_convierte_en_positivo():
    """Una empresa en contracción es un dato, no un error que corregir."""
    esc = _escenarios_por_defecto({"fcf_cagr": -0.05})
    assert esc["base"]["growth_rate"] <= 0.0
    assert esc["base"]["supuesto"] is False


# --- A nivel de ENDPOINT: que la corrección llegue de verdad -------------
#
# La primera versión de la corrección de P0-6 protegía `dcf()` cuando recibe
# `None`... pero el router le seguía pasando `0.0`, así que `dcf()` nunca veía
# el `None`. Los tests de arriba pasaban y el fallo seguía vivo en la ruta
# principal: la misma familia de «la regla existe pero no se ejecuta». Estos
# tests atraviesan el endpoint entero para que eso no pueda repetirse.

from fastapi.testclient import TestClient  # noqa: E402

from app.db.engine import get_session  # noqa: E402
from app.deps import get_service  # noqa: E402
from app.main import app  # noqa: E402
from tests.test_valuation_api import FakeService, _periodos  # noqa: E402


class ServicioConHuecos(FakeService):
    def __init__(self, quitar: tuple[str, ...]):
        super().__init__()
        self.quitar = quitar

    def get(self, data_type, **kw):
        r = super().get(data_type, **kw)
        if data_type == "financials":
            r["periods"] = [
                {k: (None if k in self.quitar else v) for k, v in p.items()}
                for p in _periodos()
            ]
        return r


@pytest.fixture
def valorar(session_factory):
    def _hacer(quitar=(), body=None):
        service = ServicioConHuecos(quitar)

        def override_session():
            s = session_factory()
            try:
                yield s
            finally:
                s.close()

        app.dependency_overrides[get_service] = lambda: service
        app.dependency_overrides[get_session] = override_session
        return TestClient(app).post("/api/valuation/AAPL", json=body)

    yield _hacer
    app.dependency_overrides.clear()


def test_endpoint_sin_deuda_conocida_no_valora_por_accion(valorar):
    r = valorar(quitar=("long_term_debt", "short_term_debt"))
    assert r.status_code == 422, r.text
    assert "deuda" in r.json()["detail"].lower()
    assert "net_debt" in r.json()["detail"]  # y dice cómo arreglarlo


def test_endpoint_sin_deuda_pero_con_la_tuya_si_valora(valorar):
    """Si el usuario aporta la deuda, es su dato y se usa."""
    r = valorar(quitar=("long_term_debt", "short_term_debt"), body={"net_debt": 1.5e9})
    assert r.status_code == 200, r.text


def test_endpoint_sin_capex_no_toma_el_flujo_operativo_entero_como_libre(valorar):
    """capex ausente = FCF desconocido, no FCF = flujo operativo entero."""
    r = valorar(quitar=("capex",))
    assert r.status_code == 422, r.text
    assert "capex" in r.json()["detail"].lower()


def test_endpoint_sin_acciones_no_mezcla_valor_total_con_valor_por_accion(valorar):
    """Antes, sin acciones, el «rango» se rellenaba con el equity TOTAL."""
    r = valorar(quitar=("shares_outstanding",))
    assert r.status_code == 422, r.text
    assert "acciones" in r.json()["detail"].lower()


def test_endpoint_con_todo_sigue_funcionando(valorar):
    r = valorar()
    assert r.status_code == 200, r.text
    assert r.json()["escenarios"]["base"]["rango"]["disponible"] is True


def test_rango_de_valor_no_mezcla_unidades():
    from app.analysis.valuation import rango_de_valor

    r = rango_de_valor(1e9, 0.05, 0.10, 0.025, 5, net_debt=0.0, shares_outstanding=None)
    assert r["disponible"] is False
    assert "acciones" in r["nota"].lower()


def test_los_escenarios_sin_deuda_explican_por_que_no_hay_valor():
    from app.analysis.valuation import scenario_set

    r = scenario_set(
        {"base": {"growth_rate": 0.05, "discount_rate": 0.10, "terminal_growth": 0.025}},
        base_fcf=1e9, years=5, net_debt=None, shares_outstanding=1e8,
    )
    assert r["base"]["value_per_share"] is None
    assert r["base"]["indeterminado"] is True
    assert "deuda neta" in r["base"]["faltan"]
