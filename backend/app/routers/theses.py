"""Tesis, escenarios y registro de aciertos (Fase 5).

El núcleo del principio rector de la app: cada tesis se guarda con fecha,
supuestos y criterios de invalidación ("qué me haría cambiar de opinión"), y
cada escenario ancla el precio del día en que se creó. El registro de
aciertos compara después sin adornos.
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.analysis.track_record import (
    classify_scenario,
    days_elapsed,
    track_record_summary,
)
from app.cache.cache import MarketDataService
from app.db.engine import get_session
from app.db.models import Evaluation, Instrument, Scenario, Thesis
from app.deps import get_service
from app.providers.base import DataNotFoundError
from app.providers.router import AllProvidersFailedError
from app.routers.portfolio import get_or_create_instrument

router = APIRouter(prefix="/api/theses", tags=["theses"])


class ThesisCreate(BaseModel):
    symbol: str = Field(min_length=1, max_length=12)
    title: str = Field(min_length=1, max_length=256)
    body_md: str = Field(min_length=1)
    assumptions: dict | None = None
    invalidation_criteria: str | None = Field(
        None, description="Qué te haría cambiar de opinión"
    )


class ScenarioCreate(BaseModel):
    kind: str = Field(pattern="^(bear|base|bull)$")
    assumptions: dict
    value_low: float | None = None
    value_mid: float | None = None
    value_high: float | None = None


class EvaluationCreate(BaseModel):
    outcome_notes: str | None = None


def _price_of(service: MarketDataService, symbol: str) -> float | None:
    try:
        return service.get("quote", symbol=symbol).get("price")
    except (DataNotFoundError, AllProvidersFailedError):
        return None


@router.post("")
def create_thesis(
    body: ThesisCreate,
    session: Session = Depends(get_session),
    service: MarketDataService = Depends(get_service),
):
    instrument = get_or_create_instrument(session, body.symbol, service)
    thesis = Thesis(
        instrument_id=instrument.id,
        title=body.title,
        body_md=body.body_md,
        assumptions=body.assumptions,
        invalidation_criteria=body.invalidation_criteria,
    )
    session.add(thesis)
    session.commit()
    return {"id": thesis.id, "symbol": instrument.symbol, "created_at": thesis.created_at.isoformat()}


@router.get("")
def list_theses(
    session: Session = Depends(get_session),
    service: MarketDataService = Depends(get_service),
):
    """Todas las tesis con sus escenarios evaluados contra el precio actual."""
    rows = session.execute(
        select(Thesis, Instrument).join(Instrument, Thesis.instrument_id == Instrument.id)
    ).all()

    prices: dict[str, float | None] = {}
    out = []
    for thesis, instrument in rows:
        if instrument.symbol not in prices:
            prices[instrument.symbol] = _price_of(service, instrument.symbol)
        price = prices[instrument.symbol]

        scenarios = session.execute(
            select(Scenario).where(Scenario.thesis_id == thesis.id)
        ).scalars().all()
        evaluated = []
        for scenario in scenarios:
            payload = {
                "id": scenario.id,
                "kind": scenario.kind,
                "assumptions": scenario.assumptions,
                "value_low": scenario.value_low,
                "value_mid": scenario.value_mid,
                "value_high": scenario.value_high,
                "price_at_creation": scenario.price_at_creation,
                "created_at": scenario.created_at.isoformat(),
                "days_elapsed": days_elapsed(scenario.created_at),
            }
            payload.update(
                classify_scenario(
                    {
                        "price_at_creation": scenario.price_at_creation,
                        "value_mid": scenario.value_mid,
                    },
                    price,
                )
            )
            evaluated.append(payload)

        out.append(
            {
                "id": thesis.id,
                "symbol": instrument.symbol,
                "title": thesis.title,
                "body_md": thesis.body_md,
                "assumptions": thesis.assumptions,
                "invalidation_criteria": thesis.invalidation_criteria,
                "created_at": thesis.created_at.isoformat(),
                "days_elapsed": days_elapsed(thesis.created_at),
                "current_price": price,
                "scenarios": evaluated,
            }
        )
    out.sort(key=lambda t: t["created_at"], reverse=True)
    return {"theses": out}


@router.delete("/{thesis_id}")
def delete_thesis(thesis_id: int, session: Session = Depends(get_session)):
    thesis = session.get(Thesis, thesis_id)
    if thesis is None:
        raise HTTPException(status_code=404, detail="Tesis no encontrada")
    for scenario in session.execute(
        select(Scenario).where(Scenario.thesis_id == thesis_id)
    ).scalars().all():
        session.delete(scenario)
    session.delete(thesis)
    session.commit()
    return {"deleted": thesis_id}


@router.post("/{thesis_id}/scenarios")
def add_scenario(
    thesis_id: int,
    body: ScenarioCreate,
    session: Session = Depends(get_session),
    service: MarketDataService = Depends(get_service),
):
    """Guarda un escenario anclando el precio de HOY.

    Sin ese ancla el registro de aciertos no puede evaluarse después, así que
    se captura en el momento de crear el escenario, no al evaluarlo.
    """
    thesis = session.get(Thesis, thesis_id)
    if thesis is None:
        raise HTTPException(status_code=404, detail="Tesis no encontrada")
    instrument = session.get(Instrument, thesis.instrument_id)
    price = _price_of(service, instrument.symbol) if instrument else None

    scenario = Scenario(
        thesis_id=thesis.id,
        instrument_id=thesis.instrument_id,
        kind=body.kind,
        assumptions=body.assumptions,
        value_low=body.value_low,
        value_mid=body.value_mid,
        value_high=body.value_high,
        price_at_creation=price,
    )
    session.add(scenario)
    session.commit()
    return {
        "id": scenario.id,
        "price_at_creation": price,
        "warning": None if price is not None else (
            "No se pudo anclar el precio actual: este escenario no será "
            "evaluable en el registro de aciertos."
        ),
    }


@router.post("/{thesis_id}/evaluate")
def evaluate_thesis(
    thesis_id: int,
    body: EvaluationCreate,
    session: Session = Depends(get_session),
    service: MarketDataService = Depends(get_service),
):
    """Registra una evaluación puntual de la tesis con el precio de hoy."""
    thesis = session.get(Thesis, thesis_id)
    if thesis is None:
        raise HTTPException(status_code=404, detail="Tesis no encontrada")
    instrument = session.get(Instrument, thesis.instrument_id)
    price = _price_of(service, instrument.symbol) if instrument else None

    evaluation = Evaluation(
        thesis_id=thesis.id,
        price_at_evaluation=price,
        outcome_notes=body.outcome_notes,
        evaluated_at=datetime.now(timezone.utc),
    )
    session.add(evaluation)
    session.commit()
    return {"id": evaluation.id, "price_at_evaluation": price}


@router.get("/track-record")
def get_track_record(
    session: Session = Depends(get_session),
    service: MarketDataService = Depends(get_service),
):
    """Resumen honesto de cómo envejecieron todos los escenarios guardados."""
    rows = session.execute(
        select(Scenario, Instrument).join(Instrument, Scenario.instrument_id == Instrument.id)
    ).all()

    prices: dict[str, float | None] = {}
    evaluated = []
    for scenario, instrument in rows:
        if instrument.symbol not in prices:
            prices[instrument.symbol] = _price_of(service, instrument.symbol)
        result = classify_scenario(
            {
                "price_at_creation": scenario.price_at_creation,
                "value_mid": scenario.value_mid,
            },
            prices[instrument.symbol],
        )
        evaluated.append(
            {
                "scenario_id": scenario.id,
                "thesis_id": scenario.thesis_id,
                "symbol": instrument.symbol,
                "kind": scenario.kind,
                "created_at": scenario.created_at.isoformat(),
                "days_elapsed": days_elapsed(scenario.created_at),
                "price_at_creation": scenario.price_at_creation,
                "current_price": prices[instrument.symbol],
                "value_mid": scenario.value_mid,
                **result,
            }
        )
    evaluated.sort(key=lambda e: e["created_at"], reverse=True)
    return {"scenarios": evaluated, "summary": track_record_summary(evaluated)}
