"""La curva de valor de la cartera en el tiempo.

El portafolio decía cuánto vale HOY y cuánto llevas ganado HOY. Faltaba lo
único que contesta «¿cómo ha ido esto de verdad?»: el recorrido. Un +17 % que
subió en línea recta y otro que llegó ahí tras estar un −30 % son la misma
cifra y no la misma experiencia, y la segunda es la que hace vender abajo.

## Tres decisiones que deciden si esta curva miente

**1. Esto es el valor de las posiciones ABIERTAS, no el de tu cuenta.** La app
no lleva saldo en efectivo: cuando cierras una posición, el dinero sale del
modelo. Así que un cierre hace BAJAR la curva, y eso no es una pérdida — es una
retirada. Sin decirlo, cada venta se leería como un desplome. Se dice en cada
respuesta y se marca cada fecha en que se cerró algo.

**2. El cambio es el de CADA DÍA, no el de hoy.** Convertir todo el histórico
al tipo actual daría «qué valdría hoy lo que tenías entonces», que no es lo que
valía. Peor: convertiría un movimiento de divisa en un movimiento de la acción.
Se usa la observación de FRED vigente en cada fecha.

**3. Al lado va lo invertido.** Una curva de valor sola no dice si vas ganando:
hay que verla contra lo que pusiste. Y como la aportación cambia cuando abres o
cierras, la línea de coste es escalonada — esos escalones son las decisiones.
"""

from __future__ import annotations

from bisect import bisect_right
from datetime import date

# Por debajo de esto no hay curva: hay dos puntos y una recta entre ellos.
MIN_PUNTOS = 10
# La respuesta se adelgaza a este tamaño. Cinco años diarios son ~1260 puntos
# para dibujar una línea de 600 píxeles.
MAX_PUNTOS = 260


def _indice(serie: list[tuple[date, float]]) -> tuple[list[date], list[float]]:
    ordenada = sorted(serie)
    return [d for d, _ in ordenada], [v for _, v in ordenada]


def _vigente(fechas: list[date], valores: list[float], cuando: date) -> float | None:
    """El último valor conocido en o antes de `cuando`.

    Ni los precios ni los tipos existen todos los días: hay fines de semana,
    festivos y huecos de publicación. Coger el valor vigente es lo que hace una
    plataforma real; interpolar inventaría movimiento donde no lo hubo.
    """
    if not fechas:
        return None
    i = bisect_right(fechas, cuando)
    return valores[i - 1] if i else None


