"""Análisis automático de reportes trimestrales (10-Q, 10-K, 8-K).

## Qué se puede analizar de verdad, y qué no

Las **transcripciones de earnings calls no están disponibles** con las fuentes
gratuitas de esta app. El endpoint de transcripciones de Finnhub es de pago y la
SEC no las publica: la llamada es un acto voluntario de la empresa, no un
documento registrado. Así que no se analizan, y se dice, en vez de sustituirlas
en silencio por otra cosa y dejar que el rótulo «earnings call» sugiera algo que
no ha pasado.

Lo que sí llega, gratis y completo, desde EDGAR:

- **10-Q y 10-K** — el MD&A es donde la dirección explica el trimestre con sus
  propias palabras, y los factores de riesgo son la lista que sus abogados
  consideran material. Es el mismo lenguaje de la dirección que se compara entre
  trimestres.
- **8-K** — el comunicado de resultados viaja como anexo y suele traer el
  guidance con cifras, que en el 10-Q solo aparece en prosa.

## Reglas de la casa que este módulo respeta

- **El LLM nunca se llama solo.** Cada análisis es un botón que alguien pulsa, y
  antes de pulsarlo se enseña cuántos tokens va a costar.
- **Se extrae, no se recomienda.** El esquema no tiene dónde poner una
  recomendación (ver `llm/earnings_llm.py`).
- **Todo enlaza a su fuente.** Cada análisis guarda el número de acceso de la SEC
  y la URL del documento, y cada dato dentro lleva la cita que lo respalda,
  verificada contra el texto original.
"""

from __future__ import annotations

import re

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.analysis.filing_text import (
    LIMITE_CARACTERES,
    cabe_en_presupuesto,
    extraer_secciones,
)
from app.cache.cache import MarketDataService
from app.db.engine import get_session
from app.db.models import EarningsAnalysis
from app.deps import get_llm, get_service
from app.llm.base import LLMProvider, LLMUnavailableError
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
from app.providers.base import DataNotFoundError
from app.providers.router import AllProvidersFailedError

router = APIRouter(prefix="/api/earnings", tags=["earnings"])

_SYMBOL_RE = re.compile(r"^[A-Za-z0-9.\-]{1,12}$")

# Formularios que traen lenguaje de la dirección. El 10-K entra porque el cuarto
# trimestre no tiene 10-Q: la comparación se rompería justo una vez al año.
FORMULARIOS = ("10-Q", "10-K", "8-K")

# Precio del API de Claude por millón de tokens (Opus 5), para poder enseñar el
# coste ANTES de gastarlo. Si cambia la tarifa, se cambia aquí.
USD_POR_MTOK_ENTRADA = 5.0
USD_POR_MTOK_SALIDA = 25.0


class AnalizarRequest(BaseModel):
    accession_no: str | None = Field(
        None, description="Filing concreto; por defecto, el más reciente sin analizar"
    )
    comparar: bool = Field(True, description="Comparar con el trimestre anterior ya analizado")


def _validar(symbol: str) -> str:
    if not _SYMBOL_RE.match(symbol):
        raise HTTPException(status_code=422, detail=f"Símbolo inválido: {symbol}")
    return symbol.upper()


def _filings_de_resultados(service: MarketDataService, symbol: str) -> list[dict]:
    """Los filings con lenguaje de la dirección, del más reciente al más viejo."""
    try:
        payload = service.get("filings", symbol=symbol)
    except (DataNotFoundError, AllProvidersFailedError) as exc:
        raise HTTPException(
            status_code=404,
            detail=(
                f"No hay filings de la SEC para {symbol}: {exc}. Las empresas no "
                "estadounidenses y los ETFs no presentan 10-Q."
            ),
        ) from None
    filings = [f for f in payload.get("filings") or [] if f.get("type") in FORMULARIOS]
    return sorted(filings, key=lambda f: f.get("filed_at") or "", reverse=True)


def _preparar(service: MarketDataService, symbol: str, filing: dict) -> dict:
    """Descarga el documento y localiza sus secciones. Sin llamar al modelo."""
    try:
        doc = service.get("filing_document", url=filing["url"])
    except (DataNotFoundError, AllProvidersFailedError) as exc:
        raise HTTPException(
            status_code=502, detail=f"No se pudo descargar el documento: {exc}"
        ) from None

    secciones = extraer_secciones(doc["html"], filing["type"])
    if not secciones["secciones"]:
        raise HTTPException(
            status_code=422,
            detail=(
                f"No se localizó ninguna sección analizable en este {filing['type']}. "
                f"Faltan: {', '.join(secciones['faltan']) or 'todas'}. El documento "
                "está en {url} por si quieres leerlo a mano.".format(url=filing["url"])
            ),
        )
    return {"documento": doc, "secciones": secciones, "filing": filing}


