"""¿Bate la estrategia a lo simple? Un motor, cuatro carteras, misma vara.

La pregunta que ordena todo lo demás. Un sistema puede tener esperanza positiva
y aun así ser peor que comprar el índice y no mirarlo — y en ese caso todo el
trabajo de puntuar, filtrar y rebalancear no solo sobra: cuesta dinero.

**Por qué un único motor.** Las cuatro carteras se simulan con el mismo código y
solo cambian en una función: *dado este día, ¿qué tengo en cartera?* Comparar
implementaciones distintas es como se cuelan las ventajas ficticias — una paga
costes y otra no, una se rebalancea y otra no, una mira un dato que la otra no
tiene. Aquí eso es imposible por construcción.

**Por qué curvas de capital y no listas de operaciones.** Volatilidad, Sharpe y
drawdown son propiedades de una serie temporal de patrimonio. Una media de
operaciones sueltas no puede producirlas, y sin ellas «esperanza +4 %» no dice
si el camino fue soportable: un +4 % con un −60 % por medio no se aguanta.

**Por qué bootstrap por bloques.** Los retornos financieros están
autocorrelados y agrupan la volatilidad. Un bootstrap que remuestrea días
sueltos rompe esa estructura y produce intervalos demasiado estrechos — diría
«significativo» donde no lo hay. Remuestrear bloques contiguos la conserva.
"""

from __future__ import annotations

import math
import random
from datetime import date

from app.analysis.backtest import _closest_bar, _to_date, momentum_12_1

MESES_ANO = 12
BLOQUE_BOOTSTRAP = 6      # meses por bloque: conserva la agrupación de volatilidad
REMUESTREOS = 2000
MARGEN_CLARO_PCT = 1.0    # ventaja anual mínima para no llamarlo empate


# --- Selectores: lo único que distingue una estrategia de otra ---------------


def seleccion_comprar_y_mantener(universo, as_of, primera):
    """Todo el universo, comprado el primer día y nunca tocado."""
    return set(universo) if primera else None  # None = no cambiar nada


def seleccion_equiponderada(universo, as_of, primera):
    """Todo el universo, con rebalanceo en cada fecha. Paga la rotación."""
    return set(universo)


def hacer_seleccion_momentum(top_n: int = 10):
    """Las `top_n` de mayor momentum 12-1. El baseline serio a batir."""

    def seleccionar(universo, as_of, primera):
        puntuadas = []
        for symbol, data in universo.items():
            m = momentum_12_1(data.get("bars", []), as_of)
            if m is not None:
                puntuadas.append((m, symbol))
        if not puntuadas:
            return None
        puntuadas.sort(reverse=True)
        return {s for _, s in puntuadas[:top_n]}

    return seleccionar


def hacer_seleccion_desde_operaciones(operaciones: list[dict]):
    """La estrategia real, reconstruida desde sus operaciones simuladas.

    Se usa la misma lista de trades que produce el backtest de reglas, así que
    la curva describe exactamente el sistema que la app ejecuta — no una
    reimplementación parecida que podría diferir en algún detalle.
    """
    abiertas: list[tuple[date, date, str]] = []
    for o in operaciones:
        entrada, salida = _to_date(o["entrada_fecha"]), _to_date(o["salida_fecha"])
        if entrada and salida:
            abiertas.append((entrada, salida, o["symbol"]))

    def seleccionar(universo, as_of, primera):
        return {s for ini, fin, s in abiertas if ini <= as_of <= fin}

    return seleccionar


# --- El motor ----------------------------------------------------------------


def _precio(data: dict, as_of: date) -> float | None:
    serie = data.get("_serie")
    if serie is None:
        serie = [
            (d, b["close"])
            for b in data.get("bars", [])
            if (d := _to_date(b.get("ts"))) is not None and b.get("close")
        ]
        serie.sort(key=lambda p: p[0])
        data["_serie"] = serie
    barra = _closest_bar([(d, {"close": c}) for d, c in serie], as_of)
    return barra["close"] if barra else None


