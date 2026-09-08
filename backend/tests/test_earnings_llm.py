"""Lo que sostiene el análisis de resultados y NO depende del modelo.

El riesgo de una función que llama a un LLM no está en la llamada: está en todo
lo que la rodea. Aquí se fija lo que tiene que ser cierto pase lo que pase al
otro lado del API:

- que el esquema no tenga dónde poner una recomendación;
- que una cita inventada se detecte y se marque;
- que la aritmética entre trimestres la haga Python y no el modelo;
- y que un documento demasiado largo se declare en vez de recortarse a escondidas.
"""

from __future__ import annotations

from app.analysis.filing_text import (
    LIMITE_CARACTERES,
    cabe_en_presupuesto,
    extraer_secciones,
    html_a_texto,
)
from app.llm.earnings_llm import (
    SYSTEM,
    AnalisisTrimestre,
    Comparacion,
    hash_documento,
    prompt_comparacion,
    prompt_extraccion,
    variaciones_numericas,
    verificar_citas,
)


# --- El esquema no tiene dónde recomendar ------------------------------------


def test_el_esquema_no_tiene_ningun_campo_para_recomendar():
    """La garantía es estructural, no un ruego en el system prompt: un modelo no
    puede recomendar comprar en un JSON que no tiene sitio para decirlo."""
    campos = set(AnalisisTrimestre.model_fields) | set(Comparacion.model_fields)
    prohibidos = {
        "recomendacion", "accion", "valoracion", "precio_objetivo", "atractivo",
        "opinion", "perspectiva", "senal", "comprar", "vender", "rating",
    }
    assert campos & prohibidos == set(), campos & prohibidos


def test_todo_elemento_extraible_exige_su_cita_literal():
    """Un dato sin la frase que lo respalda no se puede verificar, y entonces la
    verificación entera deja de significar nada."""
    from app.llm.earnings_llm import Guidance, Riesgo, Tema

    for modelo in (Guidance, Riesgo, Tema):
        assert "texto_literal" in modelo.model_fields, modelo
        assert modelo.model_fields["texto_literal"].is_required(), modelo


def test_el_system_prompt_prohibe_recomendar_y_exige_null():
    assert "No evalúas, no recomiendas" in SYSTEM
    assert "no lo completes con lo que sabes de la empresa" in SYSTEM
    assert "Un null es una respuesta correcta" in SYSTEM


# --- Verificación de citas: la defensa contra la alucinación -----------------


DOC = (
    "We expect revenue for the fourth quarter to be between $1.20 billion and "
    "$1.25 billion. Our gross margin outlook remains unchanged. Supply chain "
    "constraints continued to affect delivery times during the quarter."
)


def test_una_cita_que_esta_en_el_documento_se_marca_verificada():
    analisis = {
        "guidance": [
            {
                "metrica": "ingresos",
                "texto_literal": "We expect revenue for the fourth quarter to be between $1.20 billion and $1.25 billion.",
            }
        ],
        "riesgos": [],
        "temas": [],
    }
    r = verificar_citas(analisis, DOC)
    assert analisis["guidance"][0]["cita_verificada"] is True
    assert r["fallidas"] == 0
    assert r["tasa"] == 1.0


def test_una_cita_inventada_se_detecta_y_el_elemento_queda_marcado():
    """El caso que justifica todo el mecanismo: el modelo afirma algo plausible
    que el documento no dice."""
    analisis = {
        "guidance": [
            {
                "metrica": "ingresos",
                "texto_literal": "We are raising our full-year revenue guidance to $5.4 billion.",
            }
        ],
        "riesgos": [],
        "temas": [],
    }
    r = verificar_citas(analisis, DOC)
    assert analisis["guidance"][0]["cita_verificada"] is False
    assert r["fallidas"] == 1
    assert "NO se encontraron" in r["nota"]


def test_lo_no_verificado_se_marca_pero_no_se_borra():
    """Que el modelo se inventara una cita es información sobre la fiabilidad de
    ese análisis; borrarla dejaría un resultado más limpio y menos veraz."""
    analisis = {
        "guidance": [{"metrica": "x", "texto_literal": "esto no está"}],
        "riesgos": [],
        "temas": [],
    }
    verificar_citas(analisis, DOC)
    assert len(analisis["guidance"]) == 1  # sigue ahí
    assert analisis["guidance"][0]["cita_verificada"] is False


