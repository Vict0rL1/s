"""Informe de analista completo sobre una empresa.

Coste de API: la mayor parte del informe sale de EDGAR (gratis) y de datos ya
cacheados. La narrativa del LLM es opcional y va bajo botón aparte, para que
puedas leer el informe entero sin gastar nada en Claude.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.analysis.deep_dive import assemble
from app.analysis.factors import build_raw_factors, composite_score, family_scores, zscores
from app.analysis.fundamentals import derive_ratio_series, growth_summary
from app.analysis.signal import build_signal
from app.analysis.valuation_history import valuation_vs_history
from app.cache.cache import MarketDataService
from app.db.engine import get_session
from app.db.models import LlmOutput
from app.deps import get_llm, get_service
from app.llm.base import LLMProvider, LLMUnavailableError
from app.providers.base import DataNotFoundError
from app.providers.router import AllProvidersFailedError

router = APIRouter(prefix="/api/deep-dive", tags=["deep-dive"])

_SYMBOL_RE = re.compile(r"^[A-Za-z0-9.\-]{1,12}$")

NARRATIVE_SYSTEM = """Eres un analista de renta variable escribiendo para un \
estudiante de finanzas. Recibes un informe YA CALCULADO con cifras reales.

Reglas estrictas:
- NUNCA inventes, redondees ni ajustes cifras: usa exactamente las que te doy.
- Si un dato falta, dilo; no lo estimes.
- NUNCA des precio objetivo ni digas "comprar"/"vender".
- Explica el NEGOCIO detrás de los números: qué implica un margen así en este \
sector, qué significa esa conversión de caja, por qué importa ese apalancamiento.
- Sé concreto sobre la principal debilidad del análisis (cobertura de datos, \
años de historia, factores ausentes).
- Estructura en secciones cortas con estos encabezados exactos:
  ## El negocio
  ## Lo que dicen los números
  ## Valoración
  ## Qué vigilar (6-18 meses)
  ## Lectura final