def _coste_estimado(entrada: int | None, salida: int = 4000) -> dict:
    if entrada is None:
        return {
            "tokens_entrada": None,
            "usd_estimado": None,
            "nota": "No se pudo contar los tokens; el coste no se puede estimar de antemano.",
        }
    usd = entrada / 1e6 * USD_POR_MTOK_ENTRADA + salida / 1e6 * USD_POR_MTOK_SALIDA
    return {
        "tokens_entrada": entrada,
        "usd_estimado": round(usd, 4),
        "nota": (
            f"~{entrada:,} tokens de entrada. Estimación a la tarifa de Opus 5 "
            f"({USD_POR_MTOK_ENTRADA} $/M entrada, {USD_POR_MTOK_SALIDA} $/M salida), "
            f"asumiendo ~{salida:,} tokens de salida."
        ),
    }


def _guardar(session: Session, **campos) -> EarningsAnalysis:
    """Un filing se analiza una vez: la SEC no reescribe documentos.

    Si ya existe un análisis de ese número de acceso se actualiza en vez de
    duplicarse, para que la serie temporal tenga una fila por trimestre.
    """
    existente = session.execute(
        select(EarningsAnalysis).where(
            EarningsAnalysis.accession_no == campos["accession_no"],
            EarningsAnalysis.kind == campos["kind"],
        )
    ).scalar_one_or_none()
    if existente is not None:
        for k, v in campos.items():
            setattr(existente, k, v)
        session.commit()
        return existente
    registro = EarningsAnalysis(**campos)
    session.add(registro)
    session.commit()
    return registro


def _serializar(r: EarningsAnalysis) -> dict:
    return {
        "id": r.id,
        "symbol": r.symbol,
        "kind": r.kind,
        "form_type": r.form_type,
        "accession_no": r.accession_no,
        "source_url": r.source_url,
        "filed_at": r.filed_at,
        "datos": r.datos,
        "verificacion": r.verificacion,
        "model": r.model,
        "usage": r.usage,
        "created_at": r.created_at.isoformat(),
        "generado_por": "ia",
    }


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/{symbol}/disponibles")
def listar_disponibles(
    symbol: str,
    session: Session = Depends(get_session),
    service: MarketDataService = Depends(get_service),
    limite: int = Query(8, ge=1, le=20),
):
    """Qué reportes hay, cuáles están ya analizados y qué NO se puede analizar."""
    symbol = _validar(symbol)
    filings = _filings_de_resultados(service, symbol)[:limite]
    analizados = {
        r.accession_no
        for r in session.execute(
            select(EarningsAnalysis).where(
                EarningsAnalysis.symbol == symbol,
                EarningsAnalysis.kind == "extraccion",
            )
        ).scalars()
    }
    return {
        "symbol": symbol,
        "filings": [
            {**f, "analizado": f["accession_no"] in analizados} for f in filings
        ],
        "limitacion_transcripciones": (
            "Las transcripciones de earnings calls NO se analizan: el endpoint de "
            "transcripciones de Finnhub es de pago y la SEC no las publica, porque "
            "la llamada es un acto voluntario de la empresa y no un documento "
            "registrado. Lo que sí se analiza es el lenguaje de la dirección en el "
            "MD&A del 10-Q/10-K y el guidance del comunicado de resultados (8-K), "
            "que llegan completos y gratis desde EDGAR."
        ),
    }


@router.get("/{symbol}/coste")
def estimar_coste(
    symbol: str,
    accession_no: str | None = None,
    service: MarketDataService = Depends(get_service),
    llm: LLMProvider = Depends(get_llm),
):
    """Cuánto costaría analizar este reporte. Sin llamar al modelo.

    Existe porque el LLM de esta app se llama solo cuando alguien lo pide, y
    pedirlo a ciegas no es pedirlo: un 10-Q largo cuesta bastante más que uno
    corto y eso hay que saberlo antes, no en la factura.
    """
    symbol = _validar(symbol)
    filings = _filings_de_resultados(service, symbol)
    filing = _elegir(filings, accession_no)
    preparado = _preparar(service, symbol, filing)
    secciones = preparado["secciones"]
    presupuesto = cabe_en_presupuesto(secciones["caracteres_totales"])

    prompt = prompt_extraccion(
        symbol, filing["type"], filing["filed_at"], filing["url"], secciones["secciones"]
    )
    return {
        "symbol": symbol,
        "filing": filing,
        "secciones": {
            k: {"etiqueta": v["etiqueta"], "caracteres": v["caracteres"]}
            for k, v in secciones["secciones"].items()
        },
        "secciones_ausentes": secciones["faltan"],
        "presupuesto": presupuesto,
        "coste": _coste_estimado(llm.contar_tokens(SYSTEM, prompt)),
    }


