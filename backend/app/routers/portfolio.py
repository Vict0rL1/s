"""Watchlist, portafolio y alertas (Fase 5). Todo local, todo tuyo."""

from __future__ import annotations

import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.analysis.portfolio import (
    allocation_weights,
    concentration_warning,
    portfolio_summary,
    position_metrics,
    realized_pnl,
)
from app.cache.cache import MarketDataService
from app.db.engine import get_session
from app.db.models import Alert, Instrument, Position, Watchlist, WatchlistItem
from app.deps import get_service
from app.providers.base import DataNotFoundError
from app.providers.router import AllProvidersFailedError

router = APIRouter(prefix="/api/portfolio", tags=["portfolio"])
watchlist_router = APIRouter(prefix="/api/watchlist", tags=["watchlist"])

_SYMBOL_RE = re.compile(r"^[A-Za-z0-9.\-]{1,12}$")


def _validate(symbol: str) -> str:
    if not _SYMBOL_RE.match(symbol):
        raise HTTPException(status_code=422, detail=f"Símbolo inválido: {symbol}")
    return symbol.upper()


def get_or_create_instrument(session: Session, symbol: str, service=None) -> Instrument:
    """Busca el instrumento; si no existe lo crea, enriqueciéndolo con el
    perfil si está en caché o disponible (sin romper si la API falla)."""
    symbol = _validate(symbol)
    instrument = session.execute(
        select(Instrument).where(Instrument.symbol == symbol)
    ).scalar_one_or_none()
    if instrument is not None:
        return instrument

    name = sector = None
    if service is not None:
        try:
            profile = service.get("profile", symbol=symbol)
            name, sector = profile.get("name"), profile.get("sector")
        except (DataNotFoundError, AllProvidersFailedError):
            pass
    instrument = Instrument(symbol=symbol, name=name, sector=sector)
    session.add(instrument)
    session.commit()
    return instrument


def _price_of(service: MarketDataService, symbol: str) -> float | None:
    try:
        return service.get("quote", symbol=symbol).get("price")
    except (DataNotFoundError, AllProvidersFailedError):
        return None


# ---------------------------------------------------------------------------
# Watchlist
# ---------------------------------------------------------------------------


class WatchlistAdd(BaseModel):
    symbol: str = Field(min_length=1, max_length=12)
    notes: str | None = None


def _default_watchlist(session: Session) -> Watchlist:
    watchlist = session.execute(
        select(Watchlist).where(Watchlist.name == "Principal")
    ).scalar_one_or_none()
    if watchlist is None:
        watchlist = Watchlist(name="Principal")
        session.add(watchlist)
        session.commit()
    return watchlist


@watchlist_router.get("")
def get_watchlist(
    session: Session = Depends(get_session),
    service: MarketDataService = Depends(get_service),
):
    watchlist = _default_watchlist(session)
    items = session.execute(
        select(WatchlistItem, Instrument)
        .join(Instrument, WatchlistItem.instrument_id == Instrument.id)
        .where(WatchlistItem.watchlist_id == watchlist.id)
    ).all()
    rows = []
    for item, instrument in items:
        quote = None
        try:
            quote = service.get("quote", symbol=instrument.symbol)
        except (DataNotFoundError, AllProvidersFailedError):
            pass
        rows.append(
            {
                "id": item.id,
                "symbol": instrument.symbol,
                "name": instrument.name,
                "sector": instrument.sector,
                "notes": item.notes,
                "added_at": item.added_at.isoformat(),
                "quote": quote,
            }
        )
    return {"name": watchlist.name, "items": rows}


@watchlist_router.post("")
def add_to_watchlist(
    body: WatchlistAdd,
    session: Session = Depends(get_session),
    service: MarketDataService = Depends(get_service),
):
    watchlist = _default_watchlist(session)
    instrument = get_or_create_instrument(session, body.symbol, service)
    existing = session.execute(
        select(WatchlistItem).where(
            WatchlistItem.watchlist_id == watchlist.id,
            WatchlistItem.instrument_id == instrument.id,
        )
    ).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(status_code=409, detail=f"{instrument.symbol} ya está en la watchlist")
    item = WatchlistItem(
        watchlist_id=watchlist.id, instrument_id=instrument.id, notes=body.notes
    )
    session.add(item)
    session.commit()
    return {"id": item.id, "symbol": instrument.symbol}


