"""Vigilancia de tesis: comprobar los umbrales que TÚ escribiste.

Lo que se fija aquí:

- que un umbral cruzado se detecte, y uno no cruzado no se invente;
- que «no se pudo medir» NUNCA se cuente como «está bien»;
- que el disparador de noticias se declare como lo que es —buscar palabras— y
  no como vigilancia;
- y que un disparador que salta se presente como un recordatorio para releer la
  tesis, no como una señal de venta.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.analysis.thesis_watch import (
    coherencia,
    evaluar,
    evaluar_noticia,
    instantanea,
    vigilar,
)


def disp(kind, config, descripcion="porque sí", **kw):
    return {"id": 1, "kind": kind, "descripcion": descripcion, "config": config,
            "activo": True, **kw}


RATIOS = [
    {"fiscal_year": 2022, "operating_margin": 0.25, "roe": 0.30},
    {"fiscal_year": 2023, "operating_margin": 0.22, "roe": 0.28},
    {"fiscal_year": 2024, "operating_margin": 0.19, "roe": 0.26},
    {"fiscal_year": 2025, "operating_margin": 0.16, "roe": 0.24},
]


# --- Disparadores de métrica --------------------------------------------------


def test_un_umbral_cruzado_salta_con_el_valor_y_el_umbral():
    r = evaluar(
        disp("metrica", {"metrica": "operating_margin", "op": "lt", "umbral": 0.18}),
        {"ratios": RATIOS},
    )
    assert r["salta"] is True
    assert r["valor"] == 0.16
    assert r["umbral"] == 0.18
    assert "0.160" in r["detalle"]
    assert r["ejercicio"] == 2025


def test_un_umbral_no_cruzado_no_se_inventa():
    r = evaluar(
        disp("metrica", {"metrica": "operating_margin", "op": "lt", "umbral": 0.10}),
        {"ratios": RATIOS},
    )
    assert r["salta"] is False
    assert "Todavía no lo cruza" in r["detalle"]


def test_la_tendencia_acompaña_al_veredicto():
    """Cruzar el umbral tras tres años de caídas no es lo mismo que cruzarlo tras
    un año malo aislado."""
    r = evaluar(
        disp("metrica", {"metrica": "operating_margin", "op": "lt", "umbral": 0.18}),
        {"ratios": RATIOS},
    )
    assert r["tendencia"] == "bajando"
    assert r["serie"] == [0.25, 0.22, 0.19, 0.16]


def test_un_dato_que_falta_no_cuenta_como_que_esta_bien():
    """La distinción que más importa: «no se pudo medir» y «no salta» son cosas
    distintas, y confundirlas convierte un fallo de datos en tranquilidad."""
    r = evaluar(
        disp("metrica", {"metrica": "roic", "op": "lt", "umbral": 0.10}),
        {"ratios": RATIOS},
    )
    assert r["salta"] is False
    assert r["medible"] is False
    assert "no es lo mismo que estar por encima del umbral" in r["motivo"]


def test_sin_estados_financieros_no_se_comprueba_nada():
    r = evaluar(
        disp("metrica", {"metrica": "operating_margin", "op": "lt", "umbral": 0.18}),
        {"ratios": []},
    )
    assert r["medible"] is False


def test_un_disparador_mal_configurado_se_declara_en_vez_de_pasar():
    r = evaluar(disp("metrica", {"metrica": "roe", "op": "raro", "umbral": 0.1}), {"ratios": RATIOS})
    assert r["medible"] is False
    assert "mal configurado" in r["motivo"]


# --- Crecimiento --------------------------------------------------------------


def test_la_desaceleracion_del_crecimiento_salta():
    r = evaluar(
        disp("crecimiento", {"metrica": "revenue_cagr", "op": "lt", "umbral": 0.05}),
        {"crecimiento": {"revenue_cagr": 0.03}},
    )
    assert r["salta"] is True
    assert r["valor"] == 0.03


# --- Noticias: buscar palabras, no entender ----------------------------------


def _noticia(headline, dias=1, summary=""):
    return {
        "headline": headline,
        "summary": summary,
        "url": "https://x/1",
        "source": "fake",
        "published_at": (datetime.now(timezone.utc) - timedelta(days=dias)).isoformat(),
    }


def test_una_palabra_clave_en_un_titular_salta_con_su_enlace():
    r = evaluar_noticia(
        {"palabras": ["recall", "investigación"]},
        [_noticia("Regulators open investigación into the company")],
    )
    assert r["salta"] is True
    assert r["coincidencias"][0]["palabras"] == ["investigación"]
    assert r["coincidencias"][0]["url"]


def test_las_tildes_no_impiden_la_coincidencia():
    """«investigacion» en un titular tiene que casar con «investigación»."""
    r = evaluar_noticia({"palabras": ["investigación"]}, [_noticia("Nueva investigacion abierta")])
    assert r["salta"] is True


def test_una_palabra_dentro_de_otra_no_cuenta():
    """Buscar «cae» dentro de «cadena» convertiría el vigilante en ruido."""
    r = evaluar_noticia({"palabras": ["cae"]}, [_noticia("Problemas en la cadena de suministro")])
    assert r["salta"] is False


def test_las_noticias_viejas_quedan_fuera_de_la_ventana():
    r = evaluar_noticia({"palabras": ["recall"]}, [_noticia("Big recall announced", dias=60)])
    assert r["salta"] is False
    assert r["titulares_revisados"] == 0


def test_el_disparador_de_noticias_declara_que_solo_busca_palabras():
    """La diferencia con los otros dos tipos es grande y no se ve: un margen que
    cruza es un hecho de los estados; esto es una coincidencia de texto."""
    r = evaluar_noticia({"palabras": ["recall"]}, [_noticia("A recall today")])
    assert "BUSCA PALABRAS, no entiende" in r["aviso"]
    assert "falsos positivos" in r["aviso"]
    assert "revisión voluntaria" in r["aviso"]


def test_un_disparador_de_noticias_sin_palabras_no_es_medible():
    r = evaluar_noticia({"palabras": []}, [_noticia("algo")])
    assert r["medible"] is False


# --- El conjunto --------------------------------------------------------------


def test_lo_no_medible_se_cuenta_aparte_de_lo_que_no_salta():
    r = vigilar(
        [
            disp("metrica", {"metrica": "operating_margin", "op": "lt", "umbral": 0.18}),
            disp("metrica", {"metrica": "roic", "op": "lt", "umbral": 0.10}),
            disp("metrica", {"metrica": "roe", "op": "lt", "umbral": 0.05}),
        ],
        {"ratios": RATIOS},
    )
    assert r["saltan"] == 1     # el margen
    assert r["sin_medir"] == 1  # el ROIC, que no está en la serie
    assert r["total"] == 3
    assert "no es lo mismo que estar bien" in r["nota"]


def test_un_disparador_que_salta_no_se_presenta_como_señal_de_venta():
    """Lo escribiste tú cuando pensabas con más calma. Lo que toca es releer."""
    r = vigilar(
        [disp("metrica", {"metrica": "operating_margin", "op": "lt", "umbral": 0.18})],
        {"ratios": RATIOS},
    )
    assert "no es una señal de venta" in r["nota"]
    assert "releer la tesis" in r["nota"]


def test_una_tesis_sin_disparadores_se_señala_como_no_vigilada():
    r = vigilar([], {})
    assert r["total"] == 0
    assert "nadie lo mira solo" in r["nota"]


def test_los_disparadores_inactivos_no_se_evaluan():
    r = vigilar(
        [disp("metrica", {"metrica": "operating_margin", "op": "lt", "umbral": 0.18},
              activo=False)],
        {"ratios": RATIOS},
    )
    assert r["total"] == 0


# --- La instantánea y la coherencia ------------------------------------------


def test_la_instantanea_congela_lo_que_la_app_enseñaba():
    """Reconstruir seis meses después qué sabías es imposible: la memoria
    reescribe el pasado para que encaje con lo que pasó."""
    v = vigilar(
        [disp("metrica", {"metrica": "operating_margin", "op": "lt", "umbral": 0.18},
              descripcion="Si el margen baja del 18 %")],
        {"ratios": RATIOS},
    )
    snap = instantanea(140.0, v, {"id": 3, "title": "Tesis", "created_at": "2026-01-01"})
    assert snap["precio"] == 140.0
    assert snap["tesis"]["id"] == 3
    assert len(snap["disparadores_saltando"]) == 1
    assert "Si el margen baja del 18 %" in snap["disparadores_saltando"][0]["descripcion"]
    assert snap["capturado_en"]


def test_la_coherencia_señala_las_decisiones_sin_tesis():
    """Incómodo a propósito: una decisión sin tesis no se puede revisar después."""
    r = coherencia([
        {"accion": "comprar", "thesis_id": None, "contexto": {}},
        {"accion": "comprar", "thesis_id": 1, "contexto": {}},
    ])
    assert r["sin_tesis"] == 1
    assert "no se puede revisar después" in r["nota"]


def test_la_coherencia_señala_comprar_con_puntos_de_invalidacion_saltando():
    r = coherencia([
        {
            "accion": "reforzar", "thesis_id": 1,
            "contexto": {"disparadores_saltando": [{"descripcion": "margen"}]},
        }
    ])
    assert r["con_disparadores_activos"] == 1
    assert "ya saltando" in r["nota"]
    # No lo llama error: lo escribiste tú y puedes haber cambiado de opinión.
    assert "puede estar perfectamente justificado" in r["nota"].lower()


def test_sin_decisiones_no_se_inventa_un_diagnostico():
    assert coherencia([])["decisiones"] == 0
