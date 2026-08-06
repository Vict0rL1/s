"""ETFs: composición, solapamiento y comparador (Fase 4).

Coste de API: la composición se cachea 7 días (los ETFs rebalancean con muy
poca frecuencia), así que comparar los mismos ETFs repetidamente es gratis
después de la primera vez.
"""

from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException, Query

from app.analysis.etf import overlap_weight
from app.cache.cache import MarketDataService
from app.deps import get_service
from app.providers.base import DataNotFoundError
from app.providers.router import AllProvidersFailedError

router = APIRouter(prefix="/api/etfs", tags=["etfs"])

_SYMBOL_RE = re.compile(r"^[A-Za-z0-9.\-]{1,12}$")


def _validate(symbol: str) -> str:
    if not _SYMBOL_RE.match(symbol):
        raise HTTPException(status_code=422, detail=f"Símbolo inválido: {symbol}")
    return symbol.upper()


def _fetch_etf(service: MarketDataService, symbol: str) -> dict:
    try:
        return service.get("etf_data", symbol=symbol)
    except DataNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except AllProvidersFailedError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/{symbol}")
def get_etf(symbol: str, service: MarketDataService = Depends(get_service)):
    """Composición, expense ratio, AUM y desglose sectorial."""
    payload = _fetch_etf(service, _validate(symbol))
    payload["coverage_note"] = (
        "La fuente gratuita publica solo los mayores holdings; el desglose no "
        "suma 100 % y no es la cartera completa."
    )
    return payload


@router.get("/compare/side-by-side")
def compare_etfs(
    symbols: str = Query(..., description="Lista separada por comas, máx. 4"),
    service: MarketDataService = Depends(get_service),
):
    """Comparador lado a lado + matriz de solapamiento entre todos los pares."""
    requested = [_validate(s.strip()) for s in symbols.split(",") if s.strip()][:4]
    if len(requested) < 1:
        raise HTTPException(status_code=422, detail="Indica al menos un ETF")

    etfs = []
    errors = {}
    for symbol in requested:
        try:
            etfs.append(_fetch_etf(service, symbol))
        except HTTPException as exc:
            errors[symbol] = exc.detail

    overlaps = []
    for i, a in enumerate(etfs):
        for b in etfs[i + 1 :]:
            result = overlap_weight(a.get("top_holdings") or [], b.get("top_holdings") or [])
            overlaps.append({"a": a["symbol"], "b": b["symbol"], **result})
    overlaps.sort(key=lambda o: o["overlap_weight"], reverse=True)

    return {
        "etfs": etfs,
        "overlaps": overlaps,
        "errors": errors,
        "note": (
            "El solapamiento es una cota inferior: se calcula solo sobre los "
            "mayores holdings publicados. Dos ETFs con poco solapamiento aparente "
            "pueden compartir mucho más en la cola de la cartera."
        ),
    }
