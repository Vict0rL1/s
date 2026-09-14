"""Divisas: la dirección del tipo, y no sumar lo que no se puede convertir.

El fallo que este módulo existe para evitar no se parece a un error: la cartera
sumaba dólares canadienses con estadounidenses y salía un total creíble. El
segundo fallo posible es igual de silencioso — leer una serie de FRED del revés
convierte 1,37 en 0,73— y por eso casi todos estos tests son sobre dirección.
"""

from __future__ import annotations

from datetime import date

import pytest

from app.analysis import fx


# --- La dirección, que es donde se rompe todo -----------------------------------


def test_las_dos_direcciones_de_fred_se_tratan_distinto():
    """DEXCAUS son CAD por USD; DEXUSEU son USD por EUR. Tratarlas igual invierte
    una de las dos."""
    # 1,37 CAD por dólar: la serie ya viene en «por dólar», se deja igual.
    assert fx.a_por_usd("CAD", 1.37) == pytest.approx(1.37)
    # 1,08 dólares por euro: hay que invertirlo para tener «euros por dólar».
    assert fx.a_por_usd("EUR", 1.08) == pytest.approx(1 / 1.08)


def test_cada_serie_declara_su_direccion_y_su_titulo():
    """El título de FRED al lado es lo que hace comprobable la dirección sin
    salir del fichero."""
    for moneda, info in fx.SERIES.items():
        assert info["serie"].startswith("DEX")
        assert isinstance(info["por_usd"], bool)
        assert "One" in info["titulo"], f"{moneda} sin título verificable"
        # El título dice la dirección: «X to One U.S. Dollar» es por_usd=True.
        por_usd_segun_titulo = info["titulo"].rstrip(".").endswith("U.S. Dollar")
        assert info["por_usd"] == por_usd_segun_titulo, (
            f"{moneda}: el título dice «{info['titulo']}» y por_usd={info['por_usd']}"
        )


def test_una_serie_leida_del_reves_se_detecta_y_se_niega():
    """La guarda no valida el mercado: detecta la inversión. 1,37 invertido da
    0,73, que ningún movimiento real produce."""
    with pytest.raises(fx.SinTipo) as exc:
        fx.comprobar_banda("CAD", 1 / 1.37)
    assert "del revés" in str(exc.value)
    assert "DEXCAUS" in str(exc.value)


def test_las_bandas_dejan_pasar_movimientos_reales():
    """Una guarda que rechaza tipos legítimos es peor que no tenerla."""
    for moneda, por_usd in [
        ("CAD", 1.00), ("CAD", 1.60),      # el rango real de dos décadas
        ("EUR", 0.70), ("EUR", 1.20),
        ("JPY", 75.0), ("JPY", 160.0),
        ("KRW", 900.0), ("KRW", 1450.0),
    ]:
        fx.comprobar_banda(moneda, por_usd)  # no debe lanzar


def test_sin_banda_configurada_no_se_comprueba_nada():
    fx.comprobar_banda("XYZ", 0.00001)  # no lanza: mejor sin guarda que con una mala


# --- Leer la serie --------------------------------------------------------------


def test_se_coge_la_observacion_mas_reciente_con_valor():
    """FRED publica los festivos como huecos: hay que buscar hacia atrás."""
    puntos = [
        {"ts": "2026-09-09", "value": "1.36"},
        {"ts": "2026-09-10", "value": None},   # festivo
        {"ts": "2026-09-11", "value": None},
    ]
    t = fx.tipo_desde_observaciones("CAD", puntos, hoy=date(2026, 9, 12))
    assert t["por_usd"] == pytest.approx(1.36)
    assert t["fecha"] == "2026-09-09"
    assert t["dias"] == 3
    assert t["fresco"] is True


def test_un_tipo_viejo_se_usa_pero_se_dice_su_fecha():
    puntos = [{"ts": "2026-01-05", "value": "1.40"}]
    t = fx.tipo_desde_observaciones("CAD", puntos, hoy=date(2026, 9, 12))
    assert t["fresco"] is False
    assert t["dias"] > fx.DIAS_FRESCO


def test_una_serie_sin_valores_no_devuelve_un_cero():
    with pytest.raises(fx.SinTipo) as exc:
        fx.tipo_desde_observaciones("CAD", [{"ts": "2026-09-09", "value": "."}])
    assert "ninguna observación" in str(exc.value)


def test_una_moneda_sin_serie_se_dice_en_vez_de_asumir_paridad():
    with pytest.raises(fx.SinTipo) as exc:
        fx.a_por_usd("XYZ", 1.0)
    assert "No hay serie" in str(exc.value)


def test_los_centimos_se_rechazan_en_vez_de_tratarse_como_la_moneda():
    """GBX son peniques: convertirlos como libras da un valor cien veces mayor."""
    with pytest.raises(fx.SinTipo) as exc:
        fx.normalizar("GBX")
    assert "cien veces" in str(exc.value)


# --- Conversión ------------------------------------------------------------------


