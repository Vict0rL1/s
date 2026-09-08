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

from app.analysis.backtest import metrics_from_period
from app.analysis.fundamentals import derive_ratio_series, growth_summary
from app.analysis.markets import DEFAULT_MARKET, list_markets, load_market
from app.analysis.multifactor import (
    FAMILIAS,
    PESOS_POR_DEFECTO,
    historia_de_la_empresa,
    rankear,
    resumen_historico,
)
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
SESIONES_ANO = 252


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


# ---------------------------------------------------------------------------
# Screener multifactor
# ---------------------------------------------------------------------------
#
# Coste de API: CERO llamadas adicionales sobre lo que la lista diaria ya
# descarga. El momentum, el precio y la volatilidad vienen de la descarga masiva
# (una por sector, cacheada 6 h) y los fundamentales de EDGAR, que es gratis y
# está cacheado 24 h. Un screener de seis factores sobre 500 empresas suele ser
# imposible con tiers gratuitos; aquí sale gratis porque reaprovecha lo que ya
# está en la caché.


class MultifactorRequest(BaseModel):
    market: str = Field(DEFAULT_MARKET, max_length=32)
    # Pesos en cualquier escala: lo que importa es la proporción entre ellos.
    weights: dict[str, float] = Field(default_factory=dict)
    # Cuántas empresas del ranking traen su historia frente a sí mismas.
    con_historia: int = Field(15, ge=0, le=50)
    budget: int = Field(60, ge=1, le=500)


def _fetch(service: MarketDataService, data_type: str, **kwargs):
    try:
        return service.get(data_type, **kwargs)
    except (DataNotFoundError, AllProvidersFailedError):
        return None


def _vol_anual_pct(precio: dict | None) -> float | None:
    """Volatilidad anualizada desde la diaria que ya trae la descarga masiva."""
    diaria = (precio or {}).get("daily_vol_pct")
    return round(diaria * (SESIONES_ANO**0.5), 2) if diaria else None


def _reunir(
    service: MarketDataService, market_data: dict, budget: int
) -> tuple[list[dict], list[dict], list[str], dict]:
    """Todo lo que necesitan los seis factores, sin gastar una llamada de más.

    Devuelve (empresas, sin_datos, pendientes, series_anuales). `series_anuales`
    guarda los ratios ejercicio a ejercicio de cada empresa: es lo que alimenta
    el percentil histórico, y sale del mismo `financials` que ya se descargó
    para los factores.
    """
    empresas: list[dict] = []
    sin_datos: list[dict] = []
    pendientes: list[str] = []
    series: dict[str, list[dict]] = {}
    restante = budget

    for sector, companies in market_data["sectors"].items():
        symbols = [c["symbol"] for c in companies]
        nombres = {c["symbol"]: c["name"] for c in companies}
        bulk = _fetch(service, "bulk_momentum", symbols=symbols) or {}
        momentum = bulk.get("momentum") or {}
        precios = bulk.get("prices") or {}

        for symbol in symbols:
            precio = precios.get(symbol) or {}
            ultimo = precio.get("last")

            # EDGAR es gratis, pero una primera pasada sobre 500 empresas son
            # 500 descargas: lo cacheado no cuesta y lo nuevo va con
            # presupuesto, igual que en la lista diaria. Lo que no entra queda
            # en `pendientes` y la siguiente petición sigue por donde iba.
            financials = service.cache.get("financials", {"symbol": symbol})
            if financials is None:
                if restante <= 0:
                    pendientes.append(symbol)
                    continue
                restante -= 1
                financials = _fetch(service, "financials", symbol=symbol)

            metrics: dict = {}
            crecimiento: dict = {}
            market_cap = None
            periodos = (financials or {}).get("periods") or []
            if periodos and ultimo:
                periodo = periodos[-1]
                acciones = periodo.get("shares_outstanding")
                metrics = metrics_from_period(periodo, ultimo, acciones)
                ratios = derive_ratio_series(periodos)
                series[symbol] = ratios
                # ROIC no sale de `metrics_from_period` y es de los mejores
                # indicadores de calidad que hay: se toma de la serie anual,
                # que ya está calculada.
                if ratios:
                    metrics["roic"] = ratios[-1].get("roic")
                crecimiento = growth_summary(periodos)
                if acciones:
                    market_cap = ultimo * acciones

            tiene_algo = (
                any(v is not None for v in metrics.values())
                or momentum.get(symbol) is not None
                or precio.get("daily_vol_pct") is not None
            )
            if not tiene_algo:
                sin_datos.append({"symbol": symbol, "motivo": "sin fundamentales ni precio"})
                continue

            empresas.append(
                {
                    "symbol": symbol,
                    "name": nombres.get(symbol),
                    "sector": sector,
                    "metrics": metrics,
                    "momentum": momentum.get(symbol),
                    "vol_anual_pct": _vol_anual_pct(precio),
                    "market_cap": market_cap,
                    "crecimiento": crecimiento,
                    "price": ultimo,
                }
            )

    return empresas, sin_datos, pendientes, series


