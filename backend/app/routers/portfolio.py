"""Watchlist, portafolio y alertas (Fase 5). Todo local, todo tuyo."""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import datos, vigilancia
from app.analysis import alertas, fx, historial as hist, portfolio_risk
from app.analysis.decision import _stop_pct
from app.analysis.risk_budget import presupuesto_de_riesgo
from app.analysis.sizing import con_caida_esperada, peor_ventana
from app.analysis.portfolio import (
    allocation_weights,
    concentration_warning,
    portfolio_summary,
    position_metrics,
)
from app.cache.cache import MarketDataService
from app.config import settings
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

    name = sector = currency = None
    if service is not None:
        try:
            profile = service.get("profile", symbol=symbol)
            name, sector = profile.get("name"), profile.get("sector")
            # La moneda venía en el perfil y se tiraba, mientras la cotización
            # de Finnhub —el primer proveedor— no la trae nunca.
            currency = _moneda_legible(profile.get("currency"))
        except (DataNotFoundError, AllProvidersFailedError):
            pass
    instrument = Instrument(symbol=symbol, name=name, sector=sector, currency=currency)
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


PUNTOS_SPARK = 32


def _spark_cacheado(
    service: MarketDataService, symbol: str, sesiones: int = 252
) -> list[float] | None:
    """Un año de precio en 32 puntos, SOLO de lo que ya está en caché.

    La forma del año dice de un vistazo si una posición viene de subida o de
    caída, que es lo que una columna de «P&L %» no cuenta: un +4 % que viene de
    un +30 % y otro que viene de un −20 % se leen igual en la tabla y no son lo
    mismo.

    Nunca descarga. El histórico ya lo bajan Cartera y el estrés, así que esto
    es gratis; si no está, la fila sale sin gráfico en vez de costar una llamada
    por posición cada vez que abres el portafolio.
    """
    cache = getattr(service, "cache", None)
    if cache is None:
        return None
    payload = cache.get("price_history_long", {"symbol": symbol}) or cache.get(
        "price_history", {"symbol": symbol, "interval": "1day", "outputsize": 252}
    )
    cierres = [
        float(b["close"])
        for b in (payload or {}).get("bars") or []
        if b.get("close")
    ][-sesiones:]
    if len(cierres) < PUNTOS_SPARK:
        return None
    paso = (len(cierres) - 1) / (PUNTOS_SPARK - 1)
    return [round(cierres[round(i * paso)], 2) for i in range(PUNTOS_SPARK)]


def _precio_y_divisa(service: MarketDataService, symbol: str) -> tuple[float | None, str | None]:
    """El precio Y la moneda en que está.

    La cotización siempre trajo `currency` y este módulo se quedaba solo con el
    precio, así que la cartera sumaba dólares canadienses con estadounidenses
    como si fueran lo mismo. El dato estaba; faltaba leerlo.
    """
    precio, moneda, _ = _cotizacion(service, symbol)
    return precio, moneda


def _cotizacion(service: MarketDataService, symbol: str) -> tuple[float | None, str | None, dict]:
    """Precio, moneda y ESTADO del dato. El estado se tiraba: la cartera sumaba
    precios rescatados de caché hace once minutos sin decirlo en ninguna parte."""
    try:
        q = service.get("quote", symbol=symbol)
    except (DataNotFoundError, AllProvidersFailedError):
        return None, None, {"estado": "desconocido", "antiguedad_segundos": None}
    return q.get("price"), q.get("currency"), {
        "estado": q.get("estado", "valido"),
        "antiguedad_segundos": q.get("antiguedad_segundos"),
    }


