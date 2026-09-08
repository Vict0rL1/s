"""Watchlist, portafolio y alertas (Fase 5). Todo local, todo tuyo."""

from __future__ import annotations

import re
from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.analysis import portfolio_risk
from app.analysis.decision import _stop_pct
from app.analysis.risk_budget import presupuesto_de_riesgo
from app.analysis.sizing import con_caida_esperada, peor_ventana
from app.analysis.portfolio import (
    allocation_weights,
    concentration_warning,
    portfolio_summary,
    position_metrics,
    realized_pnl,
)
from app.cache.cache import MarketDataService
from app.db.engine import get_session
from app.db.models import (
    Alert,
    ApiCache,
    Instrument,
    Position,
    Thesis,
    Watchlist,
    WatchlistItem,
)
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



def _volatilidad_de(service: MarketDataService, symbol: str) -> float | None:
    """Volatilidad diaria desde el histórico ya cacheado. Nunca descarga nada.

    Si no está en caché se devuelve None y el stop cae al valor medio de su
    clase: preferible a gastar una llamada por posición cada vez que se abre
    el portafolio.
    """
    cache = getattr(service, "cache", None)
    if cache is None:
        return None
    history = cache.get(
        "price_history", {"symbol": symbol, "interval": "1day", "outputsize": 252}
    )
    bars = (history or {}).get("bars") or []
    cierres = [b["close"] for b in bars[-64:] if b.get("close")]
    if len(cierres) < 21:
        return None
    retornos = [
        cierres[i] / cierres[i - 1] - 1 for i in range(1, len(cierres)) if cierres[i - 1]
    ]
    if len(retornos) < 20:
        return None
    medio = sum(retornos) / len(retornos)
    varianza = sum((r - medio) ** 2 for r in retornos) / (len(retornos) - 1)
    return (varianza ** 0.5) * 100


def _series_cacheadas(
    service: MarketDataService, symbols: list[str]
) -> dict[str, list[tuple[date, float]]]:
    """Cierres diarios de la caché, para estresar la cartera. Nunca descarga.

    Misma disciplina que `_volatilidad_de`: si el histórico no está guardado, esa
    posición no entra en el estrés en vez de gastar una llamada por posición cada
    vez que se abre el portafolio. `peor_ventana` solo cruza fechas comunes, así
    que una posición ausente encoge el histórico compartido pero no lo falsea.
    """
    cache = getattr(service, "cache", None)
    if cache is None:
        return {}
    salida: dict[str, list[tuple[date, float]]] = {}
    for symbol in symbols:
        history = cache.get(
            "price_history", {"symbol": symbol, "interval": "1day", "outputsize": 252}
        )
        puntos = []
        for bar in (history or {}).get("bars") or []:
            cierre, ts = bar.get("close"), bar.get("ts")
            if not cierre or not ts:
                continue
            try:
                puntos.append((date.fromisoformat(str(ts)[:10]), float(cierre)))
            except ValueError:
                continue
        if len(puntos) >= 60:
            salida[symbol] = puntos
    return salida


def _price_of(service: MarketDataService, symbol: str) -> float | None:
    try:
        return service.get("quote", symbol=symbol).get("price")
    except (DataNotFoundError, AllProvidersFailedError):
        return None


# ---------------------------------------------------------------------------
# Watchlist
# ---------------------------------------------------------------------------


class TesisEnLinea(BaseModel):
    """La tesis que se escribe EN EL MOMENTO de añadir algo al libro.

    Va aquí y no en un formulario aparte porque el único momento en que uno tiene
    clara la razón es justo cuando decide. Una semana después, «me pareció
    barata» es todo lo que queda.
    """

    title: str = Field(min_length=1, max_length=256)
    body_md: str = Field(min_length=1, description="Por qué")
    invalidation_criteria: str | None = Field(
        None, description="Qué tendría que pasar para cambiar de opinión"
    )


class WatchlistAdd(BaseModel):
    symbol: str = Field(min_length=1, max_length=12)
    notes: str | None = None
    tesis: TesisEnLinea | None = None


