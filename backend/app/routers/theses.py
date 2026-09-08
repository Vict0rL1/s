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

from app.analysis.fundamentals import derive_ratio_series, growth_summary
from app.analysis.thesis_watch import (
    CRECIMIENTOS,
    DIAS_NOTICIAS,
    METRICAS,
    OPERADORES,
    coherencia,
    instantanea,
    vigilar,
)
from app.analysis.track_record import (
    classify_scenario,
    days_elapsed,
    track_record_summary,
)
from app.cache.cache import MarketDataService
from app.db.engine import get_session
from app.db.models import (
    Decision,
    Evaluation,
    Instrument,
    Position,
    Scenario,
    Thesis,
    ThesisTrigger,
    WatchlistItem,
)
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


# ---------------------------------------------------------------------------
# Vigilancia: los puntos de invalidación que la app SÍ puede mirar sola
# ---------------------------------------------------------------------------
#
# `invalidation_criteria` es texto libre y sirve para pensar, pero nadie lo
# vigila. Estos disparadores son la versión ejecutable, y existen porque la parte
# difícil de escribir «qué me haría cambiar de opinión» no es escribirlo: es
# acordarse de mirarlo dentro de ocho meses, cuando la empresa lleva un año
# subiendo y la tesis se ha convertido en identidad.


class TriggerCreate(BaseModel):
    kind: str = Field(pattern="^(metrica|crecimiento|noticia)$")
    descripcion: str = Field(min_length=1, description="Por qué esto invalidaría la tesis")
    config: dict


class DecisionCreate(BaseModel):
    symbol: str = Field(min_length=1, max_length=12)
    accion: str = Field(pattern="^(comprar|vender|reforzar|reducir|mantener|descartar)$")
    # Obligatorio y sin valor por defecto: una decisión sin porqué no es un
    # registro, es una fila. El campo entero existe para esa frase.
    razonamiento: str = Field(min_length=10)
    thesis_id: int | None = None
    quantity: float | None = None


def _datos_para_vigilar(
    service: MarketDataService, symbol: str, con_noticias: bool
) -> dict:
    """Lo que hace falta para comprobar los disparadores, sin gastar de más.

    Los estados financieros son de EDGAR (gratis, cacheados 24 h). Las noticias
    solo se piden si alguna tesis tiene un disparador de ese tipo: pedirlas
    siempre gastaría cuota de Finnhub para nada en la mayoría de los casos.
    """
    datos: dict = {"ratios": [], "crecimiento": {}, "noticias": []}
    try:
        financials = service.get("financials", symbol=symbol)
        periodos = financials.get("periods") or []
        if periodos:
            datos["ratios"] = derive_ratio_series(periodos)
            datos["crecimiento"] = growth_summary(periodos)
    except (DataNotFoundError, AllProvidersFailedError):
        pass
    if con_noticias:
        try:
            datos["noticias"] = (
                service.get("news", symbol=symbol, days=DIAS_NOTICIAS).get("items") or []
            )
        except (DataNotFoundError, AllProvidersFailedError):
            pass
    return datos


def _serializar_disparador(t: ThesisTrigger) -> dict:
    return {
        "id": t.id,
        "thesis_id": t.thesis_id,
        "kind": t.kind,
        "descripcion": t.descripcion,
        "config": t.config,
        "activo": t.activo,
        "created_at": t.created_at.isoformat(),
        "last_fired_at": t.last_fired_at.isoformat() if t.last_fired_at else None,
    }


@router.get("/vigilancia/metricas")
def metricas_vigilables():
    """Qué se puede vigilar. Solo lo que sale de estados financieros."""
    return {
        "metricas": [{"clave": k, "etiqueta": v[0], "alto_mejor": v[1]}
                     for k, v in METRICAS.items()],
        "crecimientos": [{"clave": k, "etiqueta": v} for k, v in CRECIMIENTOS.items()],
        "operadores": [{"clave": k, "etiqueta": v[0]} for k, v in OPERADORES.items()],
        "nota": (
            "No se vigilan múltiplos ni precios: vigilar el P/E sería vigilar la "
            "cotización, y para eso están las alertas de precio. Un punto de "
            "invalidación habla del NEGOCIO."
        ),
    }


@router.post("/{thesis_id}/triggers")
def add_trigger(
    thesis_id: int,
    trigger: TriggerCreate,
    session: Session = Depends(get_session),
):
    """Añade un punto de invalidación vigilable a una tesis."""
    if session.get(Thesis, thesis_id) is None:
        raise HTTPException(status_code=404, detail="Tesis no encontrada")

    config = trigger.config or {}
    if trigger.kind in ("metrica", "crecimiento"):
        catalogo = METRICAS if trigger.kind == "metrica" else CRECIMIENTOS
        if config.get("metrica") not in catalogo:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Métrica no vigilable: {config.get('metrica')}. Consulta "
                    "/api/theses/vigilancia/metricas para ver las disponibles."
                ),
            )
        if config.get("op") not in OPERADORES:
            raise HTTPException(status_code=422, detail=f"Operador inválido: {config.get('op')}")
        if not isinstance(config.get("umbral"), (int, float)):
            raise HTTPException(status_code=422, detail="Falta el umbral numérico.")
    elif not [p for p in (config.get("palabras") or []) if str(p).strip()]:
        raise HTTPException(
            status_code=422,
            detail="Un disparador de noticias necesita al menos una palabra que buscar.",
        )

    record = ThesisTrigger(
        thesis_id=thesis_id, kind=trigger.kind,
        descripcion=trigger.descripcion, config=config,
    )
    session.add(record)
    session.commit()
    return _serializar_disparador(record)


