"""Tests de la lista corta: de 98 candidatas a unas pocas ideas.

El riesgo de este módulo no es que falle, es que engañe: que recorte por
donde no debe, que concentre todo en un sector, o que cuele en la lista corta
algo que el motor de decisión no manda comprar.
"""

from __future__ import annotations

from app.analysis.shortlist import (
    MAX_POR_SECTOR,
    construir_lista_corta,
    conviccion,
)


def señal(
    symbol,
    score,
    sector="Tech",
    families=None,
    action="comprar",
    stop_pct=12.0,
):
    return {
        "symbol": symbol,
        "score": score,
        "families": families or {"value": 0.5, "quality": 0.5, "momentum": 0.5},
        "context": {"sector_name": sector},
        "decision": {"action": action, "levels": {"stop_pct": stop_pct}},
    }


# --- Convicción: qué separa una idea buena de otra que solo pasa el listón ---


def test_el_acuerdo_entre_factores_desempata_a_igual_puntuacion():
    """Dos empresas con la misma nota media no son la misma idea: una la
    sostienen tres factores y la otra uno solo mientras otro se hunde."""
    coherente = señal("A", 0.6, families={"value": 0.6, "quality": 0.6, "momentum": 0.6})
    frankenstein = señal(
        "B", 0.6, families={"value": 1.8, "quality": -0.9, "momentum": 0.9}
    )
    assert conviccion(coherente)["valor"] > conviccion(frankenstein)["valor"]


def test_un_factor_claramente_en_contra_penaliza():
    sin = conviccion(señal("A", 0.6, families={"value": 0.5, "quality": 0.5, "momentum": 0.5}))
    con = conviccion(señal("B", 0.6, families={"value": 0.5, "quality": 0.5, "momentum": -0.9}))
    assert con["acuerdo"] < sin["acuerdo"]
    assert "momentum" in con["factores_en_contra"]


def test_una_idea_sostenida_por_un_solo_factor_no_es_una_idea_contrastada():
    uno = conviccion(señal("A", 0.6, families={"value": 0.6}))
    tres = conviccion(señal("B", 0.6))
    assert uno["acuerdo"] < tres["acuerdo"]


def test_a_igualdad_de_todo_gana_la_que_exige_arriesgar_menos():
    ceñido = conviccion(señal("A", 0.6, stop_pct=9.0))
    ancho = conviccion(señal("B", 0.6, stop_pct=24.0))
    assert ceñido["valor"] > ancho["valor"]
    assert ceñido["eficiencia_riesgo"] > ancho["eficiencia_riesgo"]


def test_superar_el_liston_por_mucho_cuenta_mas_que_superarlo_por_poco():
    justo = conviccion(señal("A", 0.36))
    holgado = conviccion(señal("B", 1.20))
    assert holgado["valor"] > justo["valor"]


# --- Selección: pocas, y no todas del mismo sitio ---------------------------


def test_la_lista_corta_es_corta():
    señales = [señal(f"S{i}", 1.5 - i * 0.01, sector=f"Sec{i % 8}") for i in range(98)]
    r = construir_lista_corta(señales)
    assert len(r["ideas"]) == 5
    assert r["candidatas"] == 98


def test_no_concentra_la_lista_corta_en_un_solo_sector():
    """Cinco tecnológicas no son cinco ideas: se hunden juntas."""
    señales = [señal(f"T{i}", 1.5 - i * 0.01, sector="Tech") for i in range(20)]
    señales += [señal(f"S{i}", 0.5, sector=f"Otro{i}") for i in range(6)]
    r = construir_lista_corta(señales)
    tech = [s for s in r["ideas"] if s["context"]["sector_name"] == "Tech"]
    assert len(tech) <= MAX_POR_SECTOR


def test_si_no_hay_variedad_se_completa_igual_en_vez_de_devolver_media_lista():
    """Con un solo sector disponible, media lista es peor que relajar el tope."""
    señales = [señal(f"T{i}", 1.5 - i * 0.01, sector="Tech") for i in range(20)]
    r = construir_lista_corta(señales)
    assert len(r["ideas"]) == 5