def _elegir(filings: list[dict], accession_no: str | None) -> dict:
    if not filings:
        raise HTTPException(
            status_code=404, detail="No hay reportes trimestrales para esta empresa"
        )
    if accession_no is None:
        return filings[0]
    for f in filings:
        if f["accession_no"] == accession_no:
            return f
    raise HTTPException(status_code=404, detail=f"Filing no encontrado: {accession_no}")


@router.post("/{symbol}/analizar")
def analizar(
    symbol: str,
    request: AnalizarRequest = Body(default_factory=AnalizarRequest),
    session: Session = Depends(get_session),
    service: MarketDataService = Depends(get_service),
    llm: LLMProvider = Depends(get_llm),
):
    """Extrae guidance, riesgos y temas de un reporte, y lo compara con el anterior.

    Dos llamadas al modelo como mucho: una lee el documento, otra compara los dos
    JSON (no los dos documentos). La segunda cuesta una fracción de la primera y
    es auditable, porque sus entradas quedan guardadas.
    """
    symbol = _validar(symbol)
    filings = _filings_de_resultados(service, symbol)
    filing = _elegir(filings, request.accession_no)
    preparado = _preparar(service, symbol, filing)
    secciones = preparado["secciones"]

    presupuesto = cabe_en_presupuesto(secciones["caracteres_totales"])
    if not presupuesto["cabe"]:
        raise HTTPException(
            status_code=413,
            detail=(
                presupuesto["nota"]
                + " Analiza el 8-K del mismo trimestre, que es mucho más corto y "
                "suele traer el guidance con cifras."
            ),
        )

    texto_fuente = "\n\n".join(
        s["texto"] for s in secciones["secciones"].values()
    )
    prompt = prompt_extraccion(
        symbol, filing["type"], filing["filed_at"], filing["url"], secciones["secciones"]
    )

    try:
        resultado = llm.extract(SYSTEM, prompt, AnalisisTrimestre)
    except LLMUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from None

    datos = resultado["data"]
    verificacion = verificar_citas(datos, texto_fuente)

    registro = _guardar(
        session,
        symbol=symbol,
        kind="extraccion",
        form_type=filing["type"],
        accession_no=filing["accession_no"],
        source_url=filing["url"],
        filed_at=filing["filed_at"],
        doc_hash=hash_documento(texto_fuente),
        datos=datos,
        verificacion=verificacion,
        model=resultado["model"],
        usage=resultado.get("usage"),
    )

    salida = {
        "extraccion": _serializar(registro),
        "secciones_analizadas": list(secciones["secciones"]),
        "secciones_ausentes": secciones["faltan"],
        "comparacion": None,
        "disclaimer": (
            "Extraído por IA de un documento registrado en la SEC, enlazado arriba. "
            "Son hechos y cambios citados del documento, NO una recomendación: el "
            "esquema de salida no tiene ningún campo donde quepa una. Cada dato "
            "lleva la cita que lo respalda y esa cita se ha buscado en el texto "
            "original; las que no aparecieron están marcadas."
        ),
    }

    if request.comparar:
        salida["comparacion"] = _comparar_con_anterior(session, llm, symbol, registro)
    return salida


