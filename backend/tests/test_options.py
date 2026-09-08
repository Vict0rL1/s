"""Señales de opciones: lo que se calcula y, sobre todo, lo que se NIEGA a calcular.

La mitad de estos tests fijan negativas. Con datos de opciones gratuitos la
tentación permanente es producir un número igualmente —un «skew» sacado de los
tres strikes que había, una «media» de una sola lectura— y esos números son
peores que un hueco, porque parecen señal.
"""

from __future__ import annotations

import math
from datetime import date, timedelta

import pytest

from app.analysis import options as op

HOY = date(2024, 6, 3)
V14, V45, V120 = HOY + timedelta(days=14), HOY + timedelta(days=45), HOY + timedelta(days=120)


def _bs(spot, strike, iv, años, r=0.04, tipo="call"):
    """Precio Black-Scholes, para fabricar cadenas coherentes con su IV."""
    if años <= 0 or iv <= 0:
        return max(0.0, (spot - strike) if tipo == "call" else (strike - spot))
    d1 = (math.log(spot / strike) + (r + iv * iv / 2) * años) / (iv * math.sqrt(años))
    d2 = d1 - iv * math.sqrt(años)
    n = op._norm_cdf
    if tipo == "call":
        return spot * n(d1) - strike * math.exp(-r * años) * n(d2)
    return strike * math.exp(-r * años) * n(-d2) - spot * n(-d1)


def _cadena(spot, ivs, skew=0.25, strikes_pct=None, volumen=200, oi=1000):
    """Cadena con sonrisa lineal: la IV sube cuanto más OTM está la put."""
    strikes_pct = strikes_pct or [0.7, 0.8, 0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.15, 1.2, 1.3]
    out: dict[date, list[dict]] = {}
    for venc, iv_atm in ivs.items():
        años = (venc - HOY).days / 365
        lista = []
        for p in strikes_pct:
            k = round(spot * p, 2)
            iv = max(0.05, iv_atm + skew * (1.0 - p))
            for tipo in ("call", "put"):
                precio = _bs(spot, k, iv, años, tipo=tipo)
                if precio < 0.02:
                    continue
                lista.append(
                    {
                        "tipo": tipo,
                        "strike": k,
                        "vencimiento": venc,
                        "iv": iv,
                        "bid": round(precio * 0.98, 2),
                        "ask": round(precio * 1.02, 2),
                        "volumen": volumen,
                        "oi": oi,
                        "ultimo_cruce": HOY,
                    }
                )
        out[venc] = lista
    return out


def _limpia(cadena):
    limpios, _ = op.limpiar([c for l in cadena.values() for c in l], HOY)
    por_v: dict[date, list[dict]] = {}
    for c in limpios:
        por_v.setdefault(c["vencimiento"], []).append(c)
    return por_v


def _precios(dias=400, vol_diaria=0.0126, semilla=4):
    import random

    rng = random.Random(semilla)
    salida, p, d = [], 100.0, HOY - timedelta(days=int(dias * 1.45))
    while len(salida) < dias:
        if d.weekday() < 5:
            p *= math.exp(rng.gauss(0.0003, vol_diaria))
            salida.append((d, p))
        d += timedelta(days=1)
    return salida


# --- Limpieza: filtrar es tirar datos, y hay que decir cuántos ----------------


def test_la_basura_se_filtra_y_se_dice_por_que():
    sucios = [
        {"tipo": "call", "strike": 100, "vencimiento": V45, "iv": 0.30, "bid": 5.0, "ask": 5.2,
         "ultimo_cruce": HOY},
        {"tipo": "call", "strike": 105, "vencimiento": V45, "iv": 4.5, "bid": 1.0, "ask": 1.1,
         "ultimo_cruce": HOY},                                            # IV imposible
        {"tipo": "put", "strike": 50, "vencimiento": V45, "iv": 0.4, "bid": 0.05, "ask": 0.95,
         "ultimo_cruce": HOY},                                            # horquilla 90 %
        {"tipo": "put", "strike": 95, "vencimiento": V45, "iv": 0.35, "bid": 2.0, "ask": 2.1,
         "ultimo_cruce": HOY - timedelta(days=9)},                        # no cruza hace 9 días
        {"tipo": "put", "strike": 90, "vencimiento": V45, "iv": 0.36, "bid": 0, "ask": 0,
         "ultimo_cruce": HOY},                                            # sin precio
    ]
    limpios, calidad = op.limpiar(sucios, HOY)
    assert len(limpios) == 1
    assert calidad["descartados"] == 4
    assert set(calidad["motivos"]) == {"iv_absurda", "horquilla", "sin_cruce_reciente", "sin_precio"}
    assert "300 %" in calidad["nota"]


