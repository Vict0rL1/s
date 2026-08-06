"""Screener con filtros combinables y presets documentados (Fase 4).

Restricción de coste: un screener que barre miles de tickers es imposible
con tiers gratuitos. Este screener evalúa un universo que TÚ defines (tu
watchlist, los pares de una empresa, una lista pegada), usando fundamentales
cacheados 24 h. Es honesto sobre esa limitación en vez de fingir cobertura
total.
"""

from __future__ import annotations

import re

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.analysis.screener import DEFAULT_PRESETS, evaluate_filters
from app.cache.cache import MarketDataService
from app.db.engine import get_session
from app.db.models import ScreenerPreset
from app.deps import get_service
from app.providers.base import DataNotFoundError
from app.providers.router import AllProvidersFailedError

router = APIRouter(prefix="/api/screener", tags=["screener"])

_SYMBOL_RE = re.compile(r"^[A-Za-z0-9.\-]{1,12}$")
MAX_UNIVERSE = 25  # tope de seguridad: 25 símbolos = máx. 25 llamadas nuevas


class FilterSpec(BaseModel):
    op: str = Field(pattern="^(gte|lte)$")
    value: float


class ScreenRequest(BaseModel):
    symbols: list[str] = Field(min_length=1, max_length=MAX_UNIVERSE)
    filters: dict[str, FilterSpec] = Field(default_factory=dict)


class PresetCreate(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    logic_md: str | None = None
    filters: dict[str, FilterSpec]


@router.get("/presets")
def list_presets(session: Session = Depends(get_session)):
    """Presets integrados + los que hayas guardado. Cada uno con su lógica."""
    saved = session.execute(select(ScreenerPreset)).scalars().all()
    return {
        "builtin": DEFAULT_PRESETS,
        "saved": [
            {
                "id": p.id,
                "name": p.name,
                "logic_md": p.logic_md,
                "filters": p.filters,
                "created_at": p.created_at.isoformat(),
            }
            for p in saved
        ],
    }


@router.post("/presets")
def create_preset(preset: PresetCreate, session: Session = Depends(get_session)):
    existing = session.execute(
        select(ScreenerPreset).where(ScreenerPreset.name == preset.name)
    ).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(status_code=409, detail=f"Ya existe un preset «{preset.name}»")
    record = ScreenerPreset(
        name=preset.name,
        logic_md=preset.logic_md,
        filters={k: v.model_dump() for k, v in preset.filters.items()},
    )
    session.add(record)
    session.commit()
    return {"id": record.id, "name": record.name}


@router.delete("/presets/{preset_id}")
def delete_preset(preset_id: int, session: Session = Depends(get_session)):
    record = session.get(ScreenerPreset, preset_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Preset no encontrado")
    session.delete(record)
    session.commit()
    return {"deleted": preset_id}


@router.post("/run")
def run_screen(
    request: ScreenRequest = Body(...),
    service: MarketDataService = Depends(get_service),
):
    """Evalúa el universo indicado. Cada resultado explica qué filtro falló."""
    symbols = []
    for raw in request.symbols:
        symbol = raw.strip().upper()
        if not _SYMBOL_RE.match(symbol):
            raise HTTPException(status_code=422, detail=f"Símbolo inválido: {raw}")
        if symbol not in symbols:
            symbols.append(symbol)

    filters = {k: v.model_dump() for k, v in request.filters.items()}
    rows, unavailable = [], []
    for symbol in symbols:
        try:
            fundamentals = service.get("fundamentals", symbol=symbol)
        except (DataNotFoundError, AllProvidersFailedError) as exc:
            unavailable.append({"symbol": symbol, "reason": str(exc)})
            continue
        result = evaluate_filters(fundamentals["metrics"], filters)
        rows.append(
            {
                "symbol": symbol,
                "passes": result["passes"],
                "checks": result["checks"],
                "metrics": fundamentals["metrics"],
                "source": fundamentals["source"],
                "cached": fundamentals.get("cached", False),
            }
        )

    rows.sort(key=lambda r: (not r["passes"], r["symbol"]))
    return {
        "results": rows,
        "unavailable": unavailable,
        "passed": sum(1 for r in rows if r["passes"]),
        "evaluated": len(rows),
        "note": (
            "El screener evalúa el universo que le das, no todo el mercado: los "
            "tiers gratuitos no permiten barridos masivos. Un dato ausente nunca "
            "aprueba su filtro."
        ),
    }
