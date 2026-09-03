"""Valoración por DCF con supuestos explícitos y análisis de sensibilidad.

Principio rector de la app aplicado al código: el DCF nunca devuelve "el
precio objetivo"; devuelve un valor por escenario con TODOS los supuestos de
entrada visibles, más una matriz de sensibilidad que enseña cuánto se mueve
el resultado al tocar cada supuesto. La falsa precisión es el enemigo.
"""

from __future__ import annotations


def dcf(
    base_fcf: float,
    growth_rate: float,
    discount_rate: float,
    terminal_growth: float,
    years: int = 5,
    net_debt: float = 0.0,
    shares_outstanding: float | None = None,
) -> dict:
    """DCF de dos etapas: crecimiento constante `years` años + valor terminal
    (Gordon). Devuelve el detalle completo de la proyección.

    Restricciones: discount_rate > terminal_growth (si no, el valor terminal
    diverge — error clásico) y years >= 1.
    """
    if years < 1:
        raise ValueError("years debe ser >= 1")
    if discount_rate <= terminal_growth:
        raise ValueError(
            "La tasa de descuento debe ser mayor que el crecimiento terminal "
            "(si no, el valor terminal es infinito)"
        )

    projections = []
    pv_sum = 0.0
    fcf = base_fcf
    for year in range(1, years + 1):
        fcf = fcf * (1 + growth_rate)
        pv = fcf / (1 + discount_rate) ** year
        pv_sum += pv
        projections.append({"year": year, "fcf": fcf, "present_value": pv})

    terminal_fcf = fcf * (1 + terminal_growth)
    terminal_value = terminal_fcf / (discount_rate - terminal_growth)
    pv_terminal = terminal_value / (1 + discount_rate) ** years

    enterprise_value = pv_sum + pv_terminal
    equity_value = enterprise_value - net_debt
    per_share = (
        equity_value / shares_outstanding
        if shares_outstanding and shares_outstanding > 0
        else None
    )
    return {
        "assumptions": {
            "base_fcf": base_fcf,
            "growth_rate": growth_rate,
            "discount_rate": discount_rate,
            "terminal_growth": terminal_growth,
            "years": years,
            "net_debt": net_debt,
            "shares_outstanding": shares_outstanding,
        },
        "projections": projections,
        "terminal_value": terminal_value,
        "pv_terminal": pv_terminal,
        "pv_explicit": pv_sum,
        "terminal_weight": pv_terminal / enterprise_value if enterprise_value else None,
        "enterprise_value": enterprise_value,
        "equity_value": equity_value,
        "value_per_share": per_share,
    }


def sensitivity_grid(
    base_fcf: float,
    growth_rate: float,
    discount_rate: float,
    terminal_growth: float,
    years: int = 5,
    net_debt: float = 0.0,
    shares_outstanding: float | None = None,
    step: float = 0.01,
) -> dict:
    """Matriz de valor/acción variando WACC (filas) y crecimiento (columnas)
    en ±2 puntos. Enseña qué tan sensible es el resultado a cada supuesto —
    si la matriz se mueve mucho, el número central vale poco."""
    rates = [round(discount_rate + i * step, 6) for i in range(-2, 3)]
    growths = [round(growth_rate + i * step, 6) for i in range(-2, 3)]
    rows = []
    for r in rates:
        cells: list[float | None] = []
        for g in growths:
            if r <= terminal_growth:
                cells.append(None)  # combinación inválida: terminal diverge
                continue
            result = dcf(
                base_fcf, g, r, terminal_growth, years, net_debt, shares_outstanding
            )
            cells.append(result["value_per_share"] or result["equity_value"])
        rows.append({"discount_rate": r, "values": cells})
    return {"growth_rates": growths, "rows": rows}


def scenario_set(
    scenarios: dict[str, dict],
    base_fcf: float,
    years: int,
    net_debt: float,
    shares_outstanding: float | None,
) -> dict:
    """Evalúa bajista/base/alcista con un DCF por escenario. `scenarios` mapea
    nombre -> {growth_rate, discount_rate, terminal_growth}."""
    out = {}
    for name, assumptions in scenarios.items():
        result = dcf(
            base_fcf=base_fcf,
            growth_rate=assumptions["growth_rate"],
            discount_rate=assumptions["discount_rate"],
            terminal_growth=assumptions["terminal_growth"],
            years=years,
            net_debt=net_debt,
            shares_outstanding=shares_outstanding,
        )
        out[name] = {
            "assumptions": result["assumptions"],
            "value_per_share": result["value_per_share"],
            "equity_value": result["equity_value"],
            "terminal_weight": result["terminal_weight"],
        }
    return out


# ---------------------------------------------------------------------------
# Rangos, no números
# ---------------------------------------------------------------------------
#
# El docstring de este módulo decía que el DCF «nunca devuelve el precio
# objetivo, devuelve un valor por escenario». Eso era hacer trampa con las
# palabras: tres escenarios con un valor puntual cada uno son TRES precios
# objetivo, no un rango. Y un «147,32 $» comunica una precisión que el método no
# tiene ni de lejos — mover el WACC un cuarto de punto lo cambia más que esos
# céntimos.
#
# Así que aquí un escenario produce un RANGO, construido perturbando sus propios
# supuestos dentro de una banda declarada, y los números se redondean a las
# cifras significativas que el método aguanta.