@router.delete("/triggers/{trigger_id}")
def delete_trigger(trigger_id: int, session: Session = Depends(get_session)):
    record = session.get(ThesisTrigger, trigger_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Disparador no encontrado")
    session.delete(record)
    session.commit()
    return {"deleted": trigger_id}


@router.get("/vigilancia")
def vigilancia(
    session: Session = Depends(get_session),
    service: MarketDataService = Depends(get_service),
):
    """Comprueba TODOS los puntos de invalidación de TODAS las tesis.

    Es la pantalla que justifica haber escrito los umbrales: la app se acuerda de
    mirarlos aunque tú no.
    """
    filas = session.execute(
        select(Thesis, Instrument).join(Instrument, Thesis.instrument_id == Instrument.id)
    ).all()

    salida, ahora = [], datetime.now(timezone.utc)
    total_saltan = 0
    for thesis, instrument in filas:
        disparadores = session.execute(
            select(ThesisTrigger).where(ThesisTrigger.thesis_id == thesis.id)
        ).scalars().all()
        if not disparadores:
            salida.append(
                {
                    "thesis_id": thesis.id, "symbol": instrument.symbol,
                    "title": thesis.title,
                    "invalidation_criteria": thesis.invalidation_criteria,
                    "vigilancia": vigilar([], {}),
                }
            )
            continue

        datos = _datos_para_vigilar(
            service, instrument.symbol,
            con_noticias=any(d.kind == "noticia" for d in disparadores),
        )
        resultado = vigilar([_serializar_disparador(d) for d in disparadores], datos)
        total_saltan += resultado["saltan"]

        # Se marca cuándo saltó cada uno, para poder distinguir «lleva meses
        # cruzado» de «acaba de cruzarse».
        por_id = {d["id"]: d for d in resultado["disparadores"]}
        for d in disparadores:
            if por_id.get(d.id, {}).get("salta"):
                d.last_fired_at = ahora
        session.commit()

        salida.append(
            {
                "thesis_id": thesis.id, "symbol": instrument.symbol,
                "title": thesis.title,
                "invalidation_criteria": thesis.invalidation_criteria,
                "days_elapsed": days_elapsed(thesis.created_at),
                "vigilancia": resultado,
            }
        )

    salida.sort(key=lambda t: -t["vigilancia"]["saltan"])
    sin_disparadores = [t["symbol"] for t in salida if t["vigilancia"]["total"] == 0]
    return {
        "tesis": salida,
        "total_saltan": total_saltan,
        "sin_disparadores": sin_disparadores,
        "nota": (
            f"{total_saltan} punto(s) de invalidación cruzados. Que salte uno no es "
            "una señal de venta: es que tú, cuando pensabas con más calma que ahora, "
            "dijiste que esto importaba. Toca releer la tesis, no vender."
            if total_saltan
            else "Ningún punto de invalidación cruzado en las tesis vigiladas."
        ),
        "aviso_sin_disparadores": (
            f"{len(sin_disparadores)} tesis sin ningún punto vigilable "
            f"({', '.join(sin_disparadores[:5])}): el texto libre no lo mira nadie."
            if sin_disparadores
            else None
        ),
    }


@router.get("/sin-tesis")
def sin_tesis(session: Session = Depends(get_session)):
    """Qué tienes en el libro sin una razón escrita.

    No se bloquea añadir una posición sin tesis —alguien puede estar anotando
    algo que ya tenía, y estorbar solo conseguiría que dejara de anotar—, pero sí
    se cuenta y se dice. Una posición sin tesis escrita no se puede revisar
    después: dentro de un año no vas a recordar el porqué, vas a recordar el
    resultado, y eso no sirve para aprender nada.
    """
    con_tesis = {
        symbol
        for (symbol,) in session.execute(
            select(Instrument.symbol).join(Thesis, Thesis.instrument_id == Instrument.id)
        ).all()
    }
    posiciones = [
        symbol
        for (symbol,) in session.execute(
            select(Instrument.symbol)
            .join(Position, Position.instrument_id == Instrument.id)
            .where(Position.closed_at.is_(None))
        ).all()
    ]
    vigiladas = [
        symbol
        for (symbol,) in session.execute(
            select(Instrument.symbol).join(
                WatchlistItem, WatchlistItem.instrument_id == Instrument.id
            )
        ).all()
    ]
    posiciones_sin = sorted(set(posiciones) - con_tesis)
    watchlist_sin = sorted(set(vigiladas) - con_tesis)

    return {
        "posiciones_sin_tesis": posiciones_sin,
        "watchlist_sin_tesis": watchlist_sin,
        "posiciones_totales": len(set(posiciones)),
        "watchlist_total": len(set(vigiladas)),
        "nota": (
            (
                f"{len(posiciones_sin)} posición(es) abiertas sin tesis escrita "
                f"({', '.join(posiciones_sin[:6])}). Es dinero puesto sin una razón "
                "que puedas releer: dentro de un año recordarás el resultado, no el "
                "porqué."
                if posiciones_sin
                else "Todas tus posiciones abiertas tienen una tesis escrita."
            )
            + (
                f" En la watchlist hay {len(watchlist_sin)} sin tesis, que importa "
                "menos porque ahí no hay dinero — pero es el mejor momento para "
                "escribirla, antes de estar dentro."
                if watchlist_sin
                else ""
            )
        ),
    }


# ---------------------------------------------------------------------------
# Registro de decisiones
# ---------------------------------------------------------------------------


@router.post("/decisiones")
def registrar_decision(
    decision: DecisionCreate,
    session: Session = Depends(get_session),
    service: MarketDataService = Depends(get_service),
):
    """Registra una decisión con el razonamiento DE ENTONCES y su contexto.

    El contexto es lo que hace útil el registro: precio, tesis vigente y qué
    disparadores estaban saltando en ese momento. Dentro de seis meses no vas a
    recordar lo que sabías, vas a recordar lo que pasó — y la memoria reescribe
    el pasado para que encaje.
    """
    symbol = decision.symbol.strip().upper()
    precio = _price_of(service, symbol)

    tesis = session.get(Thesis, decision.thesis_id) if decision.thesis_id else None
    if decision.thesis_id and tesis is None:
        raise HTTPException(status_code=404, detail="Tesis no encontrada")

    vigilancia_actual = {"disparadores": [], "total": 0}
    if tesis is not None:
        disparadores = session.execute(
            select(ThesisTrigger).where(ThesisTrigger.thesis_id == tesis.id)
        ).scalars().all()
        if disparadores:
            datos = _datos_para_vigilar(
                service, symbol,
                con_noticias=any(d.kind == "noticia" for d in disparadores),
            )
            vigilancia_actual = vigilar(
                [_serializar_disparador(d) for d in disparadores], datos
            )

    record = Decision(
        symbol=symbol,
        thesis_id=decision.thesis_id,
        accion=decision.accion,
        razonamiento=decision.razonamiento,
        price_at_decision=precio,
        quantity=decision.quantity,
        contexto=instantanea(
            precio,
            vigilancia_actual,
            {"id": tesis.id, "title": tesis.title,
             "created_at": tesis.created_at.isoformat()} if tesis else None,
        ),
    )
    session.add(record)
    session.commit()
    return _serializar_decision(record)


def _serializar_decision(d: Decision) -> dict:
    return {
        "id": d.id,
        "symbol": d.symbol,
        "thesis_id": d.thesis_id,
        "accion": d.accion,
        "razonamiento": d.razonamiento,
        "price_at_decision": d.price_at_decision,
        "quantity": d.quantity,
        "contexto": d.contexto,
        "created_at": d.created_at.isoformat(),
        "days_elapsed": days_elapsed(d.created_at),
    }


@router.get("/decisiones")
def listar_decisiones(
    symbol: str | None = None,
    session: Session = Depends(get_session),
    service: MarketDataService = Depends(get_service),
):
    """El diario de decisiones, de la más reciente a la más antigua.

    Cada una trae el precio de entonces y el de ahora. No para puntuar aciertos
    —eso es `track-record`— sino para que releer el razonamiento venga con el
    dato al lado, que es cuando duele y cuando se aprende.
    """
    consulta = select(Decision).order_by(Decision.created_at.desc())
    if symbol:
        consulta = consulta.where(Decision.symbol == symbol.strip().upper())
    filas = session.execute(consulta).scalars().all()

    precios: dict[str, float | None] = {}
    salida = []
    for d in filas:
        if d.symbol not in precios:
            precios[d.symbol] = _price_of(service, d.symbol)
        actual = precios[d.symbol]
        fila = _serializar_decision(d)
        fila["precio_actual"] = actual
        fila["cambio_pct"] = (
            round((actual / d.price_at_decision - 1) * 100, 2)
            if actual and d.price_at_decision
            else None
        )
        salida.append(fila)

    return {
        "decisiones": salida,
        "coherencia": coherencia([_serializar_decision(d) for d in filas]),
        "nota": (
            "El precio de entonces y el de ahora van juntos a propósito: releer el "
            "razonamiento con el resultado delante es incómodo, y es exactamente "
            "por eso que sirve. Lo que NO se hace es puntuar el razonamiento por el "
            "resultado — una decisión correcta puede salir mal y una temeraria "
            "puede salir bien."
        ),
    }