TIPOS = {
    "CAD": {"por_usd": 1.37, "fecha": "2026-09-10", "fresco": True, "serie": "DEXCAUS"},
    "EUR": {"por_usd": 0.92, "fecha": "2026-09-10", "fresco": True, "serie": "DEXUSEU"},
}


def test_convertir_a_la_misma_moneda_no_toca_el_importe():
    assert fx.convertir(100.0, "USD", "USD", TIPOS) == 100.0
    assert fx.convertir(100.0, "CAD", "CAD", TIPOS) == 100.0


def test_convertir_desde_y_hacia_el_dolar():
    assert fx.convertir(137.0, "CAD", "USD", TIPOS) == pytest.approx(100.0)
    assert fx.convertir(100.0, "USD", "CAD", TIPOS) == pytest.approx(137.0)


def test_convertir_entre_dos_monedas_pasa_por_el_dolar():
    # 137 CAD = 100 USD = 92 EUR
    assert fx.convertir(137.0, "CAD", "EUR", TIPOS) == pytest.approx(92.0)


def test_la_conversion_es_reversible():
    ida = fx.convertir(1234.56, "CAD", "EUR", TIPOS)
    assert fx.convertir(ida, "EUR", "CAD", TIPOS) == pytest.approx(1234.56)


def test_sin_tipo_no_se_convierte_a_la_par():
    with pytest.raises(fx.SinTipo):
        fx.convertir(100.0, "JPY", "USD", TIPOS)


# --- La cartera entera -----------------------------------------------------------


def _pos(symbol, valor, moneda, invertido=None):
    return {
        "symbol": symbol,
        "market_value": valor,
        "invested": invertido if invertido is not None else (valor * 0.8 if valor else 80.0),
        "currency": moneda,
    }


def test_una_cartera_de_una_sola_moneda_no_se_toca():
    r = fx.convertir_cartera([_pos("AAPL", 100.0, "USD"), _pos("MSFT", 50.0, "USD")], {})
    assert r["mezcla_de_divisas"] is False
    assert [p["market_value_base"] for p in r["posiciones"]] == [100.0, 50.0]
    assert "no hay nada que convertir" in r["nota"]


def test_una_cartera_mezclada_se_convierte_antes_de_sumar():
    """Es el bug entero: 100 USD + 137 CAD son 200 USD, no 237 de nada."""
    posiciones = [_pos("AAPL", 100.0, "USD"), _pos("SHOP", 137.0, "CAD")]
    r = fx.convertir_cartera(posiciones, TIPOS)

    assert r["mezcla_de_divisas"] is True
    total = sum(p["market_value_base"] for p in r["posiciones"])
    assert total == pytest.approx(200.0)
    assert total != pytest.approx(237.0), "sumar sin convertir daría 237"
    assert "creíble y equivocado" in r["nota"]


def test_lo_que_no_se_puede_convertir_queda_fuera_y_se_nombra():
    """Un total parcial que se sabe parcial sirve; uno que se cree completo, no."""
    posiciones = [_pos("AAPL", 100.0, "USD"), _pos("TOYOTA", 15000.0, "JPY")]
    r = fx.convertir_cartera(posiciones, TIPOS)  # sin tipo para JPY

    assert [p["symbol"] for p in r["posiciones"]] == ["AAPL"]
    assert r["sin_convertir"][0]["symbol"] == "TOYOTA"
    assert "JPY" in r["sin_convertir"][0]["motivo"]
    assert "quedan FUERA del total" in r["nota"]


def test_se_reporta_cuanto_pesa_cada_divisa():
    posiciones = [_pos("AAPL", 100.0, "USD"), _pos("SHOP", 274.0, "CAD")]
    r = fx.convertir_cartera(posiciones, TIPOS)
    assert r["monedas"] == {"USD": 100.0, "CAD": 200.0}


def test_los_tipos_usados_viajan_con_su_fecha_y_su_serie():
    """Un tipo sin fecha ni fuente no es comprobable."""
    r = fx.convertir_cartera([_pos("SHOP", 137.0, "CAD")], TIPOS)
    usado = r["tipos_usados"]["CAD"]
    assert usado["por_usd"] == 1.37
    assert usado["fecha"] == "2026-09-10"
    assert usado["serie"] == "DEXCAUS"


def test_una_posicion_sin_moneda_se_asume_en_la_base_y_no_se_pierde():
    r = fx.convertir_cartera([_pos("AAPL", 100.0, None)], TIPOS)
    assert r["posiciones"][0]["currency"] == "USD"
    assert r["posiciones"][0]["market_value_base"] == 100.0


def test_una_posicion_sin_precio_se_convierte_a_none_sin_romper():
    r = fx.convertir_cartera([_pos("RARA", None, "CAD")], TIPOS)
    assert r["posiciones"][0]["market_value_base"] is None
    assert r["posiciones"][0]["invested_base"] is not None


def test_un_tipo_viejo_se_avisa_en_la_nota():
    tipos = {"CAD": {"por_usd": 1.37, "fecha": "2026-01-05", "fresco": False, "serie": "DEXCAUS"}}
    r = fx.convertir_cartera([_pos("SHOP", 137.0, "CAD")], tipos)
    assert "más de" in r["nota"] and "días" in r["nota"]