def historial(
    posiciones: list[dict],
    series: dict[str, list[tuple[date, float]]],
    tipos: dict[str, list[tuple[date, float]]] | None = None,
    *,
    base: str = "USD",
    hoy: date | None = None,
) -> dict:
    """Valor e inversión de la cartera, día a día.

    `posiciones` llevan `symbol`, `quantity`, `cost_basis`, `currency`,
    `opened_at` y `closed_at` (o None). `series` son los cierres por símbolo y
    `tipos` las series de «unidades por dólar» por divisa.
    """
    hoy = hoy or date.today()
    if not posiciones:
        return {"disponible": False, "nota": "No hay posiciones que recorrer."}

    tipos = tipos or {}
    idx_precio = {s: _indice(p) for s, p in series.items() if p}
    idx_fx = {m: _indice(t) for m, t in (tipos or {}).items() if t}

    usables, excluidas = [], []
    for p in posiciones:
        symbol = p["symbol"]
        moneda = (p.get("currency") or base).upper()
        if symbol not in idx_precio:
            excluidas.append({"symbol": symbol, "motivo": "sin histórico de precios en caché"})
            continue
        if moneda != base and moneda not in idx_fx:
            excluidas.append(
                {"symbol": symbol, "motivo": f"sin histórico de tipo de cambio para {moneda}"}
            )
            continue
        usables.append({**p, "currency": moneda})

    if not usables:
        return {
            "disponible": False,
            "excluidas": excluidas,
            "nota": (
                "Ninguna posición tiene histórico utilizable. Abre Cartera y pulsa "
                "«Descargar histórico completo» para que haya con qué dibujar."
            ),
        }

    # El calendario sale de los precios, no de un rango inventado: así los
    # puntos caen en sesiones reales y no en domingos.
    desde = min(p["opened_at"] for p in usables)
    calendario = sorted(
        {
            d
            for p in usables
            for d in idx_precio[p["symbol"]][0]
            if desde <= d <= hoy
        }
    )
    if len(calendario) < MIN_PUNTOS:
        return {
            "disponible": False,
            "excluidas": excluidas,
            "nota": (
                f"Solo {len(calendario)} sesiones desde la primera compra: hacen falta "
                f"al menos {MIN_PUNTOS} para que una curva sea una curva."
            ),
        }

    cierres = sorted({p["closed_at"] for p in usables if p.get("closed_at")})
    puntos = []
    for d in calendario:
        valor = invertido = 0.0
        abiertas = 0
        for p in usables:
            if d < p["opened_at"] or (p.get("closed_at") and d >= p["closed_at"]):
                continue
            precio = _vigente(*idx_precio[p["symbol"]], d)
            if precio is None:
                continue
            factor = 1.0
            if p["currency"] != base:
                por_usd = _vigente(*idx_fx[p["currency"]], d)
                if not por_usd:
                    continue  # sin tipo vigente ese día, esa posición no cuenta
                factor = 1.0 / por_usd
            valor += p["quantity"] * precio * factor
            invertido += p["quantity"] * p["cost_basis"] * factor
            abiertas += 1
        puntos.append(
            {
                "fecha": d.isoformat(),
                "valor": round(valor, 2),
                "invertido": round(invertido, 2),
                "abiertas": abiertas,
            }
        )

    _encadenar_indice(puntos, usables, calendario, idx_precio, idx_fx, base)

    return {
        "disponible": True,
        "base": base,
        "puntos": _adelgazar(puntos),
        "desde": calendario[0].isoformat(),
        "hasta": calendario[-1].isoformat(),
        "sesiones": len(calendario),
        "excluidas": excluidas,
        "cierres": [c.isoformat() for c in cierres],
        "resumen": _resumen(puntos),
        "aviso": _aviso(base, cierres, excluidas, any(p["currency"] != base for p in usables)),
    }


def _encadenar_indice(
    puntos: list[dict],
    posiciones: list[dict],
    calendario: list[date],
    idx_precio: dict,
    idx_fx: dict,
    base: str,
) -> None:
    """Añade a cada punto un índice base 100 inmune a compras y ventas.

    Lo escribe in situ porque el índice no es un dato aparte: es la otra lectura
    del mismo recorrido.

    ## Por qué hace falta

    El drawdown calculado sobre el valor bruto cuenta las VENTAS como caídas. En
    la cartera de prueba, vender una posición hundió la línea un 10,5 % y el
    resumen publicaba «peor caída vivida: −11,8 %» — casi entera, tu propia
    decisión de vender presentada como un golpe del mercado. Exactamente lo
    contrario de lo que sirve para saber si aguantarías otra vez.

    Cada día se encadena el retorno calculado SOLO sobre las posiciones que
    estaban abiertas ese día y el anterior. Una que entra o sale no aporta
    retorno el día del movimiento: aporta a partir del siguiente. Así el índice
    mide lo que hizo el mercado con tu dinero, y el valor bruto mide cuánto
    dinero había — dos preguntas distintas que estaban dando un solo número.
    """
    valor = 100.0
    previo: dict[str, float] | None = None

    for i, d in enumerate(calendario):
        actuales: dict[str, float] = {}
        pesos: dict[str, float] = {}
        for p in posiciones:
            if d < p["opened_at"] or (p.get("closed_at") and d >= p["closed_at"]):
                continue
            precio = _vigente(*idx_precio[p["symbol"]], d)
            if precio is None:
                continue
            factor = 1.0
            if p["currency"] != base:
                por_usd = _vigente(*idx_fx[p["currency"]], d)
                if not por_usd:
                    continue
                factor = 1.0 / por_usd
            unitario = precio * factor
            actuales[p["symbol"]] = unitario
            pesos[p["symbol"]] = p["quantity"] * unitario

        if previo is not None:
            # Solo las que estaban a ambos lados del día: las que entran o salen
            # no tienen retorno que aportar sin contaminarlo con el movimiento.
            comunes = [s for s in actuales if s in previo and previo[s]]
            peso_total = sum(pesos[s] for s in comunes)
            if peso_total > 0:
                r = sum(
                    (pesos[s] / peso_total) * (actuales[s] / previo[s] - 1) for s in comunes
                )
                valor *= 1 + r
        puntos[i]["indice"] = round(valor, 3)
        previo = actuales