def _realizado_en_base(cerradas: list[dict], series: dict) -> tuple[float | None, list[str]]:
    """P&L realizado en la base: lo cobrado al tipo del día de VENTA menos lo
    pagado al tipo del día de COMPRA.

    Convertir el beneficio local a un solo tipo tampoco valdría: se perdería lo
    que movió el cambio entre la compra y la venta, que es dinero ganado o
    perdido igual que el de la acción.
    """
    total, fuera, alguna = 0.0, [], False
    for p in cerradas:
        pnl, moneda = datos.numero(p.get("realized_pnl")), p.get("currency")
        if pnl is None:
            continue
        if moneda is None:
            fuera.append(p["symbol"])
            continue
        if moneda == fx.BASE:
            p["realized_pnl_base"] = pnl
        else:
            serie = series.get(moneda) or []
            fechas, valores = [f for f, _ in serie], [v for _, v in serie]
            try:
                t_compra = hist._vigente(fechas, valores, date.fromisoformat(p["opened_at"][:10]))
                t_venta = hist._vigente(fechas, valores, date.fromisoformat(p["closed_at"][:10]))
            except ValueError:
                t_compra = t_venta = None
            if not t_compra or not t_venta:
                fuera.append(p["symbol"])
                continue
            coste = p["quantity"] * p["cost_basis"]
            p["realized_pnl_base"] = (coste + pnl) / t_venta - coste / t_compra
        total += p["realized_pnl_base"]
        alguna = True
    return (round(total, 2) if alguna else None), fuera


def _coste_al_tipo_de_compra(posiciones: list[dict], series: dict) -> None:
    """Convierte lo invertido al tipo VIGENTE EL DÍA DE COMPRA, no al de hoy.

    Con el tipo de hoy, la ganancia o pérdida cambiaria desde la compra se
    borraba del P&L: si compraste con el dólar a 1,25 CAD y hoy está a 1,37, el
    dólar canadiense se ha depreciado y ese dinero se ha perdido — pero el P&L
    en dólares no lo enseñaba. Ahora el coste sale del tipo de aquel día y el
    efecto divisa se da aparte en `efecto_divisa_base`.

    Si la serie no llega a la fecha de compra, se queda el tipo de hoy y se
    marca `coste_al_tipo_de_hoy`: mejor un P&L que se sabe aproximado que uno
    que parece exacto.
    """
    for p in posiciones:
        moneda = p.get("currency")
        if moneda == fx.BASE or p.get("invested") is None or p.get("invested_base") is None:
            continue
        serie = series.get(moneda) or []
        tipo = None
        try:
            abierto = date.fromisoformat(str(p.get("opened_at"))[:10])
            tipo = hist._vigente([f for f, _ in serie], [v for _, v in serie], abierto)
        except ValueError:
            abierto = None
        if not tipo:
            p["efecto_divisa_base"] = None
            p["coste_al_tipo_de_hoy"] = True
            continue
        al_tipo_de_hoy = p["invested_base"]
        p["invested_base"] = p["invested"] / tipo
        p["efecto_divisa_base"] = al_tipo_de_hoy - p["invested_base"]
        p["coste_al_tipo_de_hoy"] = False
        p["tipo_de_compra"] = {"por_usd": tipo, "fecha": abierto.isoformat()}


def _utc_iso(cuando) -> str | None:
    """ISO con zona SIEMPRE. SQLite la pierde al guardar, y sin marcarla el
    navegador lee el instante como hora local: una compra a medianoche UTC
    cambiaba de DÍA en husos negativos. Mismo fallo que en las alertas."""
    utc = alertas.como_utc(cuando)
    return utc.isoformat() if utc else None


def _moneda_segura(valor) -> str | None:
    try:
        return fx.normalizar(valor)
    except fx.SinTipo:
        return None


def _moneda_legible(valor) -> str | None:
    return valor.strip().upper() if isinstance(valor, str) and valor.strip() else None


def _resolver_divisa(
    session: Session, service: MarketDataService, instrument: Instrument, cotizada: str | None
) -> str | None:
    """La moneda de una posición, con lo que ya se sabe antes que suponiendo.

    Orden: la cotización → la guardada en el instrumento → el perfil. Lo que se
    aprende se guarda en `Instrument.currency`, que existía y nunca se rellenaba.

    Si nada la dice, devuelve None, y la posición queda FUERA de los totales.
    Antes se suponía dólar, y Finnhub —el primer proveedor de cotizaciones— no
    devuelve la moneda nunca: una acción canadiense se sumaba en dólares
    canadienses como si fueran estadounidenses, sin un aviso.
    """
    moneda = _moneda_legible(cotizada) or _moneda_legible(instrument.currency)
    if moneda is None:
        try:
            moneda = _moneda_legible(service.get("profile", symbol=instrument.symbol).get("currency"))
        except (DataNotFoundError, AllProvidersFailedError):
            moneda = None
    if moneda and instrument.currency != moneda:
        instrument.currency = moneda
        session.commit()
    return moneda