def test_una_cadena_ilíquida_no_produce_señales():
    """Cuatro strikes no son una curva, y calcular igual sería inventar."""
    fina = _cadena(100.0, {V45: 0.32}, strikes_pct=[0.98, 1.0, 1.02])
    r = op.panel({V45: fina[V45][:4]}, 100.0, _precios(), hoy=HOY)
    assert r["disponible"] is False
    assert "casi no tiene mercado de opciones" in r["nota"]


def test_se_distingue_cadena_fina_de_cadena_filtrada():
    """«Solo 4 de 4» sugiere un filtrado que no ocurrió; son causas distintas."""
    fina = _cadena(100.0, {V45: 0.32}, strikes_pct=[0.98, 1.0])
    r = op.panel(fina, 100.0, _precios(), hoy=HOY)
    assert "casi no tiene mercado" in r["nota"]

    gorda = _cadena(100.0, {V45: 0.32})
    rota = {V45: [{**c, "iv": 9.0} for c in gorda[V45]]}  # toda la cadena, ilegible
    r2 = op.panel(rota, 100.0, _precios(), hoy=HOY)
    assert "pasan el filtro de liquidez" in r2["nota"]


# --- Delta y skew -------------------------------------------------------------


def test_el_delta_se_comporta_como_un_delta():
    a = 30 / 365
    assert op.delta_call(100, 100, 0.30, a, 0.04) == pytest.approx(0.53, abs=0.05)
    assert op.delta_call(100, 50, 0.30, a, 0.04) == pytest.approx(1.0, abs=0.01)
    assert op.delta_call(100, 200, 0.30, a, 0.04) == pytest.approx(0.0, abs=0.01)
    assert op.delta_call(100, 100, 0.30, 0, 0.04) is None


def test_el_skew_de_25_delta_usa_delta_de_verdad():
    """Y no un «10 % por encima y por debajo», que compara cosas distintas
    según lo volátil que sea cada empresa."""
    por_v = _limpia(_cadena(100.0, {V45: 0.32}, skew=0.25))
    lista = por_v[V45]
    r = op.skew_25_delta(
        [c for c in lista if c["tipo"] == "call"],
        [c for c in lista if c["tipo"] == "put"],
        100.0,
        45,
    )
    assert r["disponible"] is True
    assert r["skew"] > 0                       # la sonrisa se construyó así
    assert r["strike_put"] < 100 < r["strike_call"]
    assert r["iv_put_25d"] > r["iv_call_25d"]


def test_sin_strikes_lejanos_el_skew_se_niega_en_vez_de_fingir():
    """Poner nombre técnico al strike que había es peor que no dar el número."""
    por_v = _limpia(_cadena(100.0, {V45: 0.32}, strikes_pct=[0.98, 0.99, 1.0, 1.01, 1.02]))
    lista = por_v[V45]
    r = op.skew_25_delta(
        [c for c in lista if c["tipo"] == "call"],
        [c for c in lista if c["tipo"] == "put"],
        100.0,
        45,
    )
    assert r["disponible"] is False
    assert "no llega al 25 delta" in r["nota"]


def test_el_skew_invertido_se_nombra_como_lo_raro_que_es():
    por_v = _limpia(_cadena(100.0, {V45: 0.32}, skew=-0.25))
    lista = por_v[V45]
    r = op.skew_25_delta(
        [c for c in lista if c["tipo"] == "call"],
        [c for c in lista if c["tipo"] == "put"],
        100.0,
        45,
    )
    assert r["disponible"] is True
    assert r["skew"] < 0
    assert "INVERTIDO" in r["nota"]


# --- Estructura temporal ------------------------------------------------------


def test_contango_y_backwardation_se_distinguen_y_se_explican():
    normal = op.estructura_temporal(
        _limpia(_cadena(100.0, {V14: 0.28, V45: 0.32, V120: 0.38})), 100.0, HOY
    )
    assert normal["forma"] == "contango"
    assert normal["pendiente"] > 0

    susto = op.estructura_temporal(
        _limpia(_cadena(100.0, {V14: 0.60, V45: 0.38, V120: 0.30})), 100.0, HOY
    )
    assert susto["forma"] == "backwardation"
    assert "el susto es ahora" in susto["nota"]


def test_un_solo_vencimiento_no_es_una_estructura():
    r = op.estructura_temporal(_limpia(_cadena(100.0, {V45: 0.32})), 100.0, HOY)
    assert r["disponible"] is False


# --- Interpolación al tenor ---------------------------------------------------


