"""DCF inverso: qué está descontando el precio de hoy.

Un DCF normal responde «¿cuánto vale?», y la respuesta depende por completo de
supuestos que nadie sabe. El DCF inverso le da la vuelta: toma el precio como
dado —el precio sí se conoce— y despeja **qué tendría que pasar para que ese
precio fuera correcto**. La pregunta pasa de «¿cuánto vale?» a «¿me creo esto?»,
que es una pregunta que sí se puede contestar mirando el negocio.

Es, con diferencia, la forma más honesta de usar un DCF, porque no hay que
acertar el número: hay que juzgar si un crecimiento del 19 % anual durante cinco
años es plausible para una empresa que lleva creciendo al 6 %.

**La trampa que este módulo tiene que evitar.** El crecimiento implícito no es
una propiedad de la empresa: es una función de la tasa de descuento que TÚ
elijas. Con un WACC del 8 % el mercado «descuenta» un crecimiento; con uno del
11 %, otro completamente distinto. Publicar «el mercado descuenta un 14 %» como
si fuera un hecho medido sería exactamente la falsa precisión que esta app
existe para evitar. Por eso lo que se devuelve es una **curva sobre el rango de
descuentos razonables**, no un número.

El margen implícito, en cambio, tiene solución cerrada: el valor de empresa es
proporcional al margen de FCF, así que despejarlo es una división, no una
búsqueda. Se aprovecha.
"""

from __future__ import annotations

from app.analysis.valuation import dcf, redondear

# Rango de búsqueda del crecimiento implícito. Se acota por arriba: si hace
# falta más de un 60 % anual sostenido para justificar el precio, el resultado
# concreto da igual — lo que importa es que el número es absurdo, y decirlo así
# informa más que devolver «73,4 %».
CRECIMIENTO_MIN = -0.50
CRECIMIENTO_MAX = 0.60
ITERACIONES = 60

# Rango de WACC sobre el que se dibuja la curva. Cubre desde una empresa muy
# estable hasta una con riesgo alto; fuera de ahí el ejercicio deja de tener
# sentido para una cotizada grande.
DESCUENTOS_CURVA = (0.07, 0.08, 0.09, 0.10, 0.11, 0.12)


def _valor_equity(
    base_fcf: float,
    growth: float,
    discount_rate: float,
    terminal_growth: float,
    years: int,
    net_debt: float,
) -> float:
    return dcf(
        base_fcf, growth, discount_rate, terminal_growth, years, net_debt
    )["equity_value"]


def crecimiento_implicito(
    *,
    market_cap: float,
    base_fcf: float,
    discount_rate: float,
    terminal_growth: float,
    years: int = 5,
    net_debt: float = 0.0,
) -> dict:
    """El crecimiento del FCF que justifica exactamente el precio de hoy.

    Bisección: el valor es monótono creciente en el crecimiento, así que la
    búsqueda converge siempre y sin depender de un punto de partida.
    """
    if base_fcf <= 0:
        return {
            "disponible": False,
            "motivo": (
                "El flujo de caja de partida no es positivo. Sin FCF no hay nada "
                "que hacer crecer: el DCF inverso no aplica a una empresa que hoy "
                "quema caja, y forzarlo daría un número sin significado."
            ),
        }
    if discount_rate <= terminal_growth:
        return {
            "disponible": False,
            "motivo": "La tasa de descuento no supera al crecimiento terminal.",
        }

    bajo, alto = CRECIMIENTO_MIN, CRECIMIENTO_MAX
    v_bajo = _valor_equity(base_fcf, bajo, discount_rate, terminal_growth, years, net_debt)
    v_alto = _valor_equity(base_fcf, alto, discount_rate, terminal_growth, years, net_debt)

    if market_cap < v_bajo:
        return {
            "disponible": False,
            "fuera_de_rango": "abajo",
            "motivo": (
                f"Ni con una caída del FCF del {abs(CRECIMIENTO_MIN) * 100:.0f} % "
                "anual sale un valor tan bajo como el precio. El mercado descuenta "
                "un deterioro mayor que el que este modelo puede representar, o el "
                "FCF de partida no es representativo del negocio."
            ),
        }
    if market_cap > v_alto:
        return {
            "disponible": False,
            "fuera_de_rango": "arriba",
            "motivo": (
                f"Ni creciendo al {CRECIMIENTO_MAX * 100:.0f} % anual durante "
                f"{years} años se justifica el precio con estos supuestos. Que el "
                "número exacto sea 70 % u 80 % da igual: lo que dice el resultado "
                "es que el precio no se explica por el flujo de caja actual."
            ),
        }

    for _ in range(ITERACIONES):
        medio = (bajo + alto) / 2
        if _valor_equity(base_fcf, medio, discount_rate, terminal_growth, years, net_debt) < market_cap:
            bajo = medio
        else:
            alto = medio

    return {"disponible": True, "crecimiento": (bajo + alto) / 2}