@watchlist_router.delete("/{item_id}")
def remove_from_watchlist(item_id: int, session: Session = Depends(get_session)):
    item = session.get(WatchlistItem, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Elemento no encontrado")
    session.delete(item)
    session.commit()
    return {"deleted": item_id}


# ---------------------------------------------------------------------------
# Posiciones
# ---------------------------------------------------------------------------


class PositionCreate(BaseModel):
    symbol: str = Field(min_length=1, max_length=12)
    quantity: float = Field(gt=0)
    cost_basis: float = Field(ge=0, description="Coste por acción")
    opened_at: str | None = None


class PositionClose(BaseModel):
    exit_price: float = Field(ge=0, description="Precio de venta por acción")


@router.post("/positions")
def create_position(
    body: PositionCreate,
    session: Session = Depends(get_session),
    service: MarketDataService = Depends(get_service),
):
    instrument = get_or_create_instrument(session, body.symbol, service)
    opened_at = (
        datetime.fromisoformat(body.opened_at)
        if body.opened_at
        else datetime.now(timezone.utc)
    )
    position = Position(
        instrument_id=instrument.id,
        quantity=body.quantity,
        cost_basis=body.cost_basis,
        opened_at=opened_at,
    )
    session.add(position)
    session.commit()
    return {"id": position.id, "symbol": instrument.symbol}


@router.post("/positions/{position_id}/close")
def close_position(
    position_id: int, body: PositionClose, session: Session = Depends(get_session)
):
    position = session.get(Position, position_id)
    if position is None:
        raise HTTPException(status_code=404, detail="Posición no encontrada")
    if position.closed_at is not None:
        raise HTTPException(status_code=409, detail="La posición ya está cerrada")
    position.realized_pnl = (body.exit_price - position.cost_basis) * position.quantity
    position.closed_at = datetime.now(timezone.utc)
    session.commit()
    return {"id": position.id, "realized_pnl": position.realized_pnl}


@router.delete("/positions/{position_id}")
def delete_position(position_id: int, session: Session = Depends(get_session)):
    position = session.get(Position, position_id)
    if position is None:
        raise HTTPException(status_code=404, detail="Posición no encontrada")
    session.delete(position)
    session.commit()
    return {"deleted": position_id}


@router.get("")
def get_portfolio(
    session: Session = Depends(get_session),
    service: MarketDataService = Depends(get_service),
):
    """Portafolio con P&L no realizado, pesos y exposición sectorial."""
    rows = session.execute(
        select(Position, Instrument).join(Instrument, Position.instrument_id == Instrument.id)
    ).all()

    open_positions, closed = [], []
    for position, instrument in rows:
        if position.closed_at is not None:
            closed.append(
                {
                    "id": position.id,
                    "symbol": instrument.symbol,
                    "quantity": position.quantity,
                    "cost_basis": position.cost_basis,
                    "realized_pnl": position.realized_pnl,
                    "closed_at": position.closed_at.isoformat(),
                }
            )
            continue
        price = _price_of(service, instrument.symbol)
        metrics = position_metrics(
            {"quantity": position.quantity, "cost_basis": position.cost_basis}, price
        )
        open_positions.append(
            {
                "id": position.id,
                "symbol": instrument.symbol,
                "name": instrument.name,
                "sector": instrument.sector or "Sin clasificar",
                "opened_at": position.opened_at.isoformat(),
                **metrics,
            }
        )

    summary = portfolio_summary(open_positions)
    by_position = allocation_weights(open_positions, "symbol")
    by_sector = allocation_weights(open_positions, "sector")
    return {
        "positions": open_positions,
        "closed_positions": closed,
        "summary": {**summary, "realized_pnl": realized_pnl(closed)},
        "allocation_by_position": by_position,
        "allocation_by_sector": by_sector,
        "concentration_warnings": concentration_warning(by_position),
        "note": (
            "Las posiciones sin precio disponible se excluyen de los totales y "
            "de los pesos; el resumen indica sobre cuántas se calculó."
        ),
    }


# ---------------------------------------------------------------------------
# Alertas
# ---------------------------------------------------------------------------


class AlertCreate(BaseModel):
    symbol: str = Field(min_length=1, max_length=12)
    op: str = Field(pattern="^(lt|gt)$")
    price: float = Field(gt=0)


@router.get("/alerts")
def list_alerts(
    session: Session = Depends(get_session),
    service: MarketDataService = Depends(get_service),
):
    """Alertas configuradas, evaluadas contra el precio actual (cacheado)."""
    rows = session.execute(
        select(Alert, Instrument).join(Instrument, Alert.instrument_id == Instrument.id)
    ).all()
    out = []
    for alert, instrument in rows:
        price = _price_of(service, instrument.symbol) if alert.active else None
        condition = alert.condition or {}
        triggered = None
        if price is not None and "price" in condition:
            triggered = (
                price < condition["price"]
                if condition.get("op") == "lt"
                else price > condition["price"]
            )
            if triggered and alert.triggered_at is None:
                alert.triggered_at = datetime.now(timezone.utc)
                session.commit()
        out.append(
            {
                "id": alert.id,
                "symbol": instrument.symbol,
                "kind": alert.kind,
                "condition": condition,
                "active": alert.active,
                "current_price": price,
                "triggered": triggered,
                "triggered_at": alert.triggered_at.isoformat() if alert.triggered_at else None,
            }
        )
    return {"alerts": out}


@router.post("/alerts")
def create_alert(
    body: AlertCreate,
    session: Session = Depends(get_session),
    service: MarketDataService = Depends(get_service),
):
    instrument = get_or_create_instrument(session, body.symbol, service)
    alert = Alert(
        instrument_id=instrument.id,
        kind="price",
        condition={"op": body.op, "price": body.price},
    )
    session.add(alert)
    session.commit()
    return {"id": alert.id, "symbol": instrument.symbol}


@router.delete("/alerts/{alert_id}")
def delete_alert(alert_id: int, session: Session = Depends(get_session)):
    alert = session.get(Alert, alert_id)
    if alert is None:
        raise HTTPException(status_code=404, detail="Alerta no encontrada")
    session.delete(alert)
    session.commit()
    return {"deleted": alert_id}