def test_la_iv_se_interpola_en_varianza_y_no_en_volatilidad():
    """En vol da un número parecido y sesgado siempre en la misma dirección."""
    por_v = _limpia(_cadena(100.0, {V14: 0.28, V45: 0.40}))
    r = op.iv_a_tenor(por_v, 100.0, 30, HOY)
    assert r["interpolada"] is True
    assert r["entre"] == [14, 45]

    iv14, iv45 = op.iv_atm(por_v[V14], 100.0), op.iv_atm(por_v[V45], 100.0)
    en_vol = iv14 + (iv45 - iv14) * (30 - 14) / (45 - 14)
    v = (iv14**2 * 14) + ((iv45**2 * 45) - (iv14**2 * 14)) * (30 - 14) / (45 - 14)
    en_var = math.sqrt(v / 30)

    assert r["iv"] == pytest.approx(en_var, abs=0.001)
    assert abs(r["iv"] - en_vol) > 0.002, "las dos formas deben diferir de verdad aquí"


def test_sin_vencimientos_a_ambos_lados_se_dice_que_plazo_describe():
    por_v = _limpia(_cadena(100.0, {V45: 0.32, V120: 0.38}))
    r = op.iv_a_tenor(por_v, 100.0, 30, HOY)
    assert r["interpolada"] is False
    assert r["dias"] == 45
    assert "sin interpolar" in r["nota"]


# --- Prima de riesgo ----------------------------------------------------------


def test_la_prima_declara_siempre_que_compara_futuro_con_pasado():
    r = op.prima_de_riesgo(0.32, 0.20, None)
    assert r["prima"] == pytest.approx(0.12)
    assert "30 días hacia adelante" in r["aviso_sesgo"]


def test_sin_base_no_se_dice_si_la_prima_es_alta():
    """Un 5 % es mucho en una eléctrica y poco en una biotecnológica."""
    r = op.prima_de_riesgo(0.32, 0.20, [0.02, 0.03])
    assert r["percentil"] is None
    assert "Sin base histórica suficiente" in r["nota"]


def test_con_base_la_prima_se_juzga_contra_la_propia_empresa():
    base = [0.01, 0.02, 0.02, 0.03, 0.03, 0.04, 0.04, 0.05, 0.05, 0.06, 0.07, 0.08]
    alta = op.prima_de_riesgo(0.32, 0.20, base)
    assert alta["percentil"] == 100.0
    assert "Prima alta" in alta["nota"]

    baja = op.prima_de_riesgo(0.205, 0.20, base)
    assert baja["percentil"] <= 20
    assert "Prima baja" in baja["nota"]


def test_la_volatilidad_realizada_recupera_la_que_se_metio():
    cierres = [v for _, v in _precios(dias=400, vol_diaria=0.0126)]
    rv = op.volatilidad_realizada(cierres, 30)
    assert rv == pytest.approx(0.20, abs=0.07)   # 0,0126·√252 ≈ 20 %


def test_sin_suficientes_cierres_no_hay_realizada():
    assert op.volatilidad_realizada([100.0, 101.0, 99.0], 30) is None


# --- Movimiento esperado ------------------------------------------------------


def test_el_movimiento_implicito_sale_del_straddle_atm():
    por_v = _limpia(_cadena(100.0, {V14: 0.40}))
    r = op.movimiento_implicito(por_v[V14], 100.0)
    assert r["disponible"] is True
    assert r["strike"] == 100.0
    # ±σ√t para 14 días al 40 % ≈ 7,9 %; el straddle ronda el 80 % de eso.
    assert 4.0 < r["movimiento_pct"] < 9.0
    assert "sobreestima algo el salto" in r["nota"]


def test_el_movimiento_implicito_avisa_de_que_cubre_todo_el_periodo():
    por_v = _limpia(_cadena(100.0, {V45: 0.40}))
    assert "no solo el día de resultados" in op.movimiento_implicito(por_v[V45], 100.0)["nota"]


def test_los_movimientos_historicos_se_miden_alrededor_del_anuncio():
    """Del cierre anterior al anuncio al cierre siguiente."""
    dias = [HOY - timedelta(days=d) for d in range(40, 0, -1) if (HOY - timedelta(days=d)).weekday() < 5]
    cierres = [(d, 100.0) for d in dias]
    salto = dias[10]
    cierres = [(d, 100.0 if d < salto else 110.0) for d in dias]

    r = op.movimientos_historicos(cierres, [salto])
    assert r["disponible"] is True
    assert r["movimientos"][0]["movimiento_pct"] == pytest.approx(10.0, abs=0.01)


def test_una_fecha_de_resultados_fuera_del_historico_no_inventa_un_movimiento():
    cierres = _precios(dias=60)
    r = op.movimientos_historicos(cierres, [date(2005, 1, 3)])
    assert r["disponible"] is False
    assert "Ninguna fecha de resultados" in r["nota"]