def _price_of(service: MarketDataService, symbol: str) -> float | None:
    return _precio_y_divisa(service, symbol)[0]


def _directorio_de_datos() -> Path:
    """Donde vive lo local y tuyo: junto a la base de datos, fuera del repo."""
    return Path(settings.database_path).parent


def tipos_de_cambio(service: MarketDataService, monedas: set[str]) -> dict[str, dict]:
    """Tipos de FRED para las monedas que hay en la cartera, y solo esas.

    FRED es gratis y sin límite práctico, y el TTL de `macro` es de 24 h: una
    llamada por divisa y día. El dólar no necesita tipo — es la pata común— y
    las monedas sin serie configurada no se piden.
    """
    salida: dict[str, dict] = {}
    desde = fx.inicio_de_ventana()
    for moneda in sorted(monedas):
        if moneda == fx.BASE or moneda not in fx.SERIES:
            continue
        try:
            payload = service.get("macro", series_id=fx.SERIES[moneda]["serie"], start=desde)
            salida[moneda] = fx.tipo_desde_observaciones(moneda, payload.get("points") or [])
        except (DataNotFoundError, AllProvidersFailedError, fx.SinTipo) as exc:
            # Sin tipo no se convierte y la posición queda fuera del total, con
            # su motivo. Inventar una paridad sería el error que esto evita.
            salida[moneda] = {"por_usd": None, "error": str(exc)[:200]}
    return salida


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
                "added_at": _utc_iso(item.added_at),
                "quote": quote,
                "spark": _spark_cacheado(service, instrument.symbol),
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


# `allow_inf_nan=False` en todo importe que entra. `gt=0` ya paraba NaN (porque
# `NaN > 0` es False), pero dejaba pasar `Infinity`, que el `json` de Python lee
# sin quejarse: una posición de infinitas acciones hacía infinito el valor, el
# peso y el riesgo de toda la cartera.
VENTANA_DUPLICADO = timedelta(minutes=10)


def _fecha_de_apertura(valor: str | None) -> datetime | None:
    """ISO (fecha o fecha y hora). Sin zona = UTC. Futura = error."""
    if valor is None:
        return None
    try:
        fecha = datetime.fromisoformat(valor)
    except ValueError:
        raise ValueError(
            f"Fecha de apertura ilegible: {valor!r}. Usa el formato AAAA-MM-DD."
        ) from None
    if fecha.tzinfo is None:
        fecha = fecha.replace(tzinfo=timezone.utc)
    if fecha > datetime.now(timezone.utc) + timedelta(minutes=5):
        raise ValueError(
            "La fecha de apertura está en el futuro. Una compra que aún no ha "
            "ocurrido descoloca la curva histórica y el tipo de cambio de compra."
        )
    return fecha


class PositionCreate(BaseModel):
    symbol: str = Field(min_length=1, max_length=12)
    quantity: float = Field(gt=0, allow_inf_nan=False)
    cost_basis: float = Field(ge=0, allow_inf_nan=False, description="Coste por acción")
    opened_at: str | None = None
    tesis: TesisEnLinea | None = None
    # Comprar otra vez lo mismo, a la misma cantidad y precio, existe. Pero es
    # mucho más probable que sea un doble clic: se pide confirmarlo.
    confirmar_duplicado: bool = False
    # Opcional: si no se da, se calcula con la volatilidad del día de apertura y
    # se CONGELA. Tiene que estar por debajo del coste: un stop por encima no
    # protege de una caída, y uno de cero no es un stop.
    stop: float | None = Field(None, gt=0, allow_inf_nan=False)

    @field_validator("opened_at")
    @classmethod
    def _fecha_valida(cls, v: str | None) -> str | None:
        _fecha_de_apertura(v)
        return v

    @field_validator("stop")
    @classmethod
    def _stop_bajo_el_coste(cls, v: float | None, info) -> float | None:
        coste = info.data.get("cost_basis")
        if v is not None and coste is not None and v >= coste:
            raise ValueError(
                f"El stop ({v:g}) tiene que estar por debajo del coste ({coste:g}): "
                "un stop por encima no protege de ninguna caída."
            )
        return v