def test_las_diferencias_tipograficas_no_cuentan_como_cita_inventada():
    """Comillas curvas, espacios duros y guiones largos cambian según la
    herramienta que generó el filing. Si eso marcara citas correctas como
    inventadas, nadie se creería los avisos y el verificador sobraría."""
    fuente = "Los ingresos crecieron un 12 % —el mejor trimestre— según “la dirección”."
    analisis = {
        "guidance": [],
        "riesgos": [],
        "temas": [
            {
                "tema": "crecimiento",
                "texto_literal": 'Los  ingresos crecieron un 12 % -el mejor trimestre- según "la dirección".',
            }
        ],
    }
    verificar_citas(analisis, fuente)
    assert analisis["temas"][0]["cita_verificada"] is True


def test_sin_citas_no_se_finge_una_tasa_de_verificacion():
    r = verificar_citas({"guidance": [], "riesgos": [], "temas": []}, DOC)
    assert r["tasa"] is None
    assert r["citas"] == 0


# --- La aritmética la hace Python -------------------------------------------


def _con_guidance(**kw):
    return {"guidance": [{"metrica": "ingresos", "periodo": "FY2026", **kw}]}


def test_la_variacion_entre_trimestres_la_calcula_el_codigo():
    antes = _con_guidance(valor_bajo=1000.0, valor_alto=1100.0, unidad="millones USD")
    ahora = _con_guidance(valor_bajo=1200.0, valor_alto=1300.0, unidad="millones USD")
    v = variaciones_numericas(antes, ahora)[0]
    # Punto medio 1050 -> 1250: +19,05 %.
    assert v["variacion_pct"] == 19.05
    assert v["direccion"] == "sube"


def test_una_bajada_de_guidance_sale_como_bajada():
    v = variaciones_numericas(
        _con_guidance(valor_bajo=1000.0, valor_alto=1000.0),
        _con_guidance(valor_bajo=900.0, valor_alto=900.0),
    )[0]
    assert v["direccion"] == "baja"
    assert v["variacion_pct"] == -10.0


def test_sin_cifra_en_un_trimestre_no_se_estima_la_variacion():
    """Estimar aquí sería inventar la parte más citable del análisis."""
    v = variaciones_numericas(
        _con_guidance(valor_bajo=None, valor_alto=None),
        _con_guidance(valor_bajo=1200.0, valor_alto=1200.0),
    )[0]
    assert v["variacion_pct"] is None
    assert "no se estima" in v["motivo_sin_variacion"]


def test_solo_se_comparan_metricas_del_mismo_periodo():
    """El guidance de FY2026 y el de Q1 2026 no son la misma cifra."""
    antes = {"guidance": [{"metrica": "ingresos", "periodo": "Q1 2026", "valor_bajo": 100.0, "valor_alto": 100.0}]}
    ahora = {"guidance": [{"metrica": "ingresos", "periodo": "FY2026", "valor_bajo": 500.0, "valor_alto": 500.0}]}
    assert variaciones_numericas(antes, ahora) == []


def test_las_metricas_se_emparejan_sin_importar_mayusculas_ni_espacios():
    antes = {"guidance": [{"metrica": "Ingresos ", "periodo": "FY2026", "valor_bajo": 100.0, "valor_alto": 100.0}]}
    ahora = {"guidance": [{"metrica": "ingresos", "periodo": " fy2026", "valor_bajo": 110.0, "valor_alto": 110.0}]}
    assert len(variaciones_numericas(antes, ahora)) == 1


# --- Secciones del filing ----------------------------------------------------


# Un 10-Q realista: índice al principio y luego el cuerpo, con cada encabezado
# una sola vez. El MD&A arranca con una referencia cruzada a «Item 1A» como los
# de verdad: si eso descartara el encabezado bueno, el extractor no serviría.
HTML_10Q = """
<html><body>
<table>
<tr><td>Item 1. Financial Statements</td><td>3</td></tr>
<tr><td>Item 1A. Risk Factors</td><td>9</td></tr>
<tr><td>Item 2. Management's Discussion and Analysis</td><td>14</td></tr>
<tr><td>Item 3. Quantitative Disclosures</td><td>28</td></tr>
</table>
<p>Item&nbsp;1A. Risk Factors</p>
""" + "<p>Our business faces competition and regulatory uncertainty.</p>" * 60 + """
<p>Item 2. Unregistered Sales of Equity Securities</p>
<p>Item 2. Management's Discussion and Analysis</p>
<p>This section should be read together with Item 1A. Risk Factors above.</p>
""" + "<p>Revenue increased 12% driven by subscription growth.</p>" * 60 + """
<p>Item 3. Quantitative and Qualitative Disclosures</p>
<p>Interest rate exposure.</p>
</body></html>
"""