def test_la_comparacion_no_emite_recomendacion():
    """Que el implícito supere a la mediana es lo habitual, no una señal de venta."""
    implicito = {"disponible": True, "movimiento_pct": 8.0}
    historico = {
        "disponible": True,
        "n": 4,
        "mediana_abs_pct": 3.0,
        "movimientos": [{"movimiento_pct": v} for v in (2.0, -3.0, 3.5, -9.0)],
    }
    r = op.comparar_movimiento(implicito, historico)
    assert r["razon"] == pytest.approx(2.67, abs=0.01)
    assert r["veces_superado"] == 1
    assert "NO es una recomendación" in r["nota"]
    # Ni «vender» ni «comprar» aparecen como consejo, solo como advertencia.
    assert "recomendación de vender ni comprar" in r["nota"]


# --- Actividad ----------------------------------------------------------------


def test_volumen_mayor_que_open_interest_marca_posicion_nueva():
    """Es la única señal de «inusual» que el dato gratuito da sin histórico."""
    contratos = [
        {"tipo": "call", "strike": 110, "iv": 0.3, "medio": 2, "volumen": 5000, "oi": 300},
        {"tipo": "put", "strike": 90, "iv": 0.3, "medio": 2, "volumen": 100, "oi": 4000},
    ]
    r = op.actividad(contratos, None)
    assert [n["strike"] for n in r["posiciones_nuevas"]] == [110]
    assert r["posiciones_nuevas"][0]["ratio"] == pytest.approx(16.67, abs=0.01)
    assert "dice quién ni por qué" in r["nota_posiciones"]


def test_sin_base_no_se_dice_que_el_volumen_es_inusual():
    contratos = [{"tipo": "call", "strike": 100, "iv": 0.3, "medio": 2, "volumen": 9999, "oi": 10}]
    r = op.actividad(contratos, {"volumen": [100, 120]})
    assert r["inusual"] is None
    assert "necesita una media" in r["nota_base"]


def test_una_base_sin_dispersion_no_se_lee_como_normalidad():
    """Con desviación cero la z salía 0,0 y el panel decía «dentro de lo normal»
    con el volumen al doble de la media."""
    contratos = [{"tipo": "call", "strike": 100, "iv": 0.3, "medio": 2, "volumen": 8000, "oi": 100}]
    r = op.actividad(contratos, {"volumen": [4000] * 12})
    assert r["inusual"]["z"] is None
    assert "no varían entre sí" in r["nota_base"]
    assert "dentro de lo normal" not in r["nota_base"].lower()


def test_la_nota_de_volumen_no_se_come_las_comas_de_la_prosa():
    """El separador de miles se aplicaba con replace(',', '.') a la frase entera:
    «Es un salto grande, y merece» salía «Es un salto grande. y merece»."""
    contratos = [{"tipo": "call", "strike": 100, "iv": 0.3, "medio": 2, "volumen": 9000, "oi": 100}]
    base = {"volumen": [3000, 3200, 2800, 3100, 2900, 3300, 2700, 3050, 2950, 3150, 3000, 2850]}
    r = op.actividad(contratos, base)
    assert r["inusual"]["z"] > 2
    assert "salto grande, y merece" in r["nota_base"]
    assert "9.000" in r["nota_base"]      # miles a la española


# --- El panel entero ----------------------------------------------------------


def test_el_panel_no_devuelve_ningun_score_unico():
    """Es la petición explícita: al lado del fundamental, no mezclado."""
    r = op.panel(
        _cadena(100.0, {V14: 0.42, V45: 0.34, V120: 0.32}),
        100.0,
        _precios(),
        hoy=HOY,
    )
    assert r["disponible"] is True
    assert not any("score" in k or "puntuacion" in k for k in r)
    for bloque in ("prima_de_riesgo", "skew", "estructura_temporal", "movimiento_esperado",
                   "actividad"):
        assert bloque in r
    assert "al lado del análisis fundamental" in r["aviso"].lower() or "AL LADO" in r["aviso"]


def test_el_panel_elige_el_vencimiento_posterior_a_resultados():
    """Un straddle que vence ANTES del anuncio no dice nada del anuncio."""
    resultados = HOY + timedelta(days=20)
    r = op.panel(
        _cadena(100.0, {V14: 0.42, V45: 0.34}),
        100.0,
        _precios(),
        proxima_resultados=resultados,
        hoy=HOY,
    )
    imp = r["movimiento_esperado"]["implicito"]
    assert imp["disponible"] is True
    assert imp["vencimiento"] == V45.isoformat()      # V14 vence antes: se descarta
    assert imp["dias_tras_resultados"] == 25


def test_sin_vencimiento_posterior_a_resultados_se_dice():
    r = op.panel(
        _cadena(100.0, {V14: 0.42}),
        100.0,
        _precios(),
        proxima_resultados=HOY + timedelta(days=90),
        hoy=HOY,
    )
    imp = r["movimiento_esperado"]["implicito"]
    assert imp["disponible"] is False
    assert "posterior a los resultados" in imp["nota"]
