"""Módulo de valoración: DCF por escenarios, DCF inverso y comparables ajustados.

Las cuatro piezas contestan preguntas distintas y ninguna es suficiente sola:

1. **DCF por escenarios** — «¿cuánto vale si pasa esto?». Supuestos visibles y
   editables, y cada escenario devuelve un RANGO.
2. **DCF inverso** — «¿qué hay que creerse para que el precio de hoy sea
   correcto?». Es la más útil de las cuatro, porque no exige acertar un número:
   exige juzgar si lo que el precio descuenta es plausible.
3. **Comparables ajustados por crecimiento y calidad** — «¿cotiza donde cotizan
   empresas parecidas *de verdad*?», que no es lo mismo que compararla con la
   mediana del sector.
4. **Sensibilidad ordenada** — «¿qué supuesto decide el resultado?». Casi
   siempre es el WACC o el crecimiento a perpetuidad, y saberlo cambia dónde se
   pone el esfuerzo.

**Ningún endpoint de este módulo devuelve un precio objetivo único.** No es una
convención de presentación: no existe en el código ningún campo que contenga uno.
Los escenarios devuelven `bajo/centro/alto`, los comparables devuelven un
intervalo de predicción y el DCF inverso devuelve una curva. Si algún día alguien
quiere enseñar un número solo, tendrá que escribir la línea que lo colapse, y
entonces será una decisión visible en un diff en vez de un descuido.

Coste: el DCF y el inverso son aritmética local, cero llamadas. Los comparables
reutilizan `peers` (cacheado 7 días) y `fundamentals` de hasta 6 pares (24 h).
"""

from __future__ import annotations

import re

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.analysis.fundamentals import free_cash_flow, growth_summary, total_debt
from app.analysis.relative_value import (
    ajustar_por_crecimiento_y_calidad,
    rango_de_precio_implicito,
)
from app.analysis.reverse_dcf import (
    curva_de_crecimiento_implicito,
    juzgar_contra_el_pasado,
    margen_implicito,
    resumen as resumen_inverso,
)
from app.analysis.valuation import rango_de_valor, redondear, sensibilidad_ordenada
from app.cache.cache import MarketDataService
from app.db.engine import get_session
from app.deps import get_service
from app.providers.base import DataNotFoundError
from app.providers.router import AllProvidersFailedError

router = APIRouter(prefix="/api/valuation", tags=["valuation"])

_SYMBOL_RE = re.compile(r"^[A-Za-z0-9.\-]{1,12}$")
MAX_PARES = 6

# Supuestos de partida de cada escenario. Son un PUNTO DE ARRANQUE editable, no
# una opinión de la app: el crecimiento sale del histórico de la propia empresa y
# los WACC son el rango habitual para una cotizada grande. Todo esto viaja en la
# respuesta para que se pueda discutir y cambiar.
FACTOR_CRECIMIENTO = {"bajista": 0.4, "base": 1.0, "alcista": 1.5}
DESCUENTO = {"bajista": 0.11, "base": 0.09, "alcista": 0.08}
TERMINAL = {"bajista": 0.015, "base": 0.025, "alcista": 0.030}
CRECIMIENTO_MAXIMO = 0.15  # el pasado no se extrapola alegremente
ANOS = 5


class Escenario(BaseModel):
    growth_rate: float = Field(ge=-0.5, le=1.0)
    discount_rate: float = Field(gt=0.0, le=0.40)
    terminal_growth: float = Field(ge=-0.02, le=0.06)


class ValoracionRequest(BaseModel):
    """Todo opcional: sin cuerpo, la app propone supuestos desde el histórico."""

    escenarios: dict[str, Escenario] | None = None
    years: int = Field(ANOS, ge=3, le=10)
    base_fcf: float | None = None
    net_debt: float | None = None
    shares_outstanding: float | None = None


def _validar(symbol: str) -> str:
    if not _SYMBOL_RE.match(symbol):
        raise HTTPException(status_code=422, detail=f"Símbolo inválido: {symbol}")
    return symbol.upper()