def simular_cartera(
    universo: dict[str, dict],
    fechas: list[date],
    seleccionar,
    coste_lado: float,
) -> dict:
    """Curva de capital de una cartera equiponderada entre lo seleccionado.

    El coste se cobra sobre la rotación real: si un 30 % de la cartera cambia de
    manos, se paga el coste sobre ese 30 % en ambos lados. Una estrategia que
    rota mucho lo paga aquí, que es donde debe notarse.
    """
    capital = 1.0
    pesos: dict[str, float] = {}
    curva: list[dict] = []
    retornos: list[float] = []
    rotacion_total = 0.0

    for i, as_of in enumerate(fechas):
        # 1) Revalorizar lo que ya se tenía desde la fecha anterior.
        if pesos and i > 0:
            anterior = fechas[i - 1]
            bruto = 0.0
            for symbol, peso in pesos.items():
                p0 = _precio(universo[symbol], anterior)
                p1 = _precio(universo[symbol], as_of)
                bruto += peso * ((p1 / p0) if p0 and p1 else 1.0)
            resto = 1.0 - sum(pesos.values())  # la parte en liquidez no renta
            factor = bruto + resto
            capital *= factor
            retornos.append(factor - 1)
            # Los pesos derivan solos con el precio: sin esto, el rebalanceo
            # parecería gratis incluso cuando no cambia la selección.
            if factor:
                pesos = {
                    s: w * ((_precio(universo[s], as_of) or 1) / (_precio(universo[s], anterior) or 1)) / factor
                    for s, w in pesos.items()
                }

        # 2) Reasignar según la estrategia.
        elegidos = seleccionar(universo, as_of, i == 0)
        if elegidos is not None:
            disponibles = {s for s in elegidos if _precio(universo[s], as_of)}
            nuevos = (
                {s: 1.0 / len(disponibles) for s in disponibles} if disponibles else {}
            )
            simbolos = set(pesos) | set(nuevos)
            rotacion = sum(abs(nuevos.get(s, 0.0) - pesos.get(s, 0.0)) for s in simbolos)
            capital *= 1 - rotacion * coste_lado / 100
            rotacion_total += rotacion
            pesos = nuevos

        curva.append({"fecha": as_of.isoformat(), "capital": round(capital, 6)})

    return {
        "curva": curva,
        "retornos": retornos,
        "rotacion_media": round(rotacion_total / max(len(fechas), 1), 3),
        **metricas(curva, retornos),
    }


# --- Métricas ----------------------------------------------------------------


def metricas(curva: list[dict], retornos: list[float], rf_anual: float = 0.0) -> dict:
    """Retorno, volatilidad, Sharpe y máxima caída de una curva de capital.

    El Sharpe usa una tasa libre de riesgo de 0 por defecto. No es lo ortodoxo,
    pero es honesto y no distorsiona la comparación: infla igual a las cuatro
    carteras, así que el ORDEN entre ellas no cambia. Compararlo con el Sharpe
    publicado de un fondo sí sería un error.
    """
    if len(curva) < 2 or not retornos:
        return {"cagr_pct": None, "vol_pct": None, "sharpe": None, "max_drawdown_pct": None}

    final = curva[-1]["capital"]
    años = len(retornos) / MESES_ANO
    cagr = (final ** (1 / años) - 1) if años > 0 and final > 0 else None

    medio = sum(retornos) / len(retornos)
    if len(retornos) > 1:
        var = sum((r - medio) ** 2 for r in retornos) / (len(retornos) - 1)
        vol = math.sqrt(var) * math.sqrt(MESES_ANO)
    else:
        vol = None

    pico = curva[0]["capital"]
    peor = 0.0
    for punto in curva:
        pico = max(pico, punto["capital"])
        if pico:
            peor = min(peor, punto["capital"] / pico - 1)

    return {
        "cagr_pct": round(cagr * 100, 2) if cagr is not None else None,
        "vol_pct": round(vol * 100, 2) if vol else None,
        "sharpe": round((cagr - rf_anual) / vol, 2) if cagr is not None and vol else None,
        "max_drawdown_pct": round(peor * 100, 2),
        "n_periodos": len(retornos),
    }


# --- Bootstrap por bloques ---------------------------------------------------