def _adelgazar(puntos: list[dict], maximo: int = MAX_PUNTOS) -> list[dict]:
    """Recorta la serie conservando primero, último y los extremos del valor.

    Mismo cuidado que en la curva de crisis: un remuestreo que se salta el
    mínimo enseña una caída más suave de la que hubo, y entonces el dibujo
    desmiente al resumen que va justo al lado.
    """
    if len(puntos) <= maximo:
        return puntos
    paso = (len(puntos) - 1) / (maximo - 1)
    indices = {round(i * paso) for i in range(maximo)}
    indices.add(0)
    indices.add(len(puntos) - 1)
    indices.add(min(range(len(puntos)), key=lambda i: puntos[i]["valor"]))
    indices.add(max(range(len(puntos)), key=lambda i: puntos[i]["valor"]))
    return [puntos[i] for i in sorted(indices)]


def _resumen(puntos: list[dict]) -> dict:
    """El pico, el suelo y la peor caída del recorrido REAL de tu dinero.

    Se calcula sobre la serie completa y no sobre la adelgazada: el resumen no
    puede depender de cuántos puntos quepan en el dibujo.

    La caída máxima sale del ÍNDICE encadenado, no del valor bruto. Sobre el
    valor bruto, vender una posición cuenta como una caída — en la cartera de
    prueba publicaba un −11,8 % del que un −10,5 % era la venta. El índice no
    se entera de compras ni de ventas, así que su drawdown es lo que de verdad
    te hizo el mercado, que es lo único que dice si aguantarías otra vez.
    """
    if not puntos:
        return {"disponible": False}
    valores = [p["valor"] for p in puntos if p["valor"] > 0]
    if not valores:
        return {"disponible": False}

    peor, pico_en, valle_en = 0.0, puntos[0]["fecha"], puntos[0]["fecha"]
    pico_idx, pico_idx_en = puntos[0].get("indice", 100.0), puntos[0]["fecha"]
    for p in puntos:
        idx = p.get("indice")
        if idx is None or idx <= 0:
            continue
        if idx > pico_idx:
            pico_idx, pico_idx_en = idx, p["fecha"]
        caida = idx / pico_idx - 1
        if caida < peor:
            peor, pico_en, valle_en = caida, pico_idx_en, p["fecha"]

    pico_valor = max(valores)
    ultimo = puntos[-1]
    indice_final = ultimo.get("indice", 100.0)
    return {
        "disponible": True,
        "maximo": round(pico_valor, 2),
        "actual": ultimo["valor"],
        "invertido_actual": ultimo["invertido"],
        "max_drawdown_pct": round(peor * 100, 1),
        "drawdown_desde": pico_en,
        "drawdown_hasta": valle_en,
        "bajo_maximo_pct": round((ultimo["valor"] / pico_valor - 1) * 100, 1)
        if pico_valor
        else None,
        # El índice encadenado: qué ha hecho el mercado con tu dinero, al margen
        # de cuánto dinero pusiste o sacaste por el camino.
        "indice_final": round(indice_final, 2),
        "rendimiento_pct": round(indice_final - 100, 1),
    }


def _aviso(base: str, cierres: list[date], excluidas: list[dict], hay_divisas: bool) -> str:
    partes = [
        f"Es el valor de las posiciones ABIERTAS en {base}, no el de tu cuenta: la "
        "app no lleva saldo en efectivo."
    ]
    if cierres:
        partes.append(
            f"Cerraste algo en {len(cierres)} fecha(s) ({', '.join(c.isoformat() for c in cierres[:3])}"
            f"{'…' if len(cierres) > 3 else ''}), y cada cierre hace BAJAR la línea. "
            "Eso es una retirada, no una pérdida."
        )
    if hay_divisas:
        partes.append(
            "Cada día se convierte con el tipo vigente ESE día, no con el de hoy: "
            "usar el actual convertiría un movimiento de divisa en uno de la acción."
        )
    if excluidas:
        nombres = ", ".join(e["symbol"] for e in excluidas[:4])
        partes.append(
            f"{len(excluidas)} posición(es) quedan fuera de la curva ({nombres}) por "
            "no tener histórico: la línea describe el resto."
        )
    return " ".join(partes)