@router.get("/multifactor/meta")
def multifactor_meta():
    """Las familias, sus pesos de partida y los mercados disponibles."""
    return {
        "familias": {f: FAMILIAS[f] for f in FAMILIAS},
        "pesos_por_defecto": PESOS_POR_DEFECTO,
        "markets": list_markets(),
    }


@router.post("/multifactor")
def run_multifactor(
    request: MultifactorRequest = Body(...),
    service: MarketDataService = Depends(get_service),
):
    """Ranking multifactor sobre un mercado, con los pesos que tú decidas.

    Dos cosas que lo separan de un screener normal:

    1. **Todo se normaliza dentro del sector.** Un P/E de 9 es caro en banca y
       barato en software, y un corte absoluto llenaría cualquier lista de
       bancos y utilities todos los años.
    2. **Cada métrica trae su percentil frente a la propia historia de la
       empresa.** El corte transversal dice quién va mejor hoy; solo la serie
       temporal dice si eso es normal en ellos o un extremo del que se vuelve.
    """
    try:
        market_data = load_market(request.market)
    except KeyError:
        raise HTTPException(
            status_code=404, detail=f"Mercado desconocido: {request.market}"
        ) from None

    empresas, sin_datos, pendientes, series = _reunir(
        service, market_data, request.budget
    )
    if not empresas:
        raise HTTPException(
            status_code=502,
            detail=(
                "No se pudo reunir datos de ninguna empresa. Vuelve a intentarlo: "
                "la primera pasada descarga los estados financieros de EDGAR y "
                "se cachean 24 h."
            ),
        )

    try:
        resultado = rankear(empresas, request.weights or None)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None

    nombres = {e["symbol"]: e.get("name") for e in empresas}
    precios = {e["symbol"]: e.get("price") for e in empresas}
    for fila in resultado["ranking"]:
        fila["name"] = nombres.get(fila["symbol"])
        fila["price"] = precios.get(fila["symbol"])

    # La historia solo para las primeras: no por coste —ya está descargada— sino
    # porque una tabla de percentiles de 500 empresas no la lee nadie.
    for fila in resultado["ranking"][: request.con_historia]:
        anual = series.get(fila["symbol"]) or []
        if not anual:
            fila["historia"] = {"medidas": 0, "metricas": {}}
            continue
        historia = historia_de_la_empresa(anual, anual[-1])
        fila["historia"] = {
            "metricas": historia,
            "ejercicios": len(anual),
            "desde": anual[0].get("fiscal_year"),
            "hasta": anual[-1].get("fiscal_year"),
            **resumen_historico(historia),
        }

    return {
        **resultado,
        "market_key": request.market,
        "market_name": market_data["name"],
        "evaluadas": len(empresas),
        "sin_datos": sin_datos,
        "pendientes": pendientes,
        "completo": not pendientes,
        "nota_cobertura": (
            f"Faltan {len(pendientes)} empresas por descargar. Los estados "
            "financieros se traen de EDGAR (gratis) y se cachean 24 h: vuelve a "
            "lanzarlo y seguirá por donde iba hasta completar el mercado."
            if pendientes
            else f"Universo completo: {len(empresas)} empresas evaluadas."
        ),
        "nota_coste": (
            "Este screener no gasta ni una llamada más que la lista diaria: "
            "momentum, precio y volatilidad salen de la descarga masiva por "
            "sector, y los fundamentales de EDGAR, que es gratis."
        ),
    }