def _traer(service: MarketDataService, tipo: str, **kw):
    try:
        return service.get(tipo, **kw)
    except (DataNotFoundError, AllProvidersFailedError):
        return None


def _cimientos(service: MarketDataService, symbol: str) -> dict:
    """Los datos reales sobre los que se monta todo, con su procedencia."""
    financials = _traer(service, "financials", symbol=symbol)
    if not financials or not financials.get("periods"):
        raise HTTPException(
            status_code=404,
            detail=(
                f"Sin estados financieros de la SEC para {symbol}. Las empresas no "
                "estadounidenses y los ETFs no presentan 10-K, así que este módulo "
                "no las cubre."
            ),
        )
    periodos = financials["periods"]
    ultimo = periodos[-1]
    deuda = total_debt(ultimo)
    quote = _traer(service, "quote", symbol=symbol)

    return {
        "periodos": periodos,
        "base_fcf": free_cash_flow(ultimo),
        "net_debt": (deuda - (ultimo.get("cash") or 0.0)) if deuda is not None else 0.0,
        "shares_outstanding": ultimo.get("shares_outstanding"),
        "revenue": ultimo.get("revenue"),
        "eps": ultimo.get("eps_diluted"),
        "crecimiento": growth_summary(periodos),
        "precio": (quote or {}).get("price"),
        "fiscal_year": ultimo.get("fiscal_year"),
        "source": financials.get("source", "edgar"),
    }


def _escenarios_por_defecto(crecimiento: dict) -> dict[str, dict]:
    """Propone bajista/base/alcista desde el crecimiento histórico real.

    Se acota al 15 %: extrapolar a perpetuidad el mejor quinquenio de una empresa
    es el error más común del DCF casero, y el que más caro sale.
    """
    historico = crecimiento.get("fcf_cagr") or crecimiento.get("revenue_cagr") or 0.03
    base = max(0.0, min(historico, CRECIMIENTO_MAXIMO))
    return {
        nombre: {
            "growth_rate": round(min(base * FACTOR_CRECIMIENTO[nombre], CRECIMIENTO_MAXIMO), 4),
            "discount_rate": DESCUENTO[nombre],
            "terminal_growth": TERMINAL[nombre],
        }
        for nombre in ("bajista", "base", "alcista")
    }


def _comparables(service: MarketDataService, symbol: str, precio: float | None, eps: float | None) -> dict:
    """Valoración relativa ajustada, con los pares que se puedan reunir."""
    peers = _traer(service, "peers", symbol=symbol)
    if not peers or not peers.get("peers"):
        return {
            "disponible": False,
            "nota": f"Sin lista de comparables para {symbol}.",
        }

    filas = []
    for sym in [symbol, *peers["peers"][:MAX_PARES]]:
        f = _traer(service, "fundamentals", symbol=sym)
        if not f:
            continue
        m = f["metrics"]
        filas.append(
            {
                "symbol": sym,
                "multiplo": m.get("pe_ttm"),
                "crecimiento": m.get("revenue_growth_5y"),
                "calidad": m.get("roe"),
            }
        )

    objetivo = next((f for f in filas if f["symbol"] == symbol), None)
    if objetivo is None:
        return {"disponible": False, "nota": f"Sin fundamentales del propio {symbol}."}

    ajuste = ajustar_por_crecimiento_y_calidad(filas, objetivo, etiqueta_multiplo="P/E")
    salida = {**ajuste, "fuente_pares": peers.get("source")}

    # El BPA tiene que ser el COHERENTE con el múltiplo, no el de otra fuente.
    #
    # Los P/E de los pares vienen del proveedor de fundamentales (TTM, ajustado);
    # el BPA de EDGAR es anual y GAAP. Mezclarlos daba un resultado que se
    # contradecía a sí mismo dentro del mismo panel: el P/E salía FUERA del
    # intervalo y el precio implícito, DENTRO. Los dos números eran correctos por
    # separado y juntos no querían decir nada, porque cada uno vivía en un espacio
    # de múltiplos distinto. Se despeja el BPA del propio múltiplo del objetivo,
    # y entonces las dos lecturas coinciden siempre por construcción.
    eps_coherente = (
        precio / objetivo["multiplo"]
        if precio and objetivo.get("multiplo")
        else eps
    )

    if ajuste.get("disponible") and ajuste.get("fiable") and ajuste.get("intervalo"):
        salida["precio_implicito"] = rango_de_precio_implicito(
            ajuste["intervalo"]["bajo"], ajuste["intervalo"]["alto"], eps_coherente, precio
        )
    elif ajuste.get("crudo") and eps_coherente:
        # Sin ajuste fiable, el rango sale de los cuartiles crudos de los pares y
        # se marca como NO ajustado. Enseñar el cuartil disfrazado de ajuste sería
        # lo mismo que no tener el módulo.
        salida["precio_implicito"] = {
            **rango_de_precio_implicito(
                ajuste["crudo"]["p25"], ajuste["crudo"]["p75"], eps_coherente, precio
            ),
            "ajustado": False,
            "aviso": (
                "Este rango sale del cuartil 25-75 de los múltiplos de los pares SIN "
                "ajustar por crecimiento ni calidad, porque el ajuste no salió "
                "fiable. Vale menos que uno ajustado y conviene leerlo sabiéndolo."
            ),
        }
    return salida


