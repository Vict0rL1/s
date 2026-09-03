"""El flujo completo de análisis de resultados, con el modelo simulado.

Lo que se fija aquí son las reglas de la casa, que valen más que el contenido de
cualquier respuesta concreta del modelo:

- el LLM no se llama solo: hay un endpoint para ver el coste ANTES de gastarlo;
- cada análisis enlaza a su documento de la SEC;
- un filing se analiza una vez, para que la serie tenga una fila por trimestre;
- y el trimestre anterior se compara sin volver a descargar ni releer documentos.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.db.engine import get_session
from app.deps import get_llm, get_service
from app.llm.base import LLMProvider, LLMUnavailableError
from app.main import app
from app.providers.base import iso_utc

# Un 10-Q realista: índice al principio (rótulos amontonados), luego el cuerpo
# con cada encabezado UNA vez seguido de páginas de prosa. El MD&A empieza
# citando «see Item 1A» como hacen los de verdad — si eso descartara el
# encabezado, la extracción no serviría contra ningún filing real.
RIESGOS = (
    "Supply chain constraints continued to affect delivery times. "
    "We face intense competition in all of our markets. "
) * 40
MDNA = (
    "Revenue increased 12% driven by subscription growth. "
    "We expect fourth quarter revenue to be between $1.20 billion and $1.25 billion. "
) * 40

HTML = f"""<html><body>
<table>
<tr><td>Item 1. Financial Statements</td><td>3</td></tr>
<tr><td>Item 1A. Risk Factors</td><td>9</td></tr>
<tr><td>Item 2. Management's Discussion and Analysis</td><td>14</td></tr>
<tr><td>Item 3. Quantitative and Qualitative Disclosures</td><td>28</td></tr>
<tr><td>Item 4. Controls and Procedures</td><td>30</td></tr>
</table>
<p>Item 1A. Risk Factors</p>
<p>{RIESGOS}</p>
<p>Item 2. Unregistered Sales of Equity Securities</p>
<p>Item 2. Management's Discussion and Analysis of Financial Condition</p>
<p>The following discussion should be read together with Item 1A. Risk Factors.</p>
<p>{MDNA}</p>
<p>Item 3. Quantitative and Qualitative Disclosures</p>
</body></html>"""


def _filing(accn: str, fecha: str, tipo: str = "10-Q") -> dict:
    return {
        "type": tipo,
        "filed_at": fecha,
        "accession_no": accn,
        "url": f"https://www.sec.gov/Archives/edgar/data/320193/{accn}/x.htm",
    }


class FakeService:
    def __init__(self):
        self.llamadas: dict[str, int] = {}

    def get(self, data_type, **kwargs):
        self.llamadas[data_type] = self.llamadas.get(data_type, 0) + 1
        common = {"source": "edgar", "as_of": iso_utc(), "cached": False}
        if data_type == "filings":
            return {
                **common,
                "symbol": kwargs["symbol"],
                "filings": [
                    _filing("0000320193-26-000010", "2026-02-01"),
                    _filing("0000320193-25-000090", "2025-11-01"),
                    {**_filing("0000320193-25-000050", "2025-08-01"), "type": "DEF 14A"},
                ],
            }
        if data_type == "filing_document":
            return {**common, "url": kwargs["url"], "html": HTML}
        raise AssertionError(f"tipo inesperado: {data_type}")


class FakeLLM(LLMProvider):
    """Devuelve extracciones deterministas. Cuenta las llamadas."""

    name = "fake"

    def __init__(self):
        self.extracciones = 0
        self.conteos = 0
        self.fallar = False

    def interpret(self, system, prompt):
        raise AssertionError("el análisis de resultados no debe usar interpret()")

    def contar_tokens(self, system, prompt):
        self.conteos += 1
        return 12345

    def extract(self, system, prompt, schema):
        if self.fallar:
            raise LLMUnavailableError("modelo no disponible")
        self.extracciones += 1
        if schema.__name__ == "Comparacion":
            data = {
                "cambios_de_guidance": [
                    {
                        "metrica": "ingresos", "periodo": "Q4 2026",
                        "direccion": "sube", "antes": "$1.10B-$1.15B", "ahora": "$1.20B-$1.25B",
                    }
                ],
                "cambios_de_tema": [
                    {
                        "tema": "cadena de suministro", "estado": "se_mantiene",
                        "texto_literal_nuevo": "Supply chain constraints continued to affect delivery times.",
                        "texto_literal_anterior": "Supply chain constraints continued to affect delivery times.",
                    }
                ],
                "riesgos_nuevos": [],
                "riesgos_que_desaparecen": [],
                "resumen_del_cambio": "La previsión de ingresos sube y el tema de suministro sigue presente.",
            }
        else:
            # La cifra depende del TRIMESTRE, no del orden de las llamadas: un
            # doble que cambia de respuesta según cuándo se le llame convierte
            # cualquier test de comparación en una trampa que pasa por accidente.
            bajo = 1.20 if "2026-02-01" in prompt else 1.10
            data = {
                "resumen": "El documento describe el trimestre.",
                "menciona_guidance": True,
                "guidance": [
                    {
                        "metrica": "ingresos", "periodo": "Q4 2026",
                        "valor_bajo": bajo, "valor_alto": bajo + 0.05, "unidad": "miles de millones USD",
                        "texto_literal": "We expect fourth quarter revenue to be between $1.20 billion and $1.25 billion.",
                    }
                ],
                "riesgos": [
                    {
                        "tema": "cadena de suministro",
                        "descripcion": "Restricciones que afectan a los plazos de entrega.",
                        "texto_literal": "Supply chain constraints continued to affect delivery times.",
                    },
                    {
                        "tema": "riesgo inventado",
                        "descripcion": "Esto no aparece en el documento.",
                        "texto_literal": "The company announced a major acquisition of a competitor.",
                    },
                ],
                "temas": [
                    {
                        "tema": "crecimiento por suscripción", "prominencia": "alta",
                        "texto_literal": "Revenue increased 12% driven by subscription growth.",
                    }
                ],
            }
        return {"data": data, "model": "claude-opus-5-fake", "usage": {"entrada": 12345, "salida": 900}}


@pytest.fixture
def client(session_factory):
    service, llm = FakeService(), FakeLLM()

    def override_session():
        session = session_factory()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_service] = lambda: service
    app.dependency_overrides[get_llm] = lambda: llm
    app.dependency_overrides[get_session] = override_session
    with TestClient(app) as c:
        yield c, service, llm
    app.dependency_overrides.clear()


# --- El LLM no se llama solo -------------------------------------------------


def test_se_puede_ver_el_coste_sin_gastar_una_llamada_al_modelo(client):
    """Pedirlo a ciegas no es pedirlo: un 10-Q largo cuesta bastante más que uno
    corto y eso hay que saberlo antes, no en la factura."""
    c, _, llm = client
    r = c.get("/api/earnings/AAPL/coste").json()
    assert llm.extracciones == 0
    assert llm.conteos == 1
    assert r["coste"]["tokens_entrada"] == 12345
    assert r["coste"]["usd_estimado"] > 0
    assert set(r["secciones"]) == {"mdna", "riesgos"}


def test_el_listado_declara_que_las_transcripciones_no_se_analizan(client):
    """No sustituir en silencio la llamada de resultados por otra cosa."""
    c, _, llm = client
    r = c.get("/api/earnings/AAPL/disponibles").json()
    assert llm.extracciones == 0
    assert len(r["filings"]) == 2  # el DEF 14A no lleva lenguaje de resultados
    assert all(f["analizado"] is False for f in r["filings"])
    aviso = r["limitacion_transcripciones"]
    assert "NO se analizan" in aviso
    assert "de pago" in aviso


# --- El análisis y su fuente -------------------------------------------------


def test_el_analisis_enlaza_siempre_al_documento_de_la_sec(client):
    c, _, _ = client
    r = c.post("/api/earnings/AAPL/analizar", json={"comparar": False}).json()
    e = r["extraccion"]
    assert e["source_url"].startswith("https://www.sec.gov/Archives/")
    assert e["accession_no"] == "0000320193-26-000010"
    assert e["filed_at"] == "2026-02-01"
    assert e["generado_por"] == "ia"


def test_la_salida_tiene_los_campos_fijos_del_esquema(client):
    c, _, _ = client
    datos = c.post("/api/earnings/AAPL/analizar", json={"comparar": False}).json()["extraccion"]["datos"]
    assert set(datos) == {"resumen", "guidance", "riesgos", "temas", "menciona_guidance"}
    assert datos["guidance"][0]["metrica"] == "ingresos"


def test_una_cita_que_no_esta_en_el_documento_queda_marcada(client):
    """El riesgo inventado del doble: el análisis se sirve, pero señalado."""
    c, _, _ = client
    e = c.post("/api/earnings/AAPL/analizar", json={"comparar": False}).json()["extraccion"]
    riesgos = {r["tema"]: r["cita_verificada"] for r in e["datos"]["riesgos"]}
    assert riesgos["cadena de suministro"] is True
    assert riesgos["riesgo inventado"] is False
    assert e["verificacion"]["fallidas"] == 1
    assert "NO se encontraron" in e["verificacion"]["nota"]


def test_el_disclaimer_dice_que_no_es_una_recomendacion(client):
    c, _, _ = client
    d = c.post("/api/earnings/AAPL/analizar", json={"comparar": False}).json()["disclaimer"]
    assert "NO una recomendación" in d
    assert "no tiene ningún campo donde quepa una" in d


# --- Comparación entre trimestres --------------------------------------------


def test_el_primer_trimestre_no_finge_una_comparacion(client):
    """Fingir un cambio necesita dos puntos."""
    c, _, _ = client
    r = c.post("/api/earnings/AAPL/analizar", json={}).json()
    assert r["comparacion"]["disponible"] is False
    assert "no tiene contra qué compararse" in r["comparacion"]["nota"]


def test_con_dos_trimestres_se_compara_y_se_calculan_las_variaciones(client):
    c, _, llm = client
    c.post("/api/earnings/AAPL/analizar",
           json={"accession_no": "0000320193-25-000090", "comparar": False})
    r = c.post("/api/earnings/AAPL/analizar",
               json={"accession_no": "0000320193-26-000010"}).json()

    comp = r["comparacion"]
    assert comp["disponible"] is True
    assert comp["contra"]["accession_no"] == "0000320193-25-000090"
    assert comp["contra"]["source_url"].startswith("https://www.sec.gov/Archives/")
    # La variación numérica la calcula Python, no el modelo.
    v = comp["datos"]["variaciones_calculadas"][0]
    assert v["direccion"] == "sube"
    # Puntos medios 1,125 -> 1,225: +8,89 %. Los rangos se comparan por su
    # centro, no por su extremo bajo.
    assert v["variacion_pct"] == pytest.approx(8.89, abs=0.01)


def test_la_comparacion_no_vuelve_a_descargar_ni_releer_documentos(client):
    """Recibe los dos JSON, no los dos documentos: cuesta una fracción."""
    c, service, llm = client
    c.post("/api/earnings/AAPL/analizar",
           json={"accession_no": "0000320193-25-000090", "comparar": False})
    descargas = service.llamadas["filing_document"]
    extracciones = llm.extracciones

    c.post("/api/earnings/AAPL/analizar", json={"accession_no": "0000320193-26-000010"})
    # Una descarga más (el trimestre nuevo) y dos llamadas al modelo:
    # extracción del nuevo + comparación. La comparación no descarga nada.
    assert service.llamadas["filing_document"] == descargas + 1
    assert llm.extracciones == extracciones + 2


# --- La serie temporal -------------------------------------------------------


def test_un_filing_se_analiza_una_vez_para_que_haya_una_fila_por_trimestre(client):
    c, _, _ = client
    for _ in range(3):
        c.post("/api/earnings/AAPL/analizar", json={"comparar": False})
    h = c.get("/api/earnings/AAPL").json()
    assert h["trimestres"] == 1


def test_el_historial_arma_la_serie_de_guidance_en_el_tiempo(client):
    """El motivo de que el esquema sea fijo: con campos que cambian cada
    trimestre esto no se puede construir."""
    c, _, _ = client
    c.post("/api/earnings/AAPL/analizar",
           json={"accession_no": "0000320193-25-000090", "comparar": False})
    c.post("/api/earnings/AAPL/analizar",
           json={"accession_no": "0000320193-26-000010", "comparar": False})

    h = c.get("/api/earnings/AAPL").json()
    assert h["trimestres"] == 2
    serie = h["serie_guidance"]
    assert len(serie) == 1
    puntos = serie[0]["puntos"]
    assert [p["filed_at"] for p in puntos] == ["2025-11-01", "2026-02-01"]  # cronológico
    assert all(p["source_url"].startswith("https://www.sec.gov/") for p in puntos)


def test_sin_analisis_el_historial_lo_dice_en_vez_de_devolver_vacio(client):
    c, _, _ = client
    h = c.get("/api/earnings/MSFT").json()
    assert h["trimestres"] == 0
    assert "Todavía no hay" in h["nota"]


# --- Fallos ------------------------------------------------------------------


def test_si_el_modelo_no_esta_disponible_se_dice_con_503(client):
    c, _, llm = client
    llm.fallar = True
    r = c.post("/api/earnings/AAPL/analizar", json={"comparar": False})
    assert r.status_code == 503
    assert "no disponible" in r.json()["detail"]


def test_un_filing_inexistente_da_404(client):
    c, _, _ = client
    r = c.post("/api/earnings/AAPL/analizar", json={"accession_no": "no-existe"})
    assert r.status_code == 404


def test_un_simbolo_invalido_se_rechaza(client):
    c, _, _ = client
    assert c.get("/api/earnings/../etc/disponibles").status_code in (404, 422)