BANDA_CRECIMIENTO = 0.02   # ±2 puntos porcentuales
BANDA_DESCUENTO = 0.01     # ±1 punto porcentual
CIFRAS_SIGNIFICATIVAS = 3


def redondear(valor: float | None, cifras: int = CIFRAS_SIGNIFICATIVAS) -> float | None:
    """Redondea a cifras significativas, no a decimales.

    Un DCF que imprime «147,32 $» finge una precisión de céntimos sobre un
    método donde mover el WACC un cuarto de punto cambia el resultado en varios
    euros. Redondear a tres cifras significativas —147 $, o 1.470 $ si es una
    empresa cara— es decir la verdad sobre lo que se sabe.
    """
    if valor is None or valor == 0:
        return valor
    return float(f"%.{cifras}g" % valor)


def rango_de_valor(
    base_fcf: float,
    growth_rate: float,
    discount_rate: float,
    terminal_growth: float,
    years: int = 5,
    net_debt: float = 0.0,
    shares_outstanding: float | None = None,
    banda_crecimiento: float = BANDA_CRECIMIENTO,
    banda_descuento: float = BANDA_DESCUENTO,
) -> dict:
    """El rango de valor compatible con estos supuestos, no un punto.

    Se evalúan las esquinas de la banda alrededor de los supuestos centrales.
    El resultado dice, además, **cuánto de ancho** es el rango respecto a su
    centro: un rango de ±40 % no es una valoración, es un aviso de que el
    método no discrimina en este caso, y merece leerse como tal.
    """
    combinaciones = []
    for g in (growth_rate - banda_crecimiento, growth_rate, growth_rate + banda_crecimiento):
        for r in (
            discount_rate - banda_descuento,
            discount_rate,
            discount_rate + banda_descuento,
        ):
            if r <= terminal_growth:
                continue  # el valor terminal diverge: combinación sin sentido
            resultado = dcf(
                base_fcf, g, r, terminal_growth, years, net_debt, shares_outstanding
            )
            valor = resultado["value_per_share"]
            if valor is None:
                valor = resultado["equity_value"]
            combinaciones.append(valor)

    # El centro se comprueba aparte, y no es redundante: la banda puede tener
    # esquinas válidas mientras el punto central NO lo es (descuento 3 % con
    # terminal 3,5 %: la esquina de +1 pp sí vale, el centro no). Calcularlo sin
    # mirar reventaba con un ValueError desde dentro del `dcf` en vez de decir
    # qué supuesto estaba mal.
    if not combinaciones or discount_rate <= terminal_growth:
        return {
            "disponible": False,
            "nota": (
                f"La tasa de descuento ({discount_rate * 100:.1f} %) no supera al "
                f"crecimiento a perpetuidad ({terminal_growth * 100:.1f} %), así que "
                "el valor terminal sería infinito. No es un fallo de cálculo: es un "
                "supuesto que dice que la empresa crece más rápido que el coste del "
                "dinero para siempre."
            ),
        }

    centro = dcf(
        base_fcf, growth_rate, discount_rate, terminal_growth, years, net_debt,
        shares_outstanding,
    )
    valor_centro = centro["value_per_share"] or centro["equity_value"]
    bajo, alto = min(combinaciones), max(combinaciones)
    amplitud = (alto - bajo) / valor_centro if valor_centro else None

    return {
        "disponible": True,
        "bajo": redondear(bajo),
        "centro": redondear(valor_centro),
        "alto": redondear(alto),
        "amplitud_pct": round(amplitud * 100, 1) if amplitud is not None else None,
        "banda": {
            "crecimiento_pp": round(banda_crecimiento * 100, 2),
            "descuento_pp": round(banda_descuento * 100, 2),
        },
        "peso_terminal": (
            round(centro["terminal_weight"], 3) if centro["terminal_weight"] else None
        ),
        "nota": _leer_amplitud(amplitud, centro["terminal_weight"]),
    }


def _leer_amplitud(amplitud: float | None, peso_terminal: float | None) -> str:
    partes = []
    if amplitud is not None:
        if amplitud > 0.6:
            partes.append(
                f"El rango abarca un {amplitud * 100:.0f} % del valor central: con "
                "esta sensibilidad el DCF no discrimina entre «cara» y «barata». "
                "Sirve para entender el negocio, no para decidir el precio."
            )
        elif amplitud > 0.3:
            partes.append(
                f"El rango abarca un {amplitud * 100:.0f} % del valor central. Es "
                "lo normal en un DCF; el número del medio no es más cierto que "
                "los extremos."
            )
        else:
            partes.append(
                f"Rango estrecho ({amplitud * 100:.0f} % del centro), lo que suele "
                "significar que el peso del valor terminal es bajo o que la banda "
                "de supuestos es corta."
            )
    if peso_terminal and peso_terminal > 0.7:
        partes.append(
            f"El {peso_terminal * 100:.0f} % del valor está en el valor terminal, "
            "o sea en lo que pasa después del horizonte proyectado. Esto no es "
            "una valoración de los próximos años: es una apuesta sobre la "
            "perpetuidad con unos años de detalle delante."
        )
    return " ".join(partes)