def test_se_localizan_las_secciones_por_su_rotulo_oficial():
    r = extraer_secciones(HTML_10Q, "10-Q")
    assert set(r["secciones"]) == {"mdna", "riesgos"}
    assert "subscription growth" in r["secciones"]["mdna"]["texto"]
    assert "regulatory uncertainty" in r["secciones"]["riesgos"]["texto"]


def test_una_entrada_del_indice_no_se_confunde_con_la_seccion():
    """El fallo silencioso y caro: arrancar en la fila del índice mete la sección
    de riesgos ENTERA dentro del MD&A, y el resultado supera cualquier control de
    tamaño porque es más largo, no más corto."""
    secciones = extraer_secciones(HTML_10Q, "10-Q")["secciones"]
    mdna = secciones["mdna"]
    assert mdna["caracteres"] > 2000
    # La marca inequívoca: el texto de riesgos NO puede estar dentro del MD&A.
    assert "regulatory uncertainty" not in mdna["texto"]
    assert mdna["texto"].lower().startswith("item 2")
    # Y las dos secciones son distintas, no una contenida en la otra.
    assert "subscription growth" not in secciones["riesgos"]["texto"]


def test_una_seccion_ausente_se_declara_en_vez_de_rellenarse():
    """Devolver «lo que había alrededor de donde debería estar» sería inventar la
    estructura del documento."""
    r = extraer_secciones("<html><body><p>Nada útil</p></body></html>", "10-Q")
    assert r["secciones"] == {}
    assert len(r["faltan"]) == 2


def test_el_8k_se_toma_entero_porque_ya_es_corto():
    r = extraer_secciones("<html><body><p>Guidance para 2026: 1.200 M USD.</p></body></html>", "8-K")
    assert "completo" in r["secciones"]
    assert "1.200 M USD" in r["secciones"]["completo"]["texto"]


def test_el_html_se_convierte_a_texto_conservando_los_parrafos():
    texto = html_a_texto("<p>Uno</p><p>Dos</p><script>x=1</script><div>Tres</div>")
    assert "x=1" not in texto
    assert texto.count("\n") >= 2
    assert "Uno" in texto and "Tres" in texto


# --- Presupuesto: no se recorta en silencio ----------------------------------


def test_un_documento_que_no_cabe_se_declara_y_no_se_recorta():
    """Un análisis sobre media sección parece completo, no lo es, y no lo dice en
    ninguna parte."""
    r = cabe_en_presupuesto(LIMITE_CARACTERES + 50_000)
    assert r["cabe"] is False
    assert r["exceso_caracteres"] == 50_000
    assert "No se recorta automáticamente" in r["nota"]


def test_un_documento_que_cabe_no_lleva_aviso():
    r = cabe_en_presupuesto(1000)
    assert r["cabe"] is True
    assert r["nota"] is None
    assert r["tokens_estimados"] > 0


# --- Prompts: la fuente viaja siempre ----------------------------------------


def test_el_prompt_de_extraccion_lleva_la_fuente_y_pide_citar_de_ahi():
    p = prompt_extraccion(
        "AAPL", "10-Q", "2026-02-01",
        "https://www.sec.gov/Archives/edgar/data/320193/x.htm",
        {"mdna": {"etiqueta": "MD&A", "texto": "Revenue grew."}},
    )
    assert "https://www.sec.gov/Archives/edgar/data/320193/x.htm" in p
    assert "2026-02-01" in p
    assert "Revenue grew." in p
    assert "literalmente" in p


def test_la_comparacion_recibe_los_dos_json_no_los_dos_documentos():
    p = prompt_comparacion(
        {"resumen": "trimestre viejo"}, {"resumen": "trimestre nuevo"},
        {"tipo": "10-Q", "fecha": "2025-11-01"}, {"tipo": "10-Q", "fecha": "2026-02-01"},
    )
    assert "trimestre viejo" in p and "trimestre nuevo" in p
    assert "por SIGNIFICADO" in p
    assert "no recomiendes nada" in p


def test_el_hash_identifica_la_version_exacta_del_texto():
    assert hash_documento("a") == hash_documento("a")
    assert hash_documento("a") != hash_documento("b")
