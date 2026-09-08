from __future__ import annotations

from fastapi import APIRouter, Depends

from app.config import PROVIDER_RATE_LIMITS, settings
from app.deps import get_llm, get_service
from app.schemas.market import LlmStatus, ProviderUsage

router = APIRouter(prefix="/api/meta", tags=["meta"])

# Alpha Vantage no aparece: con 25 llamadas/día no se usa por defecto
# (decisión de ahorro de créditos; ver README).
_ACTIVE = ["finnhub", "twelvedata", "edgar", "fred", "yfinance"]

_KEY_BY_PROVIDER = {
    "finnhub": lambda: bool(settings.finnhub_api_key),
    "twelvedata": lambda: bool(settings.twelvedata_api_key),
    "edgar": lambda: bool(settings.edgar_user_agent),
    "fred": lambda: bool(settings.fred_api_key),
    "yfinance": lambda: True,  # respaldo sin key
}


@router.get("/usage", response_model=list[ProviderUsage])
def api_usage(service=Depends(get_service)):
    """Contador visible de llamadas restantes por API en la ventana vigente."""
    out = []
    for name in _ACTIVE:
        usage = service.router.limiter.usage(name)
        usage["configured"] = _KEY_BY_PROVIDER[name]()
        out.append(usage)
    return out


@router.get("/llm", response_model=LlmStatus)
def llm_status(llm=Depends(get_llm)):
    """Si la capa de IA está activa y con qué modelo.

    No lleva contador de llamadas como el resto: Anthropic se factura por
    tokens consumidos, no contra una cuota gratuita, así que el dato útil
    aquí es si la key está puesta, no cuánto queda.
    """
    return LlmStatus(
        configured=llm is not None,
        model=settings.anthropic_model if llm is not None else None,
    )


@router.get("/health")
def health():
    return {"status": "ok"}