def test_solo_entra_lo_que_el_motor_manda_comprar():
    """Esto ordena y recorta; no relaja ninguna regla. Una empresa que puntúa
    altísimo pero cotiza bajo su media sigue fuera."""
    señales = [
        señal("VIGILADA", 3.0, action="vigilar"),
        señal("NEUTRA", 3.0, action="ninguna"),
        señal("MIA", 3.0, action="mantener"),
        señal("BUENA", 0.4, action="comprar"),
    ]
    r = construir_lista_corta(señales)
    assert [s["symbol"] for s in r["ideas"]] == ["BUENA"]


def test_la_lista_de_evitar_trae_las_peores_no_las_primeras():
    señales = [
        señal(f"M{i}", -0.4 - i * 0.2, sector=f"Sec{i}", action="evitar")
        for i in range(8)
    ]
    r = construir_lista_corta(señales)
    peores = [s["symbol"] for s in r["evitar"]]
    assert peores[0] == "M7"  # la de puntuación más baja
    assert len(peores) == 5


def test_cada_idea_explica_por_que_ella_y_no_otra():
    r = construir_lista_corta([señal("A", 0.9)])
    idea = r["ideas"][0]
    assert idea["conviction"]["puesto"] == 1
    assert "factores apuntan igual" in idea["conviction"]["resumen"]


def test_el_resumen_nombra_tambien_lo_que_flojea():
    r = construir_lista_corta(
        [señal("A", 0.9, families={"value": 1.5, "quality": 1.2, "momentum": -0.3})]
    )
    assert "flojea en momentum" in r["ideas"][0]["conviction"]["resumen"]


# --- Honestidad --------------------------------------------------------------


def test_sin_candidatas_lo_dice_en_vez_de_rellenar_con_lo_que_haya():
    """Rellenar la lista corta con lo mejor de un día malo es exactamente cómo
    una herramienta te empuja a operar cuando no toca."""
    r = construir_lista_corta([señal("A", 0.1, action="ninguna")])
    assert r["ideas"] == []
    assert "ninguna empresa cumple" in r["nota"].lower()
    assert "no actuar" in r["nota"].lower()


def test_la_nota_aclara_que_las_demas_no_se_han_descartado():
    """Si el usuario cree que las otras 93 se descartaron, la lista corta pasa
    de ayudar a esconder información."""
    señales = [señal(f"S{i}", 1.5 - i * 0.01, sector=f"Sec{i % 8}") for i in range(98)]
    nota = construir_lista_corta(señales)["nota"]
    assert "98" in nota and "5" in nota
    assert "ordenado" in nota


def test_la_lista_de_evitar_explica_por_que_NO_comprarla():
    """Decir «destaca en valor» de algo que se manda evitar invita justo a lo
    contrario de lo que la lista pretende."""
    s = señal(
        "MALA",
        -0.8,
        families={"value": 1.4, "quality": -1.1, "momentum": -0.9},
        action="evitar",
    )
    resumen = construir_lista_corta([s])["evitar"][0]["conviction"]["resumen"]
    assert "Destaca" not in resumen
    assert "Queda por detrás" in resumen
    # Nombra lo que sí tiene, porque una trampa de valor no es lo mismo que una
    # empresa simplemente mala.
    assert "trampa de valor" in resumen


def test_las_enumeraciones_se_escriben_en_castellano():
    """«momentum y calidad y valor» no lo escribe una herramienta cuidada."""
    # Tres elementos es donde se rompía: «momentum y calidad y valor».
    idea = construir_lista_corta(
        [señal("X", 0.9, families={"value": -0.2, "quality": -0.3, "momentum": -0.4})]
    )["ideas"][0]
    assert "flojea en momentum, calidad y valor" in idea["conviction"]["resumen"]

    # Y dos elementos sigue siendo «a y b», sin coma.
    dos = construir_lista_corta(
        [señal("Y", 0.9, families={"value": 0.5, "quality": -0.3, "momentum": -0.4})]
    )["ideas"][0]
    assert "flojea en momentum y calidad" in dos["conviction"]["resumen"]