@router.post("/{symbol}")
def valorar(
    symbol: str,
    request: ValoracionRequest = Body(default_factory=ValoracionRequest),
    service: MarketDataService = Depends(get_service),
    session: Session = Depends(get_session),
):
    """Las cuatro valoraciones a la vez, con supuestos visibles y editables.

    Sin cuerpo, la app propone los escenarios desde el histórico de la empresa.
    Con cuerpo, manda lo que envíes: es tu tesis, no la suya.
    """
    symbol = _validar(symbol)
    datos = _cimientos(service, symbol)

    base_fcf = request.base_fcf if request.base_fcf is not None else datos["base_fcf"]
    net_debt = request.net_debt if request.net_debt is not None else datos["net_debt"]
    acciones = request.shares_outstanding or datos["shares_outstanding"]
    if base_fcf is None:
        raise HTTPException(
            status_code=422,
            detail=(
                "No se pudo calcular el flujo de caja libre del último ejercicio "
                "(faltan flujo operativo o capex en el filing). Puedes mandarlo tú "
                "en `base_fcf` si lo tienes."
            ),
        )

    supuestos = (
        {k: v.model_dump() for k, v in request.escenarios.items()}
        if request.escenarios
        else _escenarios_por_defecto(datos["crecimiento"])
    )

    # 1) Escenarios, cada uno con su RANGO.
    #
    # El caso «descuento por debajo del terminal» lo resuelve `rango_de_valor`, y
    # aquí no se repite: había un guardián duplicado con su propio texto, más
    # pobre, que además ganaba por llegar antes. Dos sitios explicando lo mismo
    # con palabras distintas es como acaban diciendo cosas distintas.
    escenarios = {
        nombre: {
            "supuestos": s,
            "rango": rango_de_valor(
                base_fcf, s["growth_rate"], s["discount_rate"], s["terminal_growth"],
                request.years, net_debt, acciones,
            ),
        }
        for nombre, s in supuestos.items()
    }

    # El rango global va de lo más bajo de lo más pesimista a lo más alto de lo
    # más optimista. Es el número que se enseña primero, y es un intervalo.
    todos = [
        e["rango"] for e in escenarios.values()
        if e["rango"].get("disponible") and e["rango"].get("bajo") is not None
    ]
    global_ = (
        {
            "bajo": redondear(min(r["bajo"] for r in todos)),
            "alto": redondear(max(r["alto"] for r in todos)),
            "precio_actual": datos["precio"],
        }
        if todos
        else None
    )
    if global_:
        # La anchura del rango global es tan informativa como el rango. Tres
        # escenarios que van de 133 a 577 no dicen «vale entre 133 y 577»: dicen
        # que con estos supuestos el método no distingue, y eso hay que leerlo
        # antes que los números, no después.
        factor = global_["alto"] / global_["bajo"] if global_["bajo"] else None
        global_["factor"] = round(factor, 2) if factor else None
        global_["nota"] = (
            f"Del escenario más pesimista al más optimista hay un factor de "
            f"{factor:.1f}×. Un rango así no sirve para decidir un precio de "
            "entrada; sirve para ver qué supuestos lo abren tanto — mira abajo "
            "cuál manda. Estrecharlo exige defender supuestos más ceñidos, no "
            "quedarse con el del medio."
            if factor and factor >= 2
            else (
                f"El rango va de {global_['bajo']} a {global_['alto']} (factor "
                f"{factor:.1f}×). Ningún punto de dentro es más cierto que otro."
                if factor
                else ""
            )
        )
        if datos["precio"]:
            global_["posicion"] = (
                "dentro" if global_["bajo"] <= datos["precio"] <= global_["alto"]
                else "por encima" if datos["precio"] > global_["alto"]
                else "por debajo"
            )

    # 2) Sensibilidad ordenada sobre el escenario base.
    base = supuestos.get("base") or next(iter(supuestos.values()))
    sensibilidad = sensibilidad_ordenada(
        base_fcf, base["growth_rate"], base["discount_rate"], base["terminal_growth"],
        request.years, net_debt, acciones,
    )

    # 3) DCF inverso.
    market_cap = (datos["precio"] * acciones) if datos["precio"] and acciones else None
    if market_cap:
        curva = curva_de_crecimiento_implicito(
            market_cap=market_cap, base_fcf=base_fcf,
            terminal_growth=base["terminal_growth"], years=request.years, net_debt=net_debt,
        )
        contraste = juzgar_contra_el_pasado(curva, datos["crecimiento"])
        margen = (
            margen_implicito(
                market_cap=market_cap, revenue=datos["revenue"],
                margen_actual=base_fcf / datos["revenue"],
                revenue_growth=datos["crecimiento"].get("revenue_cagr") or 0.03,
                discount_rate=base["discount_rate"],
                terminal_growth=base["terminal_growth"],
                years=request.years, net_debt=net_debt,
            )
            if datos["revenue"]
            else {"disponible": False, "motivo": "Sin ingresos en el último ejercicio."}
        )
        inverso = {
            "disponible": True,
            "market_cap": market_cap,
            "curva": curva,
            "contraste": contraste,
            "margen": margen,
            "resumen": resumen_inverso(curva, margen, contraste),
        }
    else:
        inverso = {
            "disponible": False,
            "nota": (
                "Sin precio o sin número de acciones no hay capitalización, y sin "
                "capitalización no hay nada que invertir."
            ),
        }

    return {
        "symbol": symbol,
        "entradas": {
            "base_fcf": base_fcf,
            "net_debt": net_debt,
            "shares_outstanding": acciones,
            "revenue": datos["revenue"],
            "eps": datos["eps"],
            "precio_actual": datos["precio"],
            "fiscal_year": datos["fiscal_year"],
            "crecimiento_historico": datos["crecimiento"],
            "years": request.years,
            "source": datos["source"],
        },
        "escenarios": escenarios,
        "rango_global": global_,
        "sensibilidad": sensibilidad,
        "dcf_inverso": inverso,
        "comparables": _comparables(service, symbol, datos["precio"], datos["eps"]),
        "nota_supuestos": (
            "Los supuestos de partida salen del crecimiento histórico REAL de la "
            f"empresa, acotado al {CRECIMIENTO_MAXIMO * 100:.0f} % — extrapolar a "
            "perpetuidad el mejor quinquenio es el error más común del DCF casero. "
            "Cámbialos: son un punto de arranque, no una opinión de la app."
        ),
        "disclaimer": (
            "Aquí no hay ningún precio objetivo, y no por estilo: no existe en el "
            "código un campo donde quepa uno. Los escenarios dan rangos, los "
            "comparables dan un intervalo de predicción y el DCF inverso da una "
            "curva. Un DCF no dice cuánto vale una empresa; dice qué implican unos "
            "supuestos, y los supuestos son tuyos."
        ),
        "computed_by": "app",  # aritmética local, sin LLM
    }