def curva_de_crecimiento_implicito(
    *,
    market_cap: float,
    base_fcf: float,
    terminal_growth: float,
    years: int = 5,
    net_debt: float = 0.0,
    descuentos: tuple[float, ...] = DESCUENTOS_CURVA,
) -> dict:
    """El crecimiento implícito para cada tasa de descuento razonable.

    Esta es la respuesta honesta a «qué crecimiento descuenta el mercado»: una
    curva, no un número. El crecimiento implícito no es una propiedad de la
    empresa — es una función del WACC que elijas, y cambiarlo dos puntos puede
    duplicar la respuesta. Enseñar la curva convierte una cifra discutible en
    una relación que se ve.
    """
    puntos = []
    for r in descuentos:
        resultado = crecimiento_implicito(
            market_cap=market_cap,
            base_fcf=base_fcf,
            discount_rate=r,
            terminal_growth=terminal_growth,
            years=years,
            net_debt=net_debt,
        )
        puntos.append(
            {
                "discount_rate": r,
                "crecimiento_implicito": (
                    round(resultado["crecimiento"], 4)
                    if resultado.get("disponible")
                    else None
                ),
                "motivo": resultado.get("motivo") if not resultado.get("disponible") else None,
            }
        )

    medibles = [p for p in puntos if p["crecimiento_implicito"] is not None]
    if not medibles:
        return {
            "disponible": False,
            "puntos": puntos,
            "nota": (
                "El precio no se puede explicar con este flujo de caja en ninguna "
                "tasa de descuento razonable. Suele significar que el FCF del "
                "último ejercicio no representa al negocio (un año malo, una "
                "adquisición, un capex extraordinario)."
            ),
        }

    bajo = min(p["crecimiento_implicito"] for p in medibles)
    alto = max(p["crecimiento_implicito"] for p in medibles)
    return {
        "disponible": True,
        "puntos": puntos,
        "rango": {"bajo": round(bajo, 4), "alto": round(alto, 4)},
        "nota": (
            f"Según la tasa de descuento que uses ({descuentos[0] * 100:.0f} %–"
            f"{descuentos[-1] * 100:.0f} %), el precio de hoy descuenta un "
            f"crecimiento del FCF de entre {bajo * 100:.1f} % y {alto * 100:.1f} % "
            f"anual durante {years} años. No es un dato de la empresa: es lo que "
            "implica el precio DADA tu tasa de descuento, y por eso viaja como "
            "rango y no como cifra."
        ),
    }


def juzgar_contra_el_pasado(curva: dict, historico: dict) -> dict:
    """Compara lo que descuenta el precio con lo que la empresa ha hecho.

    Es la mitad que convierte el DCF inverso en algo accionable. «El mercado
    descuenta un 19 %» no dice nada por sí solo; «descuenta un 19 % en una
    empresa que lleva cinco años creciendo al 6 %» es una tesis que se puede
    aceptar o rechazar mirando el negocio.

    Razona sobre el RANGO entero, nunca sobre su centro. La primera versión de
    esta función resumía el punto medio y con una curva de −0,5 % a 18 % —que es
    lo normal— concluía «descuenta más o menos lo que la empresa ya hace, ni
    exige un cambio»: tranquilizadora, y sin sentido, porque el centro de un
    rango de dieciocho puntos no describe nada. Cuando el rango es ancho, lo
    informativo no es su centro sino **dónde cae el histórico dentro de él**.
    """
    referencias = {
        k: v
        for k, v in {
            "FCF": historico.get("fcf_cagr"),
            "ingresos": historico.get("revenue_cagr"),
            "beneficio por acción": historico.get("eps_cagr"),
        }.items()
        if v is not None
    }
    if not referencias:
        return {
            "disponible": False,
            "nota": (
                "Sin crecimiento histórico calculable no hay con qué contrastar lo "
                "que descuenta el precio."
            ),
        }
    if not curva.get("disponible"):
        return {"disponible": False, "nota": curva.get("nota", "Sin curva implícita.")}

    mejor = max(referencias.values())
    bajo, alto = curva["rango"]["bajo"], curva["rango"]["alto"]
    medibles = [p for p in curva["puntos"] if p["crecimiento_implicito"] is not None]

    if bajo > mejor:
        # Afirmación fuerte y segura: vale para TODA la curva, no para un punto.
        lectura = (
            f"En todo el rango de descuentos considerado, el precio exige crecer "
            f"más ({bajo * 100:.0f} %–{alto * 100:.0f} %) de lo que la empresa ha "
            f"logrado nunca ({mejor * 100:.0f} %). No depende de qué WACC elijas: "
            "para que el precio sea correcto tiene que pasar algo que no ha pasado "
            "antes. Ese algo es la tesis, y conviene poder nombrarlo."
        )
        cruce = None
    elif alto < mejor:
        lectura = (
            f"En todo el rango de descuentos, el precio descuenta un crecimiento "
            f"({bajo * 100:.0f} %–{alto * 100:.0f} %) por debajo del histórico "
            f"({mejor * 100:.0f} %). O el mercado espera un deterioro, o el flujo "
            "de caja del último ejercicio no representa al negocio."
        )
        cruce = None
    else:
        # El histórico cae DENTRO del rango: entonces lo que decide es el WACC, y
        # el dato útil es exactamente dónde está la frontera.
        cruce = next(
            (p["discount_rate"] for p in medibles if p["crecimiento_implicito"] >= mejor),
            None,
        )
        lectura = (
            f"El crecimiento histórico ({mejor * 100:.0f} %) cae DENTRO de lo que "
            f"descuenta el precio ({bajo * 100:.0f} %–{alto * 100:.0f} %), así que "
            "aquí no decide la empresa: decide tu tasa de descuento."
            + (
                f" Por debajo de un WACC del {cruce * 100:.0f} % el precio pide "
                "menos de lo que la empresa ya hace; por encima, más."
                if cruce is not None
                else ""
            )
        )

    return {
        "disponible": True,
        "referencias": {k: round(v, 4) for k, v in referencias.items()},
        "mejor_historico": round(mejor, 4),
        "rango_implicito": {"bajo": bajo, "alto": alto},
        "wacc_de_cruce": cruce,
        "nota": lectura,
    }