class PositionClose(BaseModel):
    exit_price: float = Field(ge=0, allow_inf_nan=False, description="Precio de venta por acción")


@router.post("/positions")
def create_position(
    body: PositionCreate,
    session: Session = Depends(get_session),
    service: MarketDataService = Depends(get_service),
):
    instrument = get_or_create_instrument(session, body.symbol, service)
    opened_at = _fecha_de_apertura(body.opened_at) or datetime.now(timezone.utc)

    # Un doble clic creaba dos posiciones idénticas: la cartera salía con el
    # doble de exposición sin que nadie lo decidiera. Misma empresa, misma
    # cantidad, mismo coste y abierta casi a la vez → se pide confirmación.
    if not body.confirmar_duplicado:
        for gemela in session.execute(
            select(Position).where(
                Position.instrument_id == instrument.id,
                Position.closed_at.is_(None),
                Position.quantity == body.quantity,
                Position.cost_basis == body.cost_basis,
            )
        ).scalars():
            abierta = alertas.como_utc(gemela.opened_at)
            if abs(abierta - opened_at) <= VENTANA_DUPLICADO:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"Posición duplicada: ya hay una de {instrument.symbol} con "
                        f"{body.quantity:g} acciones a {body.cost_basis:g}, abierta "
                        f"el {abierta:%Y-%m-%d %H:%M} UTC (#{gemela.id}). Si de verdad "
                        "es un segundo lote, repite con `confirmar_duplicado: true`."
                    ),
                )

    # El stop se fija AHORA, con la volatilidad de hoy, y no se vuelve a
    # recalcular: recalcularlo cada día lo alejaba justo en las caídas.
    stop = body.stop
    if stop is None and body.cost_basis > 0:
        clase = "cripto" if instrument.symbol.endswith("-USD") else "accion"
        vol = _volatilidad_de(service, instrument.symbol)
        stop = round(body.cost_basis * (1 - _stop_pct(vol, clase) / 100), 4)
    position = Position(
        instrument_id=instrument.id,
        quantity=body.quantity,
        cost_basis=body.cost_basis,
        opened_at=opened_at,
        stop=stop,
    )
    session.add(position)
    thesis_id = _guardar_tesis(session, instrument.id, body.tesis)
    session.commit()
    return {"id": position.id, "symbol": instrument.symbol, "thesis_id": thesis_id}


class StopUpdate(BaseModel):
    stop: float = Field(gt=0, allow_inf_nan=False)