def _comparar_con_anterior(
    session: Session, llm: LLMProvider, symbol: str, actual: EarningsAnalysis
) -> dict | None:
    """Compara con el reporte analizado inmediatamente anterior, si lo hay."""
    anterior = session.execute(
        select(EarningsAnalysis)
        .where(
            EarningsAnalysis.symbol == symbol,
            EarningsAnalysis.kind == "extraccion",
            EarningsAnalysis.filed_at < actual.filed_at,
        )
        .order_by(EarningsAnalysis.filed_at.desc())
    ).scalars().first()

    if anterior is None:
        return {
            "disponible": False,
            "nota": (
                "No hay ningún trimestre anterior analizado con el que comparar. "
                "Analiza el reporte previo y la comparación aparecerá sola: el "
                "primer trimestre de una serie no tiene contra qué compararse, y "
                "fingir un cambio necesita dos puntos."
            ),
        }

    prompt = prompt_comparacion(
        anterior.datos,
        actual.datos,
        {"tipo": anterior.form_type, "fecha": anterior.filed_at},
        {"tipo": actual.form_type, "fecha": actual.filed_at},
    )
    try:
        resultado = llm.extract(SYSTEM, prompt, Comparacion)
    except LLMUnavailableError as exc:
        return {"disponible": False, "nota": f"No se pudo comparar: {exc}"}

    datos = dict(resultado["data"])
    # La aritmética la hace Python: cuando los dos trimestres dan cifras para la
    # misma métrica, la variación no se le pregunta a nadie.
    datos["variaciones_calculadas"] = variaciones_numericas(anterior.datos, actual.datos)

    registro = _guardar(
        session,
        symbol=symbol,
        kind="comparacion",
        form_type=actual.form_type,
        accession_no=actual.accession_no,
        source_url=actual.source_url,
        filed_at=actual.filed_at,
        doc_hash=actual.doc_hash,
        datos=datos,
        verificacion=None,
        model=resultado["model"],
        usage=resultado.get("usage"),
    )
    return {
        "disponible": True,
        **_serializar(registro),
        "contra": {
            "accession_no": anterior.accession_no,
            "form_type": anterior.form_type,
            "filed_at": anterior.filed_at,
            "source_url": anterior.source_url,
        },
        "nota": (
            "La comparación se hace sobre los dos JSON extraídos, no sobre los dos "
            "documentos: es más barata y, sobre todo, auditable — sus entradas "
            "están guardadas y se pueden volver a leer. Las variaciones numéricas "
            "las calcula el código, no el modelo."
        ),
    }


@router.get("/{symbol}")
def historial(symbol: str, session: Session = Depends(get_session)):
    """Todos los trimestres analizados, del más reciente al más antiguo.

    Misma forma cada trimestre: es lo que convierte una lista de análisis sueltos
    en una serie que se puede leer de arriba abajo.
    """
    symbol = _validar(symbol)
    filas = session.execute(
        select(EarningsAnalysis)
        .where(EarningsAnalysis.symbol == symbol)
        .order_by(EarningsAnalysis.filed_at.desc(), EarningsAnalysis.id.desc())
    ).scalars().all()

    extracciones = [_serializar(r) for r in filas if r.kind == "extraccion"]
    return {
        "symbol": symbol,
        "extracciones": extracciones,
        "comparaciones": [_serializar(r) for r in filas if r.kind == "comparacion"],
        "trimestres": len(extracciones),
        "serie_guidance": _serie_guidance(extracciones),
        "nota": (
            "Cada trimestre tiene exactamente los mismos campos, que es lo que "
            "permite leerlos como una serie en vez de como análisis sueltos."
            if extracciones
            else "Todavía no hay ningún reporte analizado para esta empresa."
        ),
    }


def _serie_guidance(extracciones: list[dict]) -> list[dict]:
    """El guidance de cada métrica a lo largo del tiempo, listo para una tabla.

    Es el motivo de que el esquema sea fijo: con campos que cambian cada
    trimestre esto no se puede construir, y sin esto un análisis por trimestre no
    es una serie, son informes sueltos que hay que leer uno a uno.
    """
    por_metrica: dict[tuple[str, str], list[dict]] = {}
    for e in reversed(extracciones):  # cronológico
        for g in (e["datos"].get("guidance") or []):
            clave = (g.get("metrica", "").strip(), g.get("periodo", "").strip())
            if not clave[0]:
                continue
            por_metrica.setdefault(clave, []).append(
                {
                    "filed_at": e["filed_at"],
                    "form_type": e["form_type"],
                    "source_url": e["source_url"],
                    "valor_bajo": g.get("valor_bajo"),
                    "valor_alto": g.get("valor_alto"),
                    "unidad": g.get("unidad"),
                    "texto_literal": g.get("texto_literal"),
                    "cita_verificada": g.get("cita_verificada"),
                }
            )
    return [
        {"metrica": m, "periodo": p, "puntos": puntos}
        for (m, p), puntos in sorted(por_metrica.items())
        if len(puntos) >= 1
    ]