# ---------------------------------------------------------------------------
# Qué supuesto mueve más el resultado
# ---------------------------------------------------------------------------

# Cuánto se perturba cada supuesto para medir su influencia. Son magnitudes
# COMPARABLES a propósito —un punto porcentual de WACC contra un punto de
# crecimiento— para que el orden signifique algo. Perturbar cada uno un 10 % de
# su valor daría un orden distinto y engañoso: un 10 % de un WACC del 9 % es
# 0,9 pp, y un 10 % de un crecimiento del 3 % es 0,3 pp.
PERTURBACIONES = {
    "growth_rate": (0.01, "Crecimiento del FCF (+/- 1 pp)"),
    "discount_rate": (0.01, "Tasa de descuento / WACC (+/- 1 pp)"),
    "terminal_growth": (0.005, "Crecimiento a perpetuidad (+/- 0,5 pp)"),
    "base_fcf": (None, "Flujo de caja de partida (+/- 10 %)"),
}


def sensibilidad_ordenada(
    base_fcf: float,
    growth_rate: float,
    discount_rate: float,
    terminal_growth: float,
    years: int = 5,
    net_debt: float = 0.0,
    shares_outstanding: float | None = None,
) -> dict:
    """Qué supuesto mueve más el resultado, ordenado de mayor a menor.

    La matriz de sensibilidad clásica cruza dos supuestos y deja fuera al
    resto — entre ellos el crecimiento a perpetuidad, que en muchas empresas es
    el que más manda porque el valor terminal se lleva tres cuartas partes del
    total. Esto los perturba de uno en uno y los ordena.

    Se perturba **arriba y abajo** y se reporta el recorrido completo: un
    supuesto puede mover mucho hacia un lado y poco hacia el otro, y quedarse
    con una sola dirección esconde precisamente esa asimetría.
    """
    supuestos = {
        "base_fcf": base_fcf,
        "growth_rate": growth_rate,
        "discount_rate": discount_rate,
        "terminal_growth": terminal_growth,
    }

    def valorar(**cambios) -> float | None:
        s = {**supuestos, **cambios}
        if s["discount_rate"] <= s["terminal_growth"]:
            return None
        r = dcf(
            s["base_fcf"], s["growth_rate"], s["discount_rate"], s["terminal_growth"],
            years, net_debt, shares_outstanding,
        )
        return r["value_per_share"] or r["equity_value"]

    centro = valorar()
    if centro is None or centro == 0:
        return {"disponible": False, "nota": "Los supuestos centrales no producen un valor."}

    filas = []
    for clave, (delta, etiqueta) in PERTURBACIONES.items():
        paso = delta if delta is not None else supuestos[clave] * 0.10
        if paso == 0:
            continue
        abajo = valorar(**{clave: supuestos[clave] - paso})
        arriba = valorar(**{clave: supuestos[clave] + paso})
        if abajo is None and arriba is None:
            continue
        valores = [v for v in (abajo, arriba) if v is not None]
        recorrido = max(valores) - min(valores) if len(valores) > 1 else abs(valores[0] - centro)
        filas.append(
            {
                "supuesto": clave,
                "etiqueta": etiqueta,
                "valor_actual": supuestos[clave],
                "perturbacion": paso,
                "valor_abajo": redondear(abajo),
                "valor_arriba": redondear(arriba),
                "recorrido": redondear(recorrido),
                "recorrido_pct": round(recorrido / centro * 100, 1),
                # La asimetría importa: si bajar el crecimiento un punto quita
                # 30 $ y subirlo solo añade 18 $, el riesgo no es simétrico y el
                # escenario central está más cerca del techo que del suelo.
                "asimetrico": (
                    abs((arriba - centro) - (centro - abajo)) / recorrido > 0.25
                    if abajo is not None and arriba is not None and recorrido
                    else None
                ),
            }
        )

    filas.sort(key=lambda f: -f["recorrido_pct"])
    dominante = filas[0] if filas else None
    return {
        "disponible": True,
        "centro": redondear(centro),
        "supuestos": filas,
        "dominante": dominante["supuesto"] if dominante else None,
        "nota": (
            f"El supuesto que más mueve el resultado es «{dominante['etiqueta']}»: "
            f"su banda cambia el valor un {dominante['recorrido_pct']:.0f} %. "
            "Es donde merece la pena discutir, y donde una tesis se sostiene o se "
            "cae — no en el segundo decimal del resultado."
            if dominante
            else "No se pudo medir la sensibilidad de ningún supuesto."
        ),
    }