@router.post("/positions/{position_id}/stop")
def fijar_stop(position_id: int, body: StopUpdate, session: Session = Depends(get_session)):
    """Fija el stop de una posición abierta. Subirlo sí; bajarlo, nunca.

    Existe para las posiciones abiertas antes del RC1, que no guardan stop y
    para las que se sigue recalculando con la volatilidad de hoy. Pero bajar un
    stop es exactamente la evasión que se cerró en `f124d24` —alejarlo cuando
    el precio se acerca—, así que no se permite. Subirlo (asegurar beneficio,
    o apretar el riesgo) sí.
    """
    position = session.get(Position, position_id)
    if position is None:
        raise HTTPException(status_code=404, detail="Posición no encontrada")
    if position.closed_at is not None:
        raise HTTPException(status_code=409, detail="La posición está cerrada: ya no tiene stop.")
    actual = datos.precio(position.stop)
    if actual is not None and body.stop < actual:
        raise HTTPException(
            status_code=409,
            detail=(
                f"No se puede bajar el stop de {actual:g} a {body.stop:g}. Bajar un stop "
                "es alejarlo justo cuando el precio se acerca: el control que protege "
                "la posición deja de hacerlo. Si la tesis cambió, cierra la posición."
            ),
        )
    anterior, position.stop = actual, body.stop
    session.commit()
    return {"id": position.id, "stop": position.stop, "anterior": anterior}


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
                    "opened_at": _utc_iso(position.opened_at),
                    "closed_at": _utc_iso(position.closed_at),
                    "currency": _moneda_segura(
                        _resolver_divisa(session, service, instrument, None)
                    ),
                }
            )
            continue
        price, divisa, estado_precio = _cotizacion(service, instrument.symbol)
        divisa = _resolver_divisa(session, service, instrument, divisa)
        metrics = position_metrics(
            {"quantity": position.quantity, "cost_basis": position.cost_basis}, price
        )
        # El stop se recalcula con la MISMA regla que la vista Hoy, anclado a
        # tu coste. Sin él no se puede sumar el riesgo abierto, que es el
        # número que decide si una mala semana es un contratiempo o un agujero.
        clase = "cripto" if instrument.symbol.endswith("-USD") else "accion"
        # El stop FIJADO al abrir manda. Solo las posiciones anteriores a ese
        # cambio (sin stop guardado) lo recalculan, y se marca.
        stop_fijado = datos.precio(position.stop)
        if stop_fijado is not None:
            stop = round(stop_fijado, 2)
        else:
            vol = _volatilidad_de(service, instrument.symbol)
            stop = round(position.cost_basis * (1 - _stop_pct(vol, clase) / 100), 2)
        open_positions.append(
            {
                "id": position.id,
                "symbol": instrument.symbol,
                "name": instrument.name,
                "sector": instrument.sector or "Sin clasificar",
                "asset_class": clase,
                "opened_at": _utc_iso(position.opened_at),
                "stop": stop,
                "stop_fijado_al_abrir": stop_fijado is not None,
                "price": price,
                "precio_estado": estado_precio["estado"] if price is not None else "desconocido",
                "precio_antiguedad_segundos": estado_precio["antiguedad_segundos"],
                "currency": divisa,
                "spark": _spark_cacheado(service, instrument.symbol),
                **metrics,
            }
        )

    # CONVERTIR ANTES DE SUMAR. Hasta aquí `market_value` está cada uno en su
    # moneda; sumarlos directamente daba un total creíble y equivocado, y de ese
    # total cuelgan los pesos, la concentración y el presupuesto de riesgo.
    monedas = {m for p in open_positions if (m := fx.normalizar(p.get("currency")))}
    monedas |= {p["currency"] for p in closed if p.get("currency")}
    tipos, series_fx, _ = _fx_completo(service, monedas)
    realizado_base, realizado_fuera = _realizado_en_base(closed, series_fx)
    divisas = fx.convertir_cartera(open_positions, tipos)
    _coste_al_tipo_de_compra(divisas["posiciones"], series_fx)
    efectos = [p["efecto_divisa_base"] for p in divisas["posiciones"]
               if p.get("efecto_divisa_base") is not None]
    aproximadas = [p["symbol"] for p in divisas["posiciones"] if p.get("coste_al_tipo_de_hoy")]
    divisas["efecto_divisa_base"] = round(sum(efectos), 2) if efectos else None
    divisas["coste_al_tipo_de_hoy"] = aproximadas
    if aproximadas:
        divisas["nota"] += (
            f" El coste de {', '.join(aproximadas[:4])} se convierte al tipo de HOY "
            "porque la serie no llega a su fecha de compra: su P&L en dólares no "
            "incluye el efecto divisa desde que compraste."
        )

    # A partir de aquí se trabaja con los importes YA convertidos, y lo que no
    # se pudo convertir sencillamente no está en la lista.
    convertidas = [
        {**p, "market_value": p.get("market_value_base"), "invested": p.get("invested_base")}
        for p in divisas["posiciones"]
    ]
    summary = portfolio_summary(convertidas)
    by_position = allocation_weights(convertidas, "symbol")
    by_sector = allocation_weights(convertidas, "sector")

    # Qué le habría pasado a ESTA composición en el peor tramo del histórico
    # disponible. No son escenarios inventados: son los pesos que tienes hoy
    # aplicados al pasado que hay guardado, con sus fechas y con el aviso de qué
    # crisis quedan fuera de la cobertura.
    estres = peor_ventana(
        {p["symbol"]: p["market_value"] for p in convertidas if p.get("market_value")},
        _series_cacheadas(service, [p["symbol"] for p in convertidas]),
    )
    return {
        "positions": [
            {**p, "market_value_base": p.get("market_value_base"),
             "invested_base": p.get("invested_base")}
            for p in divisas["posiciones"]
        ]
        + [
            # Las que no se pudieron convertir siguen visibles en la tabla —con
            # su importe en su moneda— pero fuera de todos los totales.
            {**next(o for o in open_positions if o["symbol"] == s_["symbol"]),
             "market_value_base": None, "invested_base": None,
             "sin_convertir": s_["motivo"]}
            for s_ in divisas["sin_convertir"]
            if any(o["symbol"] == s_["symbol"] for o in open_positions)
        ],
        "closed_positions": closed,
        "divisas": {k: v for k, v in divisas.items() if k != "posiciones"},
        # El retorno nunca viaja solo: `con_caida_esperada` le engancha la caída
        # que esta misma cartera habría sufrido. Un «+12 %» y un «+12 % con un
        # −45 % por el camino» son propuestas distintas, y quien solo ve la
        # primera abandona en el peor momento.
        "summary": con_caida_esperada(
            {
                **summary,
                # Convertido a la base, cada cerrada con los tipos de SUS fechas.
                # Antes se sumaba cada una en su moneda: 370 CAD contaban como
                # 370 USD. Lo que no se puede convertir queda fuera y se nombra.
                "realized_pnl": realizado_base,
                "realizado_sin_convertir": realizado_fuera,
                # Las posiciones valoradas con un precio rescatado de caché: el
                # total las incluye —un precio de hace minutos sigue siendo el
                # mejor dato que hay—, pero la pantalla tiene que decirlo.
                "precios_viejos": sorted(
                    p["symbol"] for p in open_positions if p.get("precio_estado") == "viejo"
                ),
            },
            estres
        ),
        "estres": estres,
        "allocation_by_position": by_position,
        "allocation_by_sector": by_sector,
        "concentration_warnings": concentration_warning(by_position),
        # Cada idea se dimensiona para arriesgar un 1 %; lo que no hacía nadie
        # era sumar. Ocho posiciones al 1 % son un 8 % en riesgo simultáneo.
        "risk_budget": presupuesto_de_riesgo(
            convertidas, summary.get("total_market_value")
        ),
        "note": (
            "Las posiciones sin precio disponible se excluyen de los totales y "
            "de los pesos; el resumen indica sobre cuántas se calculó. "
            + divisas["nota"]
        ),
    }


