"""Consultar lo que el sistema decidió, tal como lo decidió.

Solo lectura, a propósito: no hay endpoint para crear, editar ni borrar
instantáneas. Se crean solas al calcular la lista diaria y no se tocan nunca.
"""

from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import snapshots as sn
from app.db.engine import get_session
from app.db.models import DecisionOutcome, DecisionSnapshot

router = APIRouter(prefix="/api/snapshots", tags=["snapshots"])

_FECHA = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _resultados(session: Session, snap_id: int) -> list[DecisionOutcome]:
    return session.execute(
        select(DecisionOutcome)
        .where(DecisionOutcome.snapshot_id == snap_id)
        .order_by(DecisionOutcome.evaluado_en)
    ).scalars().all()


@router.get("")
def listar(
    symbol: str | None = None,
    desde: str | None = Query(None, description="AAAA-MM-DD"),
    hasta: str | None = Query(None, description="AAAA-MM-DD"),
    limite: int = Query(100, ge=1, le=1000),
    session: Session = Depends(get_session),
):
    """Las instantáneas, más recientes primero, con su último resultado."""
    for f in (desde, hasta):
        if f is not None and not _FECHA.match(f):
            raise HTTPException(status_code=422, detail=f"Fecha inválida: {f!r} (AAAA-MM-DD)")
    q = select(DecisionSnapshot).order_by(DecisionSnapshot.creado_en.desc()).limit(limite)
    if symbol:
        q = q.where(DecisionSnapshot.symbol == symbol.strip().upper())
    if desde:
        q = q.where(DecisionSnapshot.fecha >= desde)
    if hasta:
        q = q.where(DecisionSnapshot.fecha <= hasta)
    salida = []
    for snap in session.execute(q).scalars():
        ultimo = (_resultados(session, snap.id) or [None])[-1]
        salida.append(
            {
                "id": snap.id,
                "fecha": snap.fecha,
                "symbol": snap.symbol,
                "accion": snap.accion,
                "precio": snap.precio,
                "peso_final_pct": snap.peso_final_pct,
                "reglas_version": snap.reglas_version,
                "resultado": (
                    {"estado": ultimo.estado, "retorno_pct": ultimo.retorno_pct, "dias": ultimo.dias}
                    if ultimo
                    else None
                ),
            }
        )
    return {
        "instantaneas": salida,
        "reglas_version_actual": sn.version_de_reglas(),
        "nota": (
            "Lo que el sistema dijo, congelado en el momento. Las instantáneas con "
            "otra versión de reglas se tomaron con parámetros distintos: no se "
            "agregan como si fueran el mismo sistema."
        ),
    }


@router.get("/{snap_id}")
def detalle(snap_id: int, session: Session = Depends(get_session)):
    """«¿Por qué el sistema dijo esto aquel día?», solo con lo congelado."""
    snap = session.get(DecisionSnapshot, snap_id)
    if snap is None:
        raise HTTPException(status_code=404, detail="Instantánea no encontrada")
    return sn.reconstruir(snap, _resultados(session, snap_id))