- En "Lectura final", sintetiza sin recomendar: di qué tendría que ser cierto \
para que la tesis alcista funcione y qué la rompería.
- Español, máximo 600 palabras, Markdown."""


def _validate(symbol: str) -> str:
    if not _SYMBOL_RE.match(symbol):
        raise HTTPException(status_code=422, detail=f"Símbolo inválido: {symbol}")
    return symbol.upper()


def _safe(service: MarketDataService, data_type: str, **kwargs):
    try:
        return service.get(data_type, **kwargs)
    except (DataNotFoundError, AllProvidersFailedError):
        return None


def _peer_signal(service: MarketDataService, symbol: str, metrics: dict) -> dict | None:
    """Puntúa la empresa contra sus pares para incluir la señal cuantitativa."""
    peers_payload = _safe(service, "peers", symbol=symbol)
    if not peers_payload:
        return None
    universe = [symbol, *peers_payload["peers"][:6]]

    raw: dict[str, dict] = {}
    for sym in universe:
        fundamentals = _safe(service, "fundamentals", symbol=sym)
        if fundamentals is None:
            continue
        raw[sym] = build_raw_factors(
            dict(fundamentals["metrics"]) if sym != symbol else metrics, None, None
        )
    if len(raw) < 3:
        return None

    factor_names = {f for values in raw.values() for f in values}
    factor_z = {
        factor: zscores({s: values.get(factor) for s, values in raw.items()})
        for factor in factor_names
    }
    families = family_scores(factor_z)
    composite = composite_score({f: families[f].get(symbol) for f in families})
    signal = build_signal(symbol, composite, None, horizon="6-12 meses")
    signal["peer_group"] = list(raw)
    return signal


@router.get("/{symbol}")
def deep_dive(
    symbol: str,
    history_years: int = Query(10, ge=3, le=15),
    service: MarketDataService = Depends(get_service),
):
    """Informe completo: negocio, financieros, valoración, riesgos y veredicto.

    Todo calculado a partir de datos. La narrativa del LLM va aparte.
    """
    symbol = _validate(symbol)

    financials = _safe(service, "financials", symbol=symbol)
    if financials is None or not financials.get("periods"):
        raise HTTPException(
            status_code=404,
            detail=(
                f"Sin estados financieros para {symbol} en SEC EDGAR. El informe "
                "necesita histórico auditado; EDGAR solo cubre empresas "
                "registradas en la SEC (no aplica a cotizadas extranjeras sin ADR)."
            ),
        )
    periods = financials["periods"]
    financials = {**financials, "ratios": derive_ratio_series(periods)}

    profile = _safe(service, "profile", symbol=symbol) or {"symbol": symbol}
    quote = _safe(service, "quote", symbol=symbol)
    history = _safe(service, "price_history", symbol=symbol, interval="1day", outputsize=5000)
    filings_payload = _safe(service, "filings", symbol=symbol) or {}

    valuation = valuation_vs_history(
        periods,
        filings_payload.get("filings", []),
        (history or {}).get("bars", []),
        (quote or {}).get("price"),
        years=history_years,
    )

    # Riesgo de mercado desde el histórico ya descargado (coste cero).
    risk = None
    if history and history.get("bars"):
        import pandas as pd

        from app.analysis.risk import annualized_volatility, daily_returns, max_drawdown

        closes = pd.Series(
            [b["close"] for b in history["bars"][-252:]],
            index=[b["ts"][:10] for b in history["bars"][-252:]],
        )
        risk = {
            "annualized_volatility": annualized_volatility(daily_returns(closes)),
            "max_drawdown": max_drawdown(closes),
        }

    fundamentals = _safe(service, "fundamentals", symbol=symbol)
    signal = (
        _peer_signal(service, symbol, dict(fundamentals["metrics"]))
        if fundamentals
        else None
    )

    today = datetime.now(timezone.utc).date()
    calendar = _safe(
        service,
        "earnings_calendar",
        start=today.isoformat(),
        end=(today + timedelta(days=120)).isoformat(),
    )
    earnings = [
        e for e in (calendar or {}).get("events", []) if e.get("symbol") == symbol
    ]

    report = assemble(
        symbol=symbol,
        profile=profile,
        financials=financials,
        valuation=valuation,
        quote=quote,
        risk=risk,
        signal=signal,
        earnings=earnings,
        filings=filings_payload.get("filings", []),
        events=[],
        dcf=_dcf_defaults(periods, quote),
    )
    report["generated_at"] = datetime.now(timezone.utc).isoformat()
    return report


def _dcf_defaults(periods: list[dict], quote: dict | None) -> dict | None:
    """Punto de partida del DCF con los datos del informe, para no obligar a
    ir a otra pestaña a calcularlo."""
    from app.analysis.fundamentals import free_cash_flow, total_debt
    from app.analysis.valuation import scenario_set

    latest = periods[-1]
    fcf = free_cash_flow(latest)
    shares = latest.get("shares_outstanding")
    if fcf is None or fcf <= 0 or not shares:
        return None

    growth = growth_summary(periods)
    base_growth = growth.get("fcf_cagr") or growth.get("revenue_cagr") or 0.04
    base_growth = max(0.0, min(base_growth, 0.15))
    debt = total_debt(latest)
    net_debt = (debt - (latest.get("cash") or 0.0)) if debt is not None else 0.0

    scenarios = scenario_set(
        {
            "bear": {"growth_rate": max(base_growth - 0.04, -0.02), "discount_rate": 0.12, "terminal_growth": 0.015},
            "base": {"growth_rate": base_growth, "discount_rate": 0.10, "terminal_growth": 0.025},
            "bull": {"growth_rate": base_growth + 0.04, "discount_rate": 0.09, "terminal_growth": 0.03},
        },
        base_fcf=fcf,
        years=5,
        net_debt=net_debt,
        shares_outstanding=shares,
    )
    return {
        "scenarios": scenarios,
        "base_fcf": fcf,
        "net_debt": net_debt,
        "shares_outstanding": shares,
        "current_price": (quote or {}).get("price"),
        "note": (
            "Supuestos de partida derivados del histórico, acotados al 15 % de "
            "crecimiento. Edítalos en la pestaña Valoración: el resultado es muy "
            "sensible a la tasa de descuento y al crecimiento terminal."
        ),
    }


@router.post("/{symbol}/narrative")
def narrative(
    symbol: str,
    report: dict = Body(...),
    llm: LLMProvider | None = Depends(get_llm),
    session: Session = Depends(get_session),
):
    """Narrativa del informe escrita por Claude sobre las cifras calculadas."""
    symbol = _validate(symbol)
    if llm is None:
        raise HTTPException(
            status_code=503,
            detail="Capa de IA no configurada: añade ANTHROPIC_API_KEY en .env",
        )

    prompt = _narrative_prompt(symbol, report)
    try:
        result = llm.interpret(NARRATIVE_SYSTEM, prompt)
    except LLMUnavailableError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    session.add(
        LlmOutput(
            kind="deep_dive_narrative",
            content_md=result["content"],
            model=result["model"],
        )
    )
    session.commit()
    return {
        "generated_by": "llm",
        "content_md": result["content"],
        "model": result["model"],
        "disclaimer": (
            "Narrativa generada por IA sobre cifras calculadas por la app. La IA "
            "no produjo ningún número; puede malinterpretar el contexto del "
            "negocio o del sector."
        ),
    }


def _narrative_prompt(symbol: str, report: dict) -> str:
    """Resume el informe en texto compacto para el modelo (acota tokens)."""
    business = report.get("business", {})
    growth = report.get("growth", {})
    margins = report.get("margins", {})
    debt = report.get("debt", {})
    cash = report.get("cash_flow", {})
    valuation = report.get("valuation", {})
    verdict = report.get("verdict", {})

    def pct(v):
        return f"{v * 100:.1f} %" if isinstance(v, (int, float)) else "sin dato"

    multiples = valuation.get("multiples", {})
    val_lines = []
    for key, label in (("pe", "P/E"), ("pb", "P/B"), ("fcf_yield", "FCF yield")):
        entry = multiples.get(key, {})
        if entry.get("available"):
            val_lines.append(
                f"- {label}: actual {entry.get('current'):.2f}, mediana histórica "
                f"{entry.get('median'):.2f}, rango {entry.get('min'):.2f}–{entry.get('max'):.2f} "
                f"(percentil {pct(entry.get('percentile'))}, {entry.get('n')} observaciones)"
            )

    risks = "\n".join(
        f"- [{r['severity']}] {r['type']}: {r['evidence']}" for r in report.get("risks", [])
    )
    catalysts = "\n".join(
        f"- {c['type']} ({c.get('when') or 'sin fecha'}): {c.get('detail')}"
        for c in report.get("catalysts", [])[:6]
    )

    return f"""EMPRESA: {symbol} — {business.get('name') or 'sin nombre'}