# ---------------------------------------------------------------------------
# Alertas
# ---------------------------------------------------------------------------


class AlertCreate(BaseModel):
    symbol: str = Field(min_length=1, max_length=12)
    op: str = Field(pattern="^(lt|gt)$")
    price: float = Field(gt=0, allow_inf_nan=False)


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


DIAS_FX_HISTORICO = 4000  # ~11 años: cubre cualquier cartera de esta app


def _fx_completo(service: MarketDataService, monedas: set[str]) -> tuple[dict, dict, dict]:
    """UNA descarga larga por divisa, de la que salen el tipo de hoy Y la serie.

    Devuelve (tipos de hoy, series completas, fallos). Pedir la ventana corta
    para el tipo actual y la larga para el histórico eran dos llamadas por
    divisa para el mismo dato.
    """
    tipos, series, fallos = {}, {}, {}
    desde = fx.inicio_de_ventana(dias=DIAS_FX_HISTORICO)
    for moneda in sorted(monedas):
        if moneda == fx.BASE or moneda not in fx.SERIES:
            continue
        try:
            payload = service.get("macro", series_id=fx.SERIES[moneda]["serie"], start=desde)
            puntos = payload.get("points") or []
            series[moneda] = fx.serie_por_usd(moneda, puntos)
            tipos[moneda] = fx.tipo_desde_observaciones(moneda, puntos)
        except (DataNotFoundError, AllProvidersFailedError, fx.SinTipo) as exc:
            fallos[moneda] = str(exc)[:200]
            tipos[moneda] = {"por_usd": None, "error": str(exc)[:200]}
    return tipos, series, fallos


