"""Señales del mercado de opciones, servidas AL LADO del fundamental.

## Por qué esto no devuelve un score

El endpoint devuelve cuatro bloques separados y ninguno se suma a los demás ni
al análisis fundamental. Es una decisión, no una omisión: lo que hace útil a
este panel es que puede contradecir al fundamental —una empresa barata con la
volatilidad implícita disparada está diciendo dos cosas a la vez— y un número
único promedia esa contradicción hasta borrarla, justo cuando es lo más
informativo que hay en pantalla.

## De dónde sale cada cosa

- **Cadena de opciones** — yfinance, acotada a los primeros vencimientos.
- **Precios** — el histórico largo que ya se descarga para el estrés de cartera,
  reutilizado aquí sin gastar una llamada más.
- **Fechas de resultados** — el calendario de Finnhub, hacia atrás para medir
  los movimientos reales y hacia adelante para el implícito.
- **La base histórica** — `options_snapshots`, que este mismo endpoint alimenta.
  Sin ella no hay «respecto a su media», y se dice en vez de comparar contra un
  umbral universal que no significa nada por empresa.
"""

from __future__ import annotations

import re
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.analysis import options as opt
from app.cache.cache import MarketDataService
from app.db.engine import get_session
from app.db.models import OptionsSnapshot
from app.deps import get_service
from app.providers.base import DataNotFoundError
from app.providers.router import AllProvidersFailedError

router = APIRouter(prefix="/api/options", tags=["options"])

_SYMBOL_RE = re.compile(r"^[A-Za-z0-9.\-]{1,12}$")

# Cuántos trimestres hacia atrás se miran para el movimiento real en resultados.
# Ocho son dos años: suficiente para una mediana y poco para que la empresa de
# entonces siga siendo esta.
TRIMESTRES_ATRAS = 8
# Cuánto histórico de precios hace falta alrededor de esos resultados.
DIAS_HISTORICO = 900


def _validar(symbol: str) -> str:
    if not _SYMBOL_RE.match(symbol):
        raise HTTPException(status_code=422, detail=f"Símbolo inválido: {symbol}")
    return symbol.upper()


def _cierres(service: MarketDataService, symbol: str) -> list[tuple[date, float]]:
    """Cierres diarios del histórico largo YA cacheado, sin descargar nada.

    El estrés de cartera ya baja veinte años por posición y los guarda una
    semana. Volver a pedirlos aquí sería pagar dos veces por el mismo dato, así
    que si no están se trabaja sin ellos y se dice qué se pierde.
    """
    cache = getattr(service, "cache", None)
    payload = cache.get("price_history_long", {"symbol": symbol}) if cache else None
    if payload is None:
        # El corto (252 barras) llega para la volatilidad realizada de 30 días,
        # aunque no para los movimientos en resultados de hace dos años.
        payload = (
            cache.get("price_history", {"symbol": symbol, "interval": "1day", "outputsize": 252})
            if cache
            else None
        )
    puntos = []
    for bar in (payload or {}).get("bars") or []:
        cierre, ts = bar.get("close"), bar.get("ts")
        if not cierre or not ts:
            continue
        try:
            puntos.append((date.fromisoformat(str(ts)[:10]), float(cierre)))
        except ValueError:
            continue
    return sorted(puntos)


def _fechas_de_resultados(
    service: MarketDataService, symbol: str, hoy: date
) -> tuple[list[date], date | None, str | None]:
    """Resultados pasados (para el movimiento real) y el próximo (para el implícito).

    El calendario de Finnhub cubre pasado y futuro en el mismo endpoint, así que
    una ventana que abarque ambos lados sale por una sola llamada.
    """
    desde = (hoy - timedelta(days=DIAS_HISTORICO)).isoformat()
    hasta = (hoy + timedelta(days=120)).isoformat()
    try:
        payload = service.get("earnings_calendar", start=desde, end=hasta)
    except (DataNotFoundError, AllProvidersFailedError) as exc:
        return [], None, str(exc)[:200]

    pasadas, futuras = [], []
    for ev in payload.get("events") or []:
        if (ev.get("symbol") or "").upper() != symbol:
            continue
        try:
            f = date.fromisoformat(str(ev.get("date"))[:10])
        except (TypeError, ValueError):
            continue
        (pasadas if f < hoy else futuras).append(f)

    pasadas.sort()
    futuras.sort()
    return pasadas[-TRIMESTRES_ATRAS:], (futuras[0] if futuras else None), None


def _base_historica(session: Session, symbol: str, hoy: date) -> dict:
    """Lo que este endpoint ha ido guardando de esta empresa, SIN el día de hoy.

    Es lo que convierte «IV del 45 %» en «IV en el percentil 90 DE ESTA
    EMPRESA», que es la única versión de la frase que sirve para decidir algo.

    Hoy se excluye a propósito. La instantánea del día se escribe al final de
    cada consulta, así que a partir de la segunda del día la fila de hoy ya
    estaría dentro: la media se compararía consigo misma —efecto pequeño— y la
    variación de open interest daría 0 % siempre, que no es un efecto pequeño
    sino la señal entera apagada.
    """
    filas = (
        session.execute(
            select(OptionsSnapshot)
            .where(OptionsSnapshot.symbol == symbol, OptionsSnapshot.fecha != hoy.isoformat())
            .order_by(OptionsSnapshot.fecha)
        )
        .scalars()
        .all()
    )
    return {
        "prima": [f.prima for f in filas if f.prima is not None],
        "volumen": [f.volumen_total for f in filas if f.volumen_total is not None],
        # El open interest se guardaba y no se comparaba con nada: el juicio de
        # «inusual» se emitía solo sobre el volumen, que es la mitad ruidosa.
        "oi": [f.oi_total for f in filas if f.oi_total is not None],
        "skew": [f.skew_25d for f in filas if f.skew_25d is not None],
        "desde": filas[0].fecha if filas else None,
        "n": len(filas),
    }


