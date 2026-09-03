"""Noticias e interpretación por IA (Fase 3).

El feed viene de Finnhub (cacheado 15 min). La interpretación LLM solo se
ejecuta cuando el usuario pulsa el botón, se guarda en llm_outputs con hash
del prompt (repetir la misma consulta no gasta API de Anthropic) y siempre
viaja etiquetada como generada por IA.
"""

from __future__ import annotations

import hashlib

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.cache.cache import MarketDataService
from app.db.engine import get_session
from app.db.models import LlmOutput
from app.deps import get_llm, get_service
from app.llm.base import LLMProvider, LLMUnavailableError
from app.providers.base import DataNotFoundError
from app.providers.router import AllProvidersFailedError

router = APIRouter(prefix="/api/news", tags=["news"])

INTERPRET_SYSTEM = """Eres el asistente de análisis de una app personal de \
investigación bursátil de un estudiante de finanzas. Tu tarea: explicar por qué \
una noticia puede importar para una tesis de inversión.

Reglas estrictas:
- NUNCA des recomendaciones de compra o venta ni precios objetivo.
- Distingue explícitamente hechos reportados de especulación o interpretación.
- Señala qué habría que verificar en fuentes primarias (filings, resultados).
- Máximo ~150 palabras, en español, en Markdown sencillo (sin encabezados).
- Si la noticia es irrelevante para invertir, dilo sin rellenar."""


class InterpretRequest(BaseModel):
    headline: str
    summary: str | None = None
    symbol: str | None = None


@router.get("")
def get_news(
    symbol: str | None = Query(None, max_length=12),
    days: int = Query(7, ge=1, le=30),
    service: MarketDataService = Depends(get_service),
):
    try:
        payload = service.get(
            "news", symbol=symbol.upper() if symbol else None, days=days
        )
    except DataNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except AllProvidersFailedError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return payload


@router.post("/interpret")
def interpret_news(
    request: InterpretRequest,
    llm: LLMProvider | None = Depends(get_llm),
    session: Session = Depends(get_session),
):
    """Interpretación bajo demanda, con caché permanente por prompt."""
    prompt = (
        f"Ticker relacionado: {request.symbol or 'ninguno'}\n"
        f"Titular: {request.headline}\n"
        f"Resumen: {request.summary or '(sin resumen)'}\n\n"
        "¿Por qué podría importar (o no) esta noticia para una tesis de inversión?"
    )
    model_name = llm.model if llm and hasattr(llm, "model") else "?"
    prompt_hash = hashlib.sha256(f"{model_name}|{prompt}".encode()).hexdigest()[:48]

    cached = session.execute(
        select(LlmOutput).where(LlmOutput.prompt_hash == prompt_hash)
    ).scalar_one_or_none()
    if cached is not None:
        return _interpretation_response(cached.content_md, cached.model, cached.created_at, True)

    if llm is None:
        raise HTTPException(
            status_code=503,
            detail="Capa de IA no configurada: añade ANTHROPIC_API_KEY en .env",
        )
    try:
        result = llm.interpret(INTERPRET_SYSTEM, prompt)
    except LLMUnavailableError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    record = LlmOutput(
        kind="news_interpretation",
        prompt_hash=prompt_hash,
        content_md=result["content"],
        model=result["model"],
    )
    session.add(record)
    session.commit()
    return _interpretation_response(result["content"], result["model"], record.created_at, False)


def _interpretation_response(content_md, model, created_at, cached: bool) -> dict:
    return {
        "generated_by": "llm",  # la UI DEBE marcarlo visualmente como IA
        "content_md": content_md,
        "model": model,
        "created_at": created_at.isoformat() if created_at else None,
        "cached": cached,
        "disclaimer": (
            "Interpretación generada por IA a partir del titular y resumen; "
            "puede contener errores. No es asesoría financiera."
        ),
    }
