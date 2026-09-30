"""La evaluación de alertas, sin HTTP y sin base de datos.

Lo que más se comprueba aquí no es que una alerta salte cuando el precio cruza
el umbral — eso es una comparación de dos números y es difícil equivocarse. Lo
que se comprueba es lo otro: que una alerta que NO se pudo comprobar no se
cuente como una alerta tranquila, y que una alerta apagada a propósito no se
cuente como una alerta rota. Las dos confusiones producen el mismo daño: te
crees vigilado cuando no lo estás, o te acostumbras a ignorar avisos falsos.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.analysis import alertas as al


def _alerta(op="lt", precio=150.0, activa=True, saltada=None, symbol="AAPL"):
    return {
        "id": 1,
        "symbol": symbol,
        "condition": {"op": op, "price": precio},
        "active": activa,
        "triggered_at": saltada,
    }


# --- la comparación en sí -------------------------------------------------


def test_lt_se_cumple_por_debajo():
    v = al.evaluar(_alerta("lt", 150.0), 140.0)
    assert v["evaluable"] and v["cumple"]
    assert "por debajo de" in v["motivo"]
    assert "140" in v["motivo"] and "150" in v["motivo"]


def test_lt_no_se_cumple_por_encima():
    v = al.evaluar(_alerta("lt", 150.0), 160.0)
    assert v["evaluable"] and not v["cumple"]


def test_gt_se_cumple_por_encima():
    v = al.evaluar(_alerta("gt", 150.0), 160.0)
    assert v["evaluable"] and v["cumple"]
    assert "por encima de" in v["motivo"]


def test_el_umbral_exacto_no_cuenta():
    # Estrictamente menor: un precio clavado en el umbral no lo ha cruzado.
    assert not al.evaluar(_alerta("lt", 150.0), 150.0)["cumple"]
    assert not al.evaluar(_alerta("gt", 150.0), 150.0)["cumple"]


# --- lo que no se puede evaluar ------------------------------------------


def test_sin_precio_no_es_que_no_salte():
    v = al.evaluar(_alerta(), None)
    assert not v["evaluable"]
    assert v["estado"] == "sin_precio"
    # La frase tiene que dejar claro que es ignorancia, no tranquilidad.
    assert "no se sabe" in v["motivo"].lower()


def test_operador_desconocido_no_se_adivina():
    # El handler viejo trataba cualquier op que no fuera "lt" como ">": un
    # "gte" mal escrito se evaluaba al revés en silencio.
    v = al.evaluar(_alerta("mayor_que", 150.0), 160.0)
    assert not v["evaluable"] and not v["cumple"]
    assert v["estado"] == "condicion_invalida"


def test_sin_umbral_no_se_evalua():
    alerta = {"id": 1, "symbol": "AAPL", "condition": {"op": "lt"}, "active": True,
              "triggered_at": None}
    v = al.evaluar(alerta, 140.0)
    assert not v["evaluable"]
    assert v["estado"] == "condicion_invalida"


def test_desactivada_no_es_lo_mismo_que_rota():
    v = al.evaluar(_alerta(activa=False), 140.0)
    assert not v["evaluable"]
    # Una alerta apagada a propósito no es un fallo del que haya que avisar.
    assert v["estado"] == "desactivada"


# --- avisar una sola vez --------------------------------------------------


def test_es_nueva_solo_en_la_transicion():
    alerta = _alerta()
    v = al.evaluar(alerta, 140.0)
    assert al.es_nueva(alerta, v)

    ya = _alerta(saltada=datetime(2026, 1, 5, tzinfo=timezone.utc))
    assert not al.es_nueva(ya, al.evaluar(ya, 140.0))


def test_no_cumplida_nunca_es_nueva():
    alerta = _alerta()
    assert not al.es_nueva(alerta, al.evaluar(alerta, 160.0))


# --- el resumen de la pasada ---------------------------------------------


def _resultado(alerta, precio):
    v = al.evaluar(alerta, precio)
    return {"symbol": alerta["symbol"], "veredicto": v, "nueva": al.es_nueva(alerta, v)}


def test_resumen_separa_las_tres_cosas():
    nueva = _alerta(symbol="AAPL")
    vieja = _alerta(symbol="MSFT", saltada=datetime(2026, 1, 5, tzinfo=timezone.utc))
    rota = _alerta(symbol="NVDA")
    apagada = _alerta(symbol="TSLA", activa=False)

    salida = al.resumir(
        [
            _resultado(nueva, 140.0),
            _resultado(vieja, 140.0),
            _resultado(rota, None),
            _resultado(apagada, 140.0),
        ]
    )

    assert salida["total"] == 4
    # «Revisadas» son las que se han mirado de verdad: la desactivada no cuenta.
    assert salida["revisadas"] == 3
    assert [n["symbol"] for n in salida["nuevas"]] == ["AAPL"]
    assert salida["ya_saltadas"] == 1
    # La apagada NO se cuenta como rota: es una decisión, no un fallo.
    assert [r["symbol"] for r in salida["no_evaluables"]] == ["NVDA"]
    assert salida["desactivadas"] == 1


def test_el_resumen_nombra_lo_que_no_se_pudo_comprobar():
    rota = _alerta(symbol="NVDA")
    salida = al.resumir([_resultado(rota, None)])
    assert "NVDA" in salida["resumen"]
    assert "no se sabe" in salida["resumen"].lower()


def test_resumen_de_una_pasada_tranquila():
    alerta = _alerta()
    salida = al.resumir([_resultado(alerta, 160.0)])
    assert salida["nuevas"] == []
    assert "Ninguna nueva" in salida["resumen"]
    assert "no se sabe" not in salida["resumen"].lower()


def test_resumen_sin_alertas():
    salida = al.resumir([])
    assert salida["revisadas"] == 0
    assert salida["nuevas"] == []


# --- el texto del aviso ---------------------------------------------------


def test_aviso_de_una_alerta_dice_el_precio():
    alerta = _alerta()
    titulo, cuerpo = al.texto_de_aviso([_resultado(alerta, 140.0)])
    assert "AAPL" in titulo
    assert "140" in cuerpo and "150" in cuerpo


def test_aviso_de_varias_cuenta_y_enumera():
    alertas = [_resultado(_alerta(symbol=s), 140.0) for s in ("AAPL", "MSFT", "NVDA")]
    titulo, cuerpo = al.texto_de_aviso(alertas)
    assert "3" in titulo
    for s in ("AAPL", "MSFT", "NVDA"):
        assert s in cuerpo


def test_aviso_de_muchas_se_corta():
    alertas = [_resultado(_alerta(symbol=f"S{i}"), 140.0) for i in range(9)]
    titulo, cuerpo = al.texto_de_aviso(alertas)
    assert "9" in titulo
    assert "…" in cuerpo  # se trunca: una notificación se lee de reojo
    assert len(cuerpo) < 80


def test_sin_nuevas_no_hay_aviso():
    assert al.texto_de_aviso([]) == ("", "")


# --- ¿hay algo vigilando? -------------------------------------------------


AHORA = datetime(2026, 9, 27, 12, 0, tzinfo=timezone.utc)


def test_sin_marca_dice_que_nadie_vigila(tmp_path):
    estado = al.ultima_pasada(tmp_path, AHORA)
    assert not estado["activa"] and estado["nunca"]
    assert "cron" in estado["nota"].lower()


def test_una_pasada_reciente_cuenta_como_vigilancia(tmp_path):
    al.anotar_pasada(tmp_path, al.resumir([]), AHORA - timedelta(minutes=8))
    estado = al.ultima_pasada(tmp_path, AHORA)
    assert estado["activa"] and not estado["nunca"]
    assert "8 minutos" in estado["nota"]


def test_una_pasada_vieja_no_se_pinta_como_activa(tmp_path):
    al.anotar_pasada(tmp_path, al.resumir([]), AHORA - timedelta(days=3))
    estado = al.ultima_pasada(tmp_path, AHORA)
    assert not estado["activa"]
    # Y se distingue de «nunca se configuró»: la solución no es la misma.
    assert not estado["nunca"]
    assert "3 días" in estado["nota"]


def test_una_marca_corrupta_no_rompe_la_pestana(tmp_path):
    al.ruta_de_estado(tmp_path).write_text("{esto no es json", encoding="utf-8")
    estado = al.ultima_pasada(tmp_path, AHORA)
    assert not estado["activa"] and estado["nunca"]


def test_la_marca_guarda_el_recuento(tmp_path):
    alerta = _alerta()
    salida = al.resumir([_resultado(alerta, 140.0)])
    al.anotar_pasada(tmp_path, salida, AHORA)
    estado = al.ultima_pasada(tmp_path, AHORA)
    assert estado["revisadas"] == 1 and estado["nuevas"] == 1


def test_anotar_no_deja_archivos_a_medias(tmp_path):
    al.anotar_pasada(tmp_path, al.resumir([]), AHORA)
    assert [p.name for p in tmp_path.iterdir()] == [al.NOMBRE_DE_ESTADO]