Sector: {business.get('sector') or 'desconocido'}
Ingresos último ejercicio ({business.get('latest_fiscal_year')}): {business.get('latest_revenue')}
Años de histórico disponibles: {business.get('years_of_history')}
Precio actual: {report.get('price')}

CRECIMIENTO
CAGR ingresos 5A: {pct(growth.get('revenue_cagr'))} | 3A: {pct(growth.get('revenue_cagr_3y'))}
CAGR EPS 5A: {pct(growth.get('eps_cagr'))} | CAGR FCF 5A: {pct(growth.get('fcf_cagr'))}
Tendencia: {growth.get('acceleration') or 'sin determinar'}

MÁRGENES
Bruto {pct(margins.get('current', {}).get('gross_margin'))} | Operativo {pct(margins.get('current', {}).get('operating_margin'))} | Neto {pct(margins.get('current', {}).get('net_margin'))}
Tendencia del margen operativo: {margins.get('trends', {}).get('operating_margin') or 'sin determinar'}

DEUDA
Deuda neta: {debt.get('net_debt')} | Deuda/capital: {debt.get('debt_to_equity')}
Cobertura de intereses: {debt.get('interest_coverage')}
Altman Z: {(debt.get('altman_z') or {}).get('score')} (zona {(debt.get('altman_z') or {}).get('zone')})
Piotroski F: {(debt.get('piotroski_f') or {}).get('score')}/{(debt.get('piotroski_f') or {}).get('max_possible')}

CAJA
FCF último ejercicio: {cash.get('current', {}).get('fcf')}
Conversión beneficio→caja: {pct(cash.get('current', {}).get('fcf_conversion'))}
Intensidad de capex: {pct(cash.get('current', {}).get('capex_intensity'))}
Tendencia del FCF: {cash.get('fcf_trend') or 'sin determinar'}

VALORACIÓN FRENTE A SU PROPIA HISTORIA ({valuation.get('years_covered')} años)
{chr(10).join(val_lines) or '- Sin histórico suficiente'}
Lectura: {valuation.get('reading')}

SEÑAL CUANTITATIVA (frente a sus pares)
{(report.get('quant_signal') or {}).get('label', 'no disponible')} · z-score {(report.get('quant_signal') or {}).get('score')}

RIESGOS DETECTADOS EN LOS DATOS
{risks or '- Ninguno relevante detectado'}

CATALIZADORES PRÓXIMOS
{catalysts or '- Ninguno identificado'}

VEREDICTO CALCULADO: postura {verdict.get('stance')}
A favor: {'; '.join(verdict.get('positives', [])) or 'ninguno'}
En contra: {'; '.join(verdict.get('negatives', [])) or 'ninguno'}

Escribe el informe."""