def _guardar_instantanea(session: Session, symbol: str, panel: dict, hoy: date) -> None:
    """Una fila por símbolo y día, para que la base crezca sola.

    Se sobrescribe la del día en curso en vez de añadir: abrir el panel diez
    veces en una tarde no debe pesar diez veces en la media, que es como se
    fabrica una «media» que en realidad describe una sola sesión.
    """
    prima = panel.get("prima_de_riesgo") or {}
    act = panel.get("actividad") or {}
    fila = session.execute(
        select(OptionsSnapshot).where(
            OptionsSnapshot.symbol == symbol, OptionsSnapshot.fecha == hoy.isoformat()
        )
    ).scalar_one_or_none()
    if fila is None:
        fila = OptionsSnapshot(symbol=symbol, fecha=hoy.isoformat())
        session.add(fila)

    fila.spot = panel.get("spot")
    fila.iv_30d = prima.get("iv")
    fila.rv_30d = prima.get("rv")
    fila.prima = prima.get("prima")
    fila.skew_25d = (panel.get("skew") or {}).get("skew")
    fila.volumen_total = (act.get("volumen_calls") or 0) + (act.get("volumen_puts") or 0)
    fila.oi_total = (act.get("oi_calls") or 0) + (act.get("oi_puts") or 0)
    session.commit()


@router.get("/{symbol}")
def señales_de_opciones(
    symbol: str,
    vencimientos: int = Query(6, ge=2, le=12),
    session: Session = Depends(get_session),
    service: MarketDataService = Depends(get_service),
):
    """Las cuatro señales de opciones de una empresa, cada una con su cobertura.

    Prima de riesgo (implícita contra realizada), skew y estructura temporal,
    movimiento esperado antes de resultados contra el real de esta empresa, y
    actividad inusual. Separadas, sin score, y al lado del fundamental.
    """
    symbol = _validar(symbol)
    hoy = date.today()

    try:
        cadena = service.get("options_chain", symbol=symbol, max_expiraciones=vencimientos)
    except DataNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail=(
                f"{symbol} no cotiza opciones, o no hay cadena disponible: {exc}. "
                "Muchas empresas pequeñas y casi todas las no estadounidenses no "
                "tienen mercado de opciones."
            ),
        ) from exc
    except AllProvidersFailedError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    spot = cadena.get("spot")
    if not spot:
        raise HTTPException(
            status_code=502,
            detail="La cadena llegó sin precio de la acción; sin él no hay nada relativo.",
        )

    # A tipos de Python: el analizador trabaja con `date`, no con cadenas.
    contratos = []
    for c in cadena.get("contratos") or []:
        try:
            venc = date.fromisoformat(c["vencimiento"])
        except (TypeError, ValueError, KeyError):
            continue
        cruce = None
        if c.get("ultimo_cruce"):
            try:
                cruce = date.fromisoformat(c["ultimo_cruce"])
            except ValueError:
                cruce = None
        if c.get("strike") is None or c.get("iv") is None:
            continue
        contratos.append({**c, "vencimiento": venc, "ultimo_cruce": cruce})

    por_vencimiento: dict[date, list[dict]] = {}
    for c in contratos:
        por_vencimiento.setdefault(c["vencimiento"], []).append(c)

    cierres = _cierres(service, symbol)
    pasadas, proxima, fallo_calendario = _fechas_de_resultados(service, symbol, hoy)
    base = _base_historica(session, symbol, hoy)

    panel = opt.panel(
        por_vencimiento,
        float(spot),
        cierres,
        fechas_resultados=pasadas,
        proxima_resultados=proxima,
        base=base,
        hoy=hoy,
    )

    if panel.get("disponible"):
        _guardar_instantanea(session, symbol, panel, hoy)

    return {
        **panel,
        "symbol": symbol,
        "fuente": cadena.get("source"),
        "cacheado": cadena.get("cached", False),
        "as_of": cadena.get("as_of"),
        "vencimientos_leidos": cadena.get("expiraciones"),
        "vencimientos_totales": cadena.get("expiraciones_totales"),
        "base_historica": {
            "n": base["n"],
            "desde": base["desde"],
            "nota": (
                f"{base['n']} lectura(s) guardadas desde {base['desde']}. Los juicios "
                "de «alto» o «inusual» se hacen contra esta historia, no contra un "
                "umbral universal: un 40 % de IV es tranquilidad en una "
                "biotecnológica y pánico en una eléctrica."
                if base["n"]
                else "Primera lectura de esta empresa. Los percentiles aparecerán "
                "según se vaya consultando: no hay forma de saber si lo de hoy es "
                "mucho sin saber qué es lo normal aquí."
            ),
        },
        "sin_precios": not cierres,
        "fallo_calendario": fallo_calendario,
        "nota_precios": (
            None
            if cierres
            else "Sin histórico de precios en caché no hay volatilidad realizada ni "
            "movimientos pasados en resultados. Ábrelo en Cartera o en la ficha del "
            "valor y vuelve."
        ),
    }
