"""Riesgo total abierto: la suma que nadie hacía.

El motor de decisión dimensiona cada idea para arriesgar un 1 % del capital. Lo
que no hacía nadie es **sumar**. Ocho posiciones al 1 % son un 8 % en riesgo
simultáneo, y esa cifra —no la de cada operación— es la que decide si una mala
semana es un contratiempo o un agujero.

Y sumar sin más tampoco basta, porque las posiciones no se mueven
independientemente. Cinco tecnológicas no son cinco apuestas: en una caída
sectorial bajan juntas. Cripto es el caso extremo — las grandes se correlacionan
casi por completo entre sí, así que cinco criptos son **una sola apuesta con
cinco tickets**. Por eso aquí el riesgo se agrega dos veces: el total, y el de
cada grupo que se mueve junto.

Los topes son convención de gestión de riesgo, no un resultado empírico de esta
app, y se dicen como lo que son. Lo que no es opinable es la aritmética: si
tienes un 12 % en riesgo y todo va en la misma dirección, pierdes un 12 %.
"""

from __future__ import annotations

# Topes. Convención habitual entre gestores; ajustables y discutibles.
HEAT_MAXIMO_PCT = 6.0        # riesgo abierto total
HEAT_GRUPO_MAXIMO_PCT = 3.0  # riesgo de un grupo que se mueve junto

# Cripto se agrupa entero: las grandes se correlacionan casi por completo, así
# que separarlas por "sector" fingiría una diversificación que no existe.
GRUPO_CRIPTO = "Cripto (se mueven juntas)"


def _grupo(posicion: dict) -> str:
    if (posicion.get("asset_class") or "").lower() == "cripto":
        return GRUPO_CRIPTO
    return posicion.get("sector") or "Sin sector"


def riesgo_de_posicion(posicion: dict, total_cartera: float | None) -> dict | None:
    """Cuánto pierdes en esta posición si salta su stop, en % de la cartera.

    Devuelve None cuando falta un dato en vez de asumir cero: una posición sin
    precio o sin stop no tiene riesgo *conocido*, que no es lo mismo que no
    tener riesgo, y contarla como cero maquillaría justo el total que importa.
    """
    valor = posicion.get("market_value")
    stop = posicion.get("stop")
    precio = posicion.get("price")
    if not valor or not stop or not precio or not total_cartera:
        return None
    if stop >= precio:
        # Stop ya perforado: lo que arriesgas desde aquí no es la distancia al
        # stop, es todo lo que queda. Decirlo así evita un falso alivio.
        perdida = valor
        nota = "stop ya perforado: en riesgo la posición entera"
    else:
        perdida = valor * (precio - stop) / precio
        nota = None
    return {
        "symbol": posicion.get("symbol"),
        "grupo": _grupo(posicion),
        "riesgo_pct": round(perdida / total_cartera * 100, 2),
        "peso_pct": round(valor / total_cartera * 100, 2),
        "nota": nota,
    }


def presupuesto_de_riesgo(posiciones: list[dict], total_cartera: float | None) -> dict:
    """Riesgo abierto total y por grupo correlacionado, con sus avisos."""
    detalle = [
        r
        for p in posiciones
        if (r := riesgo_de_posicion(p, total_cartera)) is not None
    ]
    sin_calcular = len(posiciones) - len(detalle)

    por_grupo: dict[str, float] = {}
    for r in detalle:
        por_grupo[r["grupo"]] = round(por_grupo.get(r["grupo"], 0.0) + r["riesgo_pct"], 2)

    total = round(sum(r["riesgo_pct"] for r in detalle), 2)
    avisos: list[str] = []

    if total > HEAT_MAXIMO_PCT:
        avisos.append(
            f"Tienes un {total:.1f} % de la cartera en riesgo a la vez, por "
            f"encima del {HEAT_MAXIMO_PCT:.0f} % que se suele considerar el "
            "tope. Si todo se gira en tu contra, eso es lo que pierdes."
        )

    for grupo, riesgo in sorted(por_grupo.items(), key=lambda kv: -kv[1]):
        if riesgo > HEAT_GRUPO_MAXIMO_PCT:
            avisos.append(
                f"«{grupo}» concentra un {riesgo:.1f} % de riesgo. Las posiciones "
                "de un mismo grupo caen juntas, así que cuentan como una sola "
                f"apuesta grande, no como varias pequeñas (tope sugerido: "
                f"{HEAT_GRUPO_MAXIMO_PCT:.0f} %)."
            )

    if sin_calcular:
        avisos.append(
            f"{sin_calcular} posición(es) sin precio o sin stop no entran en el "
            "total. El riesgo real es mayor que el que ves aquí."
        )

    return {
        "riesgo_total_pct": total,
        "tope_pct": HEAT_MAXIMO_PCT,
        "por_grupo": por_grupo,
        "tope_grupo_pct": HEAT_GRUPO_MAXIMO_PCT,
        "posiciones": sorted(detalle, key=lambda r: -r["riesgo_pct"]),
        "sin_calcular": sin_calcular,
        "avisos": avisos,
        "margen_pct": round(max(0.0, HEAT_MAXIMO_PCT - total), 2),
        "nota": (
            "El riesgo abierto es lo que perderías si TODAS tus posiciones "
            "tocaran su stop. Se agrupa por sector —y cripto en bloque, porque "
            "las grandes se correlacionan casi por completo— ya que lo que se "
            "mueve junto no diversifica. Los topes son convención de gestión de "
            "riesgo, no un resultado medido en esta app; la aritmética sí es "
            "exacta."
        ),
    }