def _series_fx(service: MarketDataService, monedas: set[str]) -> tuple[dict, dict]:
    """Series completas de tipos, para convertir CADA fecha con SU tipo.

    Con el tipo de hoy aplicado a todo el histórico, una depreciación de la
    divisa desaparece del gráfico y lo que movió el cambio parece que lo movió
    la acción.
    """
    _, series, fallos = _fx_completo(service, monedas)
    return series, fallos


@router.get("/historial")
def historial_de_cartera(
    descargar: bool = True,
    session: Session = Depends(get_session),
    service: MarketDataService = Depends(get_service),
):
    """La curva de valor de la cartera, no solo el P&L de hoy.

    Un +17 % que subió en línea recta y otro que llegó ahí tras estar un −30 %
    son la misma cifra y no la misma experiencia. Incluye las posiciones
    CERRADAS hasta su fecha de cierre: sin ellas la curva contaría una historia
    en la que nunca vendiste nada.
    """
    filas = session.execute(
        select(Position, Instrument).join(Instrument, Position.instrument_id == Instrument.id)
    ).all()
    if not filas:
        return {"disponible": False, "nota": "No hay posiciones que recorrer."}

    posiciones, symbols, monedas, sin_moneda = [], [], set(), []
    for position, instrument in filas:
        _, divisa = _precio_y_divisa(service, instrument.symbol)
        try:
            moneda = fx.normalizar(_resolver_divisa(session, service, instrument, divisa))
        except fx.SinTipo:
            moneda = None
        if moneda is None:
            # Sin moneda no entra en la curva: suponer dólar dibujaría una
            # posición canadiense un 37 % más grande de lo que es. Pasa igual
            # a `historial`, que la excluye y la nombra en el aviso de pantalla.
            sin_moneda.append(instrument.symbol)
        else:
            monedas.add(moneda)
        symbols.append(instrument.symbol)
        posiciones.append(
            {
                "symbol": instrument.symbol,
                "quantity": position.quantity,
                "cost_basis": position.cost_basis,
                "currency": moneda,
                "opened_at": position.opened_at.date(),
                "closed_at": position.closed_at.date() if position.closed_at else None,
            }
        )

    series, _ = _historico_largo(service, sorted(set(symbols)), descargar)
    fx_series, fallos_fx = _series_fx(service, monedas)

    resultado = hist.historial(posiciones, series, fx_series, base=fx.BASE)
    return {**resultado, "fallos_de_cambio": fallos_fx, "sin_moneda": sin_moneda}


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
        price, divisa = _precio_y_divisa(service, instrument.symbol)
        crudas.append(
            {
                "symbol": instrument.symbol,
                "name": instrument.name,
                "sector": instrument.sector,
                "currency": _resolver_divisa(session, service, instrument, divisa),
                "market_value": price * position.quantity if price else None,
                "invested": position.cost_basis * position.quantity,
            }
        )

    sin_precio = [p["symbol"] for p in crudas if not p["market_value"]]
    # CONVERTIR ANTES DE PESAR. Este endpoint es anterior a la conversión de
    # divisas y sumaba cada `market_value` en su moneda: con una posición
    # canadiense, todos los pesos —concentración, exposición, estrés— salían
    # mal. Lo que no se puede convertir queda fuera y se nombra.
    monedas = {m for p in crudas if p["market_value"] and (m := _moneda_segura(p["currency"]))}
    divisas = fx.convertir_cartera(
        [p for p in crudas if p["market_value"]], tipos_de_cambio(service, monedas)
    )
    con_precio = [
        {**p, "market_value": p["market_value_base"]}
        for p in divisas["posiciones"]
        if p.get("market_value_base")
    ]
    total = sum(p["market_value"] for p in con_precio)
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
        "sin_convertir": divisas["sin_convertir"],
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
    """Alertas configuradas, evaluadas contra el precio actual (cacheado).

    La evaluación no vive aquí: está en `app.analysis.alertas`, que es el mismo
    módulo que usa `scripts/revisar_alertas.py`. Eso importa más de lo que
    parece — si el comando programado y la pestaña comparasen los precios cada
    uno a su manera, la app podría decir «cumplida» de algo que el cron nunca
    avisó, y no habría forma de saber cuál de los dos tiene razón.
    """
    rows = session.execute(
        select(Alert, Instrument).join(Instrument, Alert.instrument_id == Instrument.id)
    ).all()
    ahora = datetime.now(timezone.utc)
    out = []
    buscar = lambda symbol: service.get("quote", symbol=symbol)  # noqa: E731 — con su estado
    for alert, instrument in rows:
        # La MISMA evaluación que el cron (`app.vigilancia`), sin reintentos:
        # una petición del navegador no debe quedarse dormida esperando.
        if alert.active:
            price, fallo, detalle = vigilancia.obtener_precio(buscar, instrument.symbol, reintentos=0)
        else:
            price, fallo, detalle = None, None, None
        r = vigilancia.evaluar_y_registrar(alert, instrument.symbol, price, fallo, detalle, ahora)
        veredicto = r["veredicto"]
        out.append(
            {
                "id": alert.id,
                "symbol": instrument.symbol,
                "kind": alert.kind,
                "condition": alert.condition or {},
                "active": alert.active,
                "current_price": price,
                # `triggered` sigue siendo tri-estado: None significa «no se ha
                # podido comprobar», que no es lo mismo que False. `estado` y
                # `motivo` dicen por qué, para que la pestaña pueda distinguir
                # una alerta tranquila de una que nadie ha mirado.
                "triggered": veredicto["cumple"] if veredicto["evaluable"] else None,
                "estado": veredicto["estado"],
                "motivo": veredicto["motivo"],
                # Con zona siempre: SQLite la pierde al guardar, y sin marcarla
                # el navegador leería el mismo instante como hora local.
                "triggered_at": (
                    utc.isoformat() if (utc := alertas.como_utc(alert.triggered_at)) else None
                ),
                "last_evaluated_at": (
                    utc.isoformat() if (utc := alertas.como_utc(alert.last_evaluated_at)) else None
                ),
                "last_error": alert.last_error,
                "consecutive_errors": alert.consecutive_errors or 0,
            }
        )
    session.commit()

    return {
        "alerts": out,
        # Si el comando programado existe y ha corrido, esto lo dice. Si no,
        # también: la pestaña no puede prometer avisos que nadie va a mandar.
        "vigilancia": alertas.ultima_pasada(_directorio_de_datos(), ahora),
    }