def bootstrap_diferencia(
    a: list[float],
    b: list[float],
    bloque: int = BLOQUE_BOOTSTRAP,
    n: int = REMUESTREOS,
    semilla: int = 12345,
) -> dict:
    """¿La diferencia entre dos carteras cabe dentro del azar?

    Remuestrea **bloques contiguos** de meses emparejados. Los retornos están
    autocorrelados y agrupan la volatilidad; remuestrear meses sueltos rompe esa
    estructura y estrecha el intervalo, que es como se declara «significativo»
    algo que no lo es.

    Se remuestrean los pares (no cada serie por su lado) porque las dos carteras
    viven el mismo mercado: separarlas destruiría la correlación entre ellas y
    exageraría la incertidumbre de la diferencia.
    """
    pares = list(zip(a, b))
    if len(pares) < bloque * 2:
        return {"n": len(pares), "suficiente": False}

    rng = random.Random(semilla)
    diferencias = []
    n_bloques = max(1, len(pares) // bloque)
    for _ in range(n):
        muestra: list[tuple[float, float]] = []
        for _ in range(n_bloques):
            inicio = rng.randrange(0, len(pares) - bloque + 1)
            muestra.extend(pares[inicio : inicio + bloque])
        media_a = sum(x for x, _ in muestra) / len(muestra)
        media_b = sum(y for _, y in muestra) / len(muestra)
        diferencias.append((media_a - media_b) * MESES_ANO * 100)

    diferencias.sort()
    def q(p):
        return round(diferencias[min(int(p * len(diferencias)), len(diferencias) - 1)], 2)

    bajo, alto = q(0.025), q(0.975)
    observada = round((sum(a) / len(a) - sum(b) / len(b)) * MESES_ANO * 100, 2)
    return {
        "n": len(pares),
        "suficiente": True,
        "diferencia_anual_pct": observada,
        "ic95": [bajo, alto],
        # Que el intervalo cruce el cero significa que, con estos datos, no se
        # puede distinguir la diferencia del azar. No significa que sea cero.
        "distinguible_del_azar": bajo > 0 or alto < 0,
        "prob_supera": round(sum(1 for d in diferencias if d > 0) / len(diferencias), 3),
    }


# --- La tabla y el veredicto -------------------------------------------------


def comparar(
    universo: dict[str, dict],
    fechas: list[date],
    operaciones: list[dict],
    coste_lado: float,
    top_momentum: int = 10,
) -> dict:
    """Estrategia contra los tres baselines, mismas fechas y mismos costes."""
    carteras = {
        "estrategia": hacer_seleccion_desde_operaciones(operaciones),
        "comprar_y_mantener": seleccion_comprar_y_mantener,
        "equiponderada": seleccion_equiponderada,
        "momentum_12m": hacer_seleccion_momentum(top_momentum),
    }
    resultados = {
        nombre: simular_cartera(universo, fechas, sel, coste_lado)
        for nombre, sel in carteras.items()
    }

    estrategia = resultados["estrategia"]
    comparaciones = {}
    for nombre, r in resultados.items():
        if nombre == "estrategia":
            continue
        comparaciones[nombre] = bootstrap_diferencia(
            estrategia["retornos"], r["retornos"]
        )

    return {
        "tabla": {
            nombre: {k: v for k, v in r.items() if k not in ("curva", "retornos")}
            for nombre, r in resultados.items()
        },
        "curvas": {n: r["curva"] for n, r in resultados.items()},
        "comparaciones": comparaciones,
        "veredicto": _veredicto(resultados, comparaciones),
        "metodologia": (
            "Las cuatro carteras se simulan con el MISMO motor y las mismas "
            "fechas; solo cambian en qué seleccionan cada mes. Todas pagan el "
            "mismo coste sobre su rotación real, así que una estrategia que rota "
            "mucho lo paga aquí. El Sharpe usa tasa libre de riesgo 0: infla "
            "igual a las cuatro, así que el orden entre ellas es válido, pero no "
            "es comparable con el Sharpe publicado de un fondo. Los intervalos "
            "salen de un bootstrap por bloques de 6 meses, que conserva la "
            "autocorrelación y la agrupación de volatilidad — remuestrear meses "
            "sueltos daría intervalos demasiado estrechos."
        ),
    }


_ETIQUETAS = {
    "comprar_y_mantener": "comprar el universo y no tocarlo",
    "equiponderada": "equiponderada con rebalanceo",
    "momentum_12m": "momentum de 12 meses",
}


def _veredicto(resultados: dict, comparaciones: dict) -> str:
    """Lectura sin adornos. Si el sistema no gana, se dice y punto.

    Esta función existe para decir que no. Un backtest que solo sabe redactar
    buenas noticias no es una herramienta de validación, es publicidad — y
    ninguna estrategia mejora porque su informe la trate bien.
    """
    est = resultados["estrategia"]
    if est.get("cagr_pct") is None:
        return "Sin periodos suficientes para comparar nada."

    partes = [
        f"La estrategia rindió {est['cagr_pct']:+.2f} % anual con una "
        f"volatilidad del {est['vol_pct']:.1f} %, Sharpe {est['sharpe']}, y una "
        f"caída máxima del {est['max_drawdown_pct']:.1f} %."
    ]

    # Más retorno asumiendo el doble de volatilidad no es ganar: es apalancar.
    # Quien quisiera ese perfil podría comprar el baseline con margen y quedarse
    # mejor, así que un Sharpe inferior se dice aunque el retorno sea mayor.
    sharpes = [
        (n, r["sharpe"])
        for n, r in resultados.items()
        if n != "estrategia" and r.get("sharpe") is not None
    ]
    if est.get("sharpe") is not None and sharpes:
        mejor_sharpe = max(sharpes, key=lambda p: p[1])
        if mejor_sharpe[1] > est["sharpe"]:
            partes.append(
                f"Ojo al riesgo: su Sharpe ({est['sharpe']}) es PEOR que el de "
                f"{_ETIQUETAS[mejor_sharpe[0]]} ({mejor_sharpe[1]}). Cualquier "
                "retorno extra viene de asumir más volatilidad, no de elegir "
                "mejor — y esa palanca se consigue sin modelo."
            )

    mejores = [
        (n, r["cagr_pct"])
        for n, r in resultados.items()
        if n != "estrategia" and r.get("cagr_pct") is not None
    ]
    if not mejores:
        return " ".join(partes + ["No se pudo simular ningún baseline."])

    ganadores = [(n, c) for n, c in mejores if c >= est["cagr_pct"]]

    if not ganadores:
        margenes = [est["cagr_pct"] - c for _, c in mejores]
        minimo = min(margenes)
        claros = [
            n for n, _ in mejores if comparaciones.get(n, {}).get("distinguible_del_azar")
        ]
        if minimo < MARGEN_CLARO_PCT:
            partes.append(
                f"Supera a los tres baselines, pero al más cercano solo por "
                f"{minimo:.2f} puntos anuales. Un margen así se lo come cualquier "
                "diferencia de comisiones o de fechas: trátalo como un empate."
            )
        elif not claros:
            partes.append(
                "Supera a los tres baselines, pero en NINGUNA comparación el "
                "intervalo de confianza deja el cero fuera. Con estos datos la "
                "ventaja no se distingue del azar."
            )
        else:
            nombres = ", ".join(_ETIQUETAS[n] for n in claros)
            partes.append(
                f"Supera a los tres baselines, y frente a {nombres} la diferencia "
                "queda fuera del azar según el bootstrap. Es lo más parecido a "
                "una ventaja real que este backtest puede mostrar — sobre un "
                "universo sin las empresas que quebraron."
            )
    else:
        peor_que = sorted(ganadores, key=lambda p: -p[1])
        nombre, cagr = peor_que[0]
        partes.append(
            f"NO SUPERA AL BASELINE. {_ETIQUETAS[nombre].capitalize()} rindió "
            f"{cagr:+.2f} % anual frente al {est['cagr_pct']:+.2f} % de la "
            f"estrategia: {cagr - est['cagr_pct']:+.2f} puntos a favor de no "
            "hacer nada."
        )
        if len(peor_que) > 1:
            otros = ", ".join(_ETIQUETAS[n] for n, _ in peor_que[1:])
            partes.append(f"También la superan: {otros}.")
        partes.append(
            "Todo el trabajo de puntuar, filtrar y rebalancear no solo no aporta "
            "aquí: cuesta comisiones y atención. Antes de seguir afinando el "
            "modelo, la pregunta es si merece la pena tenerlo."
        )
    return " ".join(partes)