# --- Márgenes implícitos: aquí hay solución cerrada ---------------------------


def margen_implicito(
    *,
    market_cap: float,
    revenue: float,
    margen_actual: float,
    revenue_growth: float,
    discount_rate: float,
    terminal_growth: float,
    years: int = 5,
    net_debt: float = 0.0,
) -> dict:
    """Qué margen de FCF hace falta para justificar el precio.

    Sin bisección: con el crecimiento de ingresos fijado, el valor de empresa es
    **proporcional** al margen de FCF (cada flujo es ingresos × margen, y el
    descuento es lineal). Así que el margen implícito es una división, exacta,
    en vez de una búsqueda numérica con su tolerancia.

    Es la segunda mitad de la pregunta. Un precio se puede justificar creciendo
    mucho con el margen de hoy, o creciendo poco y expandiendo el margen; separar
    las dos palancas dice qué está comprando el mercado.
    """
    if revenue <= 0 or margen_actual <= 0:
        return {
            "disponible": False,
            "motivo": "Sin ingresos o sin margen de FCF positivo no hay nada que despejar.",
        }
    if discount_rate <= terminal_growth:
        return {"disponible": False, "motivo": "La tasa de descuento no supera al terminal."}

    fcf_actual = revenue * margen_actual
    valor_con_margen_actual = dcf(
        fcf_actual, revenue_growth, discount_rate, terminal_growth, years, net_debt=0.0
    )["enterprise_value"]
    if valor_con_margen_actual <= 0:
        return {"disponible": False, "motivo": "El valor de empresa calculado no es positivo."}

    ev_objetivo = market_cap + net_debt
    factor = ev_objetivo / valor_con_margen_actual
    implicito = margen_actual * factor

    return {
        "disponible": True,
        "margen_actual": round(margen_actual, 4),
        "margen_implicito": round(implicito, 4),
        "expansion_necesaria_pp": round((implicito - margen_actual) * 100, 2),
        "revenue_growth_supuesto": revenue_growth,
        "nota": (
            f"Manteniendo el crecimiento de ingresos en {revenue_growth * 100:.1f} %, "
            f"el precio de hoy exige un margen de FCF del {implicito * 100:.1f} % "
            f"frente al {margen_actual * 100:.1f} % actual"
            + (
                f" — una expansión de {(implicito - margen_actual) * 100:.1f} puntos. "
                "Pregúntate de dónde saldría."
                if implicito > margen_actual
                else " — el precio no exige mejorar el margen con ese crecimiento."
            )
        ),
    }


def resumen(curva: dict, margen: dict, contraste: dict) -> str:
    """Lo que hay que leer si solo se lee una línea."""
    partes = []
    if curva.get("disponible"):
        r = curva["rango"]
        partes.append(
            f"Al precio de hoy, el mercado descuenta un crecimiento del FCF de "
            f"{r['bajo'] * 100:.0f} %–{r['alto'] * 100:.0f} % anual según la tasa "
            "de descuento que uses."
        )
    if contraste.get("disponible"):
        partes.append(contraste["nota"])
    if margen.get("disponible") and margen["expansion_necesaria_pp"] > 1:
        partes.append(
            f"Por la otra vía, exigiría llevar el margen de FCF del "
            f"{margen['margen_actual'] * 100:.0f} % al "
            f"{margen['margen_implicito'] * 100:.0f} %."
        )
    if not partes:
        return (
            "No se pudo despejar qué descuenta el precio con los datos "
            "disponibles."
        )
    partes.append(
        "El DCF inverso no dice si está cara o barata: dice qué hay que creerse "
        "para que el precio de hoy sea correcto. Esa parte la decides tú."
    )
    return " ".join(partes)