@router.post("/alerts")
def create_alert(
    body: AlertCreate,
    session: Session = Depends(get_session),
    service: MarketDataService = Depends(get_service),
):
    instrument = get_or_create_instrument(session, body.symbol, service)
    condicion = {"op": body.op, "price": body.price}
    # Dos alertas idénticas mandarían dos avisos idénticos. Crear la misma otra
    # vez devuelve la que ya existe, diciéndolo.
    for existente in session.execute(
        select(Alert).where(
            Alert.instrument_id == instrument.id,
            Alert.kind == "price",
            Alert.active.is_(True),
        )
    ).scalars():
        if existente.condition == condicion:
            return {"id": existente.id, "symbol": instrument.symbol, "duplicada": True}
    alert = Alert(
        instrument_id=instrument.id,
        kind="price",
        condition=condicion,
    )
    session.add(alert)
    session.commit()
    return {"id": alert.id, "symbol": instrument.symbol, "duplicada": False}


@router.delete("/alerts/{alert_id}")
def delete_alert(alert_id: int, session: Session = Depends(get_session)):
    alert = session.get(Alert, alert_id)
    if alert is None:
        raise HTTPException(status_code=404, detail="Alerta no encontrada")
    session.delete(alert)
    session.commit()
    return {"deleted": alert_id}