def _guardar_tesis(
    session: Session, instrument_id: int, tesis: "TesisEnLinea | None"
) -> int | None:
    """Guarda la tesis escrita al añadir algo al libro.

    No se obliga: alguien puede estar anotando una posición que ya tenía, y
    bloquearla por no escribir un párrafo solo conseguiría que dejara de anotar.
    Lo que sí se hace es CONTAR las que no la tienen y decirlo en voz alta
    (`/api/theses/sin-tesis`), que informa sin estorbar.
    """
    if tesis is None:
        return None
    record = Thesis(
        instrument_id=instrument_id,
        title=tesis.title,
        body_md=tesis.body_md,
        invalidation_criteria=tesis.invalidation_criteria,
    )
    session.add(record)
    session.flush()
    return record.id


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
    thesis_id = _guardar_tesis(session, instrument.id, body.tesis)
    session.commit()
    return {"id": item.id, "symbol": instrument.symbol, "thesis_id": thesis_id}


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
    tesis: TesisEnLinea | None = None


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
    thesis_id = _guardar_tesis(session, instrument.id, body.tesis)
    session.commit()
    return {"id": position.id, "symbol": instrument.symbol, "thesis_id": thesis_id}


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
        # El stop se recalcula con la MISMA regla que la vista Hoy, anclado a
        # tu coste. Sin él no se puede sumar el riesgo abierto, que es el
        # número que decide si una mala semana es un contratiempo o un agujero.
        clase = "cripto" if instrument.symbol.endswith("-USD") else "accion"
        vol = _volatilidad_de(service, instrument.symbol)
        stop = round(position.cost_basis * (1 - _stop_pct(vol, clase) / 100), 2)
        open_positions.append(
            {
                "id": position.id,
                "symbol": instrument.symbol,
                "name": instrument.name,
                "sector": instrument.sector or "Sin clasificar",
                "asset_class": clase,
                "opened_at": position.opened_at.isoformat(),
                "stop": stop,
                "price": price,
                **metrics,
            }
        )

    summary = portfolio_summary(open_positions)
    by_position = allocation_weights(open_positions, "symbol")
    by_sector = allocation_weights(open_positions, "sector")

    # Qué le habría pasado a ESTA composición en el peor tramo del histórico
    # disponible. No son escenarios inventados: son los pesos que tienes hoy
    # aplicados al pasado que hay guardado, con sus fechas y con el aviso de qué
    # crisis quedan fuera de la cobertura.
    estres = peor_ventana(
        {p["symbol"]: p["market_value"] for p in open_positions if p.get("market_value")},
        _series_cacheadas(service, [p["symbol"] for p in open_positions]),
    )
    return {
        "positions": open_positions,
        "closed_positions": closed,
        # El retorno nunca viaja solo: `con_caida_esperada` le engancha la caída
        # que esta misma cartera habría sufrido. Un «+12 %» y un «+12 % con un
        # −45 % por el camino» son propuestas distintas, y quien solo ve la
        # primera abandona en el peor momento.
        "summary": con_caida_esperada(
            {**summary, "realized_pnl": realized_pnl(closed)}, estres
        ),
        "estres": estres,
        "allocation_by_position": by_position,
        "allocation_by_sector": by_sector,
        "concentration_warnings": concentration_warning(by_position),
        # Cada idea se dimensiona para arriesgar un 1 %; lo que no hacía nadie
        # era sumar. Ocho posiciones al 1 % son un 8 % en riesgo simultáneo.
        "risk_budget": presupuesto_de_riesgo(
            open_positions, summary.get("total_market_value")
        ),
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


def _historico_largo(
    service: MarketDataService, symbols: list[str], descargar: bool
) -> tuple[dict[str, list[tuple[date, float]]], dict[str, str]]:
    """Décadas de cierres por posición, para estresar contra crisis reales.

    Con `descargar=False` solo se lee la caché: la vista se abre al instante y
    no gasta una llamada por posición. Con True se rellena lo que falte, que es
    lo que hace falta la primera vez — sin histórico de 2008 el estrés de 2008
    no existe, y decir «no hay datos» cuando nunca se pidieron sería mentir por
    omisión.
    """
    cache = getattr(service, "cache", None)
    series: dict[str, list[tuple[date, float]]] = {}
    fallos: dict[str, str] = {}
    for symbol in symbols:
        payload = cache.get("price_history_long", {"symbol": symbol}) if cache else None
        if payload is None and descargar:
            try:
                payload = service.get("price_history_long", symbol=symbol)
            except (DataNotFoundError, AllProvidersFailedError) as exc:
                fallos[symbol] = str(exc)[:200]
                continue
        if payload is None:
            fallos[symbol] = "sin histórico largo en caché (pide una descarga)"
            continue
        puntos = []
        for bar in payload.get("bars") or []:
            cierre, ts = bar.get("close"), bar.get("ts")
            if not cierre or not ts:
                continue
            try:
                puntos.append((date.fromisoformat(str(ts)[:10]), float(cierre)))
            except ValueError:
                continue
        if puntos:
            series[symbol] = sorted(puntos)
        else:
            fallos[symbol] = "el histórico llegó vacío"
    return series, fallos


def _composicion_de_etfs(
    service: MarketDataService, symbols: list[str], descargar: bool
) -> dict[str, list[dict]]:
    """Los ~10 mayores holdings de cada posición que resulte ser un ETF.

    No hace falta saber de antemano cuáles lo son: el proveedor responde
    `DataNotFoundError` para lo que no es un fondo, y eso ya es la respuesta.
    """
    cache = getattr(service, "cache", None)
    salida: dict[str, list[dict]] = {}
    for symbol in symbols:
        payload = cache.get("etf_data", {"symbol": symbol}) if cache else None
        if payload is None and descargar:
            try:
                payload = service.get("etf_data", symbol=symbol)
            except (DataNotFoundError, AllProvidersFailedError):
                continue  # no es un ETF, o no se pudo leer: ambas cosas son «nada»
        if payload and payload.get("top_holdings"):
            salida[symbol] = payload["top_holdings"]
    return salida


def _paises(
    service: MarketDataService, symbols: list[str], descargar: bool
) -> dict[str, str | None]:
    """País de DOMICILIO de cada posición, que no es lo mismo que su geografía.

    Es el dato que dan las fuentes gratuitas y hay que tomarlo por lo que es:
    Apple está domiciliada en Estados Unidos y vende medio mundo. Sirve para ver
    riesgo regulatorio y de divisa, no exposición económica.
    """
    cache = getattr(service, "cache", None)
    salida: dict[str, str | None] = {}
    for symbol in symbols:
        payload = cache.get("profile", {"symbol": symbol}) if cache else None
        if payload is None and descargar:
            try:
                payload = service.get("profile", symbol=symbol)
            except (DataNotFoundError, AllProvidersFailedError):
                payload = None
        salida[symbol] = (payload or {}).get("country")
    return salida


def _caracteristicas(service: MarketDataService, symbols: list[str]) -> dict[str, dict]:
    """Fundamentales YA cacheados. Nunca descarga: si no están, no están.

    Estas medias son lo accesorio de esta pantalla —lo importante son la
    correlación y el estrés— y no justifican una llamada por posición.
    """
    cache = getattr(service, "cache", None)
    if cache is None:
        return {}
    salida = {}
    for symbol in symbols:
        payload = cache.get("fundamentals", {"symbol": symbol})
        if payload and payload.get("metrics"):
            salida[symbol] = payload["metrics"]
    return salida


MIN_UNIVERSO_REFERENCIA = 20


def _referencia_del_universo(session: Session) -> tuple[dict | None, int]:
    """Media de las empresas cuyos fundamentales están descargados y vigentes.

    Es la única referencia honesta que hay a coste cero: las empresas que el
    barrido de mercado ha mirado de verdad. No es «el mercado» —está sesgada
    hacia lo que hayas escaneado— y por eso se devuelve también cuántas son:
    compararse contra tres empresas no es compararse contra nada.

    Se leen las filas de caché directamente porque `CacheStore.get` exige saber
    los parámetros exactos, y aquí la pregunta es justo la contraria: qué hay.
    """
    filas = (
        session.execute(
            select(ApiCache.payload).where(
                ApiCache.endpoint == "fundamentals",
                ApiCache.expires_at > datetime.now(timezone.utc),
            )
        )
        .scalars()
        .all()
    )

    acumulado: dict[str, list[float]] = {}
    empresas = 0
    for payload in filas:
        metricas = (payload or {}).get("metrics") or {}
        if not metricas:
            continue
        empresas += 1
        for campo in ("pe_ttm", "roe", "revenue_growth_5y", "market_cap"):
            valor = metricas.get(campo)
            if isinstance(valor, (int, float)) and not isinstance(valor, bool):
                acumulado.setdefault(campo, []).append(float(valor))
    if empresas < MIN_UNIVERSO_REFERENCIA:
        return None, empresas
    # Mediana y no media: un P/E de 900 de una empresa que casi no gana dinero
    # arrastra la media del universo entero y deja la comparación sin sentido.
    referencia = {}
    for campo, valores in acumulado.items():
        if len(valores) < MIN_UNIVERSO_REFERENCIA:
            continue
        ordenados = sorted(valores)
        medio = len(ordenados) // 2
        referencia[campo] = (
            ordenados[medio]
            if len(ordenados) % 2
            else (ordenados[medio - 1] + ordenados[medio]) / 2
        )
    return (referencia or None), empresas


@router.get("/riesgo")
def riesgo_de_cartera(
    descargar: bool = True,
    session: Session = Depends(get_session),
    service: MarketDataService = Depends(get_service),
):
    """La cartera como UNA cosa, no como ocho análisis de ocho empresas.

    Cuatro preguntas que no se contestan mirando posición por posición: cuánto
    se mueven juntas, dónde está concentrado el dinero de verdad, cuántas
    apuestas independientes hay detrás de N tickers, y qué le habría pasado a
    esta mezcla en 2008, 2020 y 2022.
    """
    rows = session.execute(
        select(Position, Instrument)
        .join(Instrument, Position.instrument_id == Instrument.id)
        .where(Position.closed_at.is_(None))
    ).all()
    if not rows:
        return {
            "disponible": False,
            "nota": "No hay posiciones abiertas que analizar como cartera.",
        }

    crudas = []
    for position, instrument in rows:
        price = _price_of(service, instrument.symbol)
        crudas.append(
            {
                "symbol": instrument.symbol,
                "name": instrument.name,
                "sector": instrument.sector,
                "market_value": price * position.quantity if price else None,
            }
        )

    con_precio = [p for p in crudas if p["market_value"]]
    total = sum(p["market_value"] for p in con_precio)
    sin_precio = [p["symbol"] for p in crudas if not p["market_value"]]
    if not con_precio or not total:
        return {
            "disponible": False,
            "nota": (
                "Ninguna posición tiene precio ahora mismo, así que no hay pesos "
                "con los que ponderar nada."
            ),
        }

    symbols = [p["symbol"] for p in con_precio]
    paises = _paises(service, symbols, descargar)
    fundamentales = _caracteristicas(service, symbols)
    holdings = _composicion_de_etfs(service, symbols, descargar)

    posiciones = []
    for p in con_precio:
        m = fundamentales.get(p["symbol"], {})
        posiciones.append(
            {
                "symbol": p["symbol"],
                "name": p["name"],
                "peso_pct": p["market_value"] / total * 100,
                "sector": p["sector"],
                "pais": paises.get(p["symbol"]),
                "es_etf": p["symbol"] in holdings,
                "pe_ttm": m.get("pe_ttm"),
                "roe": m.get("roe"),
                "revenue_growth_5y": m.get("revenue_growth_5y"),
                "market_cap": m.get("market_cap"),
                "vol_anual_pct": None,  # se rellena abajo con el histórico largo
            }
        )

    referencia, n_universo = _referencia_del_universo(session)
    series, fallos = _historico_largo(service, symbols, descargar)

    # La volatilidad sale del histórico que ya está descargado para el estrés.
    # Sin esto la fila de low_volatility salía siempre vacía, teniendo el dato.
    for p in posiciones:
        puntos = series.get(p["symbol"])
        if puntos:
            p["vol_anual_pct"] = portfolio_risk.volatilidad_anualizada(puntos)

    correlacion = portfolio_risk.matriz_correlacion(
        portfolio_risk.ventana_reciente(series)
    )
    concentracion = (
        portfolio_risk.numero_efectivo_de_apuestas(correlacion["matriz"])
        if correlacion.get("disponible")
        else {
            "disponible": False,
            "nota": "Sin matriz de correlación no se puede contar apuestas independientes.",
        }
    )

    return {
        "disponible": True,
        "posiciones": posiciones,
        "sin_precio": sin_precio,
        "sin_historico": fallos,
        "correlacion": correlacion,
        "concentracion": concentracion,
        "look_through": portfolio_risk.look_through_etf(posiciones, holdings),
        "exposicion": {
            "sector": portfolio_risk.exposicion(posiciones, "sector", "Sin sector"),
            "geografia": portfolio_risk.exposicion(posiciones, "pais", "Sin país"),
        },
        "caracteristicas": {
            **portfolio_risk.caracteristicas_ponderadas(posiciones, referencia),
            "universo_empresas": n_universo,
        },
        "estres": portfolio_risk.estres_en_crisis(posiciones, series),
        "nota_geografia": (
            "La geografía es el país de DOMICILIO, que es el dato que dan las "
            "fuentes gratuitas. Apple está domiciliada en Estados Unidos y vende "
            "medio mundo: esto mide riesgo regulatorio y de divisa, no exposición "
            "económica real."
        ),
    }


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
