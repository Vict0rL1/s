"""De puntuación a decisión: qué hacer, a qué precio y cuándo salir.

Este módulo es el que convierte "esta empresa puntúa bien" en "compra aquí,
sal por aquí". Tres principios que lo gobiernan:

1. **Reglas mecánicas y escritas.** Cada decisión sale de condiciones que se
   pueden leer, discutir y probar. No hay criterio discrecional escondido:
   si una regla es mala, se ve y se cambia.

2. **La salida se define antes de entrar.** Toda propuesta de compra viene con
   stop y objetivo calculados desde su propia volatilidad. Un stop igual para
   una utility y para una biotech no protege de nada.

3. **El tamaño lo fija el riesgo, no la corazonada.** Se arriesga un % fijo del
   capital por operación; cuanto más lejos queda el stop, más pequeña es la
   posición. Así una idea equivocada cuesta lo mismo que cualquier otra.

Lo que esto NO es: una predicción. Las reglas son razonables y están probadas
en el backtest cuando hay muestra suficiente, pero que hayan funcionado antes
no garantiza nada. `confidence` dice explícitamente si están validadas.
"""

from __future__ import annotations

import math

# --- Parámetros del sistema. Están aquí, juntos y con nombre, para que se
# puedan discutir y ajustar sin bucear por el código. ---

RIESGO_POR_OPERACION = 0.01  # 1 % del capital en riesgo si salta el stop
STOP_MIN_PCT = 8.0           # por debajo, el ruido normal te saca sin motivo
STOP_MAX_PCT = 25.0          # por encima, la pérdida deja de ser asumible
STOP_VOLATILIDADES = 2.0     # el stop va a 2 desviaciones mensuales
RATIO_OBJETIVO = 2.0         # se busca ganar el doble de lo que se arriesga
BANDA_ENTRADA_PCT = 2.0      # zona de compra alrededor del último cierre
SESIONES_MES = 21

ACCIONES = {
    "comprar": "Comprar",
    "vigilar": "Vigilar",
    "mantener": "Mantener",
    "reducir": "Reducir",
    "vender": "Vender",
    "evitar": "Evitar",
    "ninguna": "Sin acción",
    "sin_datos": "Sin datos",
}


def _stop_pct(vol_diaria_pct: float | None) -> float:
    """Distancia del stop, dimensionada por la volatilidad de cada empresa."""
    if not vol_diaria_pct:
        return 12.0  # sin volatilidad medible, un valor intermedio y explícito
    mensual = vol_diaria_pct * math.sqrt(SESIONES_MES)
    return round(min(max(STOP_VOLATILIDADES * mensual, STOP_MIN_PCT), STOP_MAX_PCT), 1)


def _niveles(precio: float, vol_diaria_pct: float | None) -> dict:
    stop_pct = _stop_pct(vol_diaria_pct)
    objetivo_pct = round(stop_pct * RATIO_OBJETIVO, 1)
    return {
        "entrada_desde": round(precio * (1 - BANDA_ENTRADA_PCT / 100), 2),
        "entrada_hasta": round(precio * (1 + BANDA_ENTRADA_PCT / 100), 2),
        "stop": round(precio * (1 - stop_pct / 100), 2),
        "stop_pct": stop_pct,
        "objetivo": round(precio * (1 + objetivo_pct / 100), 2),
        "objetivo_pct": objetivo_pct,
        "ratio": RATIO_OBJETIVO,
        # Cuánto capital destinar para arriesgar RIESGO_POR_OPERACION si salta
        # el stop. Es un porcentaje de la cartera, no un número de acciones:
        # la app no sabe cuánto dinero tienes y no va a fingir que sí.
        "peso_sugerido_pct": round(RIESGO_POR_OPERACION * 100 / (stop_pct / 100), 1),
    }


def decide(
    signal: dict,
    price: dict | None,
    position: dict | None = None,
    favorable_min: float = 0.35,
    desfavorable_max: float = -0.35,
) -> dict:
    """Decide qué hacer con una empresa, con sus niveles y sus motivos.

    `position`: {"cost_basis": float, "quantity": float} si ya se tiene, o None.
    """
    score = signal.get("score")
    if price is None or not price.get("last") or score is None:
        return {
            "action": "sin_datos",
            "label": ACCIONES["sin_datos"],
            "reasons": ["Sin precio o sin puntuación: no hay base para decidir."],
            "levels": None,
            "triggers": [],
            "confidence": "ninguna",
            "owned": position is not None,
        }

    ultimo = price["last"]
    sobre_media = price.get("above_sma200")
    sma200 = price.get("sma200")
    niveles = _niveles(ultimo, price.get("daily_vol_pct"))
    razones: list[str] = []
    disparadores: list[str] = []

    # --- Ya se tiene la empresa: la pregunta es si sostenerla o soltarla ---
    if position:
        coste = position.get("cost_basis")
        pnl_pct = round((ultimo / coste - 1) * 100, 2) if coste else None
        stop_posicion = (
            round(coste * (1 - niveles["stop_pct"] / 100), 2) if coste else None
        )

        if score <= desfavorable_max:
            accion = "vender"
            razones.append(
                f"La puntuación cayó a {score:+.2f}: la razón por la que se "
                "compró ya no se sostiene frente a sus comparables."
            )
        elif stop_posicion is not None and ultimo <= stop_posicion:
            accion = "vender"
            razones.append(
                f"El precio ({ultimo}) perforó el stop de la posición "
                f"({stop_posicion}), un {niveles['stop_pct']} % bajo tu coste."
            )
        elif sobre_media is False:
            accion = "reducir"
            razones.append(
                f"Cotiza por debajo de su media de 200 sesiones ({sma200}): la "
                "tendencia se giró en contra aunque los fundamentales aguanten."
            )
        else:
            accion = "mantener"
            razones.append(
                f"Puntuación {score:+.2f} y precio sobre su media de 200 "
                "sesiones: no hay motivo para tocar la posición."
            )

        if pnl_pct is not None:
            razones.append(f"Llevas un {pnl_pct:+.2f} % sobre tu precio de compra.")
        disparadores = [
            f"Vender si cierra por debajo de {stop_posicion}" if stop_posicion else
            "Vender si el precio perfora tu stop",
            f"Vender si la puntuación baja de {desfavorable_max:+.2f}",
            "Revisar si pierde la media de 200 sesiones",
        ]
        return {
            "action": accion,
            "label": ACCIONES[accion],
            "reasons": razones,
            "levels": {**niveles, "stop": stop_posicion or niveles["stop"]},
            "triggers": disparadores,
            "confidence": _confianza(signal),
            "owned": True,
            "pnl_pct": pnl_pct,
        }

    # --- No se tiene: la pregunta es si entrar, esperar o descartar ---
    if score <= desfavorable_max:
        accion = "evitar"
        razones.append(
            f"Puntuación {score:+.2f}: queda por detrás de sus comparables de "
            "sector en valor, calidad y momentum."
        )
    elif score >= favorable_min and sobre_media:
        accion = "comprar"
        razones.append(
            f"Puntuación {score:+.2f} — mejor que sus comparables de sector."
        )
        razones.append(
            f"Cotiza sobre su media de 200 sesiones ({sma200}): la tendencia "
            "acompaña, no estás comprando algo que sigue cayendo."
        )
        disparadores = [
            f"Comprar entre {niveles['entrada_desde']} y {niveles['entrada_hasta']}",
            f"Salir si cierra bajo {niveles['stop']} (−{niveles['stop_pct']} %)",
            f"Tomar beneficios en {niveles['objetivo']} (+{niveles['objetivo_pct']} %)",
        ]
    elif score >= favorable_min:
        accion = "vigilar"
        razones.append(
            f"Puntuación {score:+.2f}, pero cotiza bajo su media de 200 "
            f"sesiones ({sma200}): buena empresa en tendencia bajista."
        )
        razones.append(
            "Comprar aquí es apostar a que el suelo ya pasó. La regla espera a "
            "que el precio recupere la media antes de entrar."
        )
        disparadores = [
            f"Comprar cuando cierre por encima de {sma200}" if sma200 else
            "Comprar cuando recupere su media de 200 sesiones",
        ]
    else:
        # Ni destaca ni preocupa. Meterla en "vigilar" diluiría la lista de
        # espera hasta volverla inútil: vigilar es para empresas buenas
        # esperando que la tendencia gire, no para el montón.
        accion = "ninguna"
        razones.append(
            f"Puntuación {score:+.2f}: ni destaca ni preocupa frente a sus "
            "comparables. No hay motivo para actuar."
        )
        disparadores = [f"Revisar si supera {favorable_min:+.2f}"]

    if price.get("drawdown_pct") is not None and price["drawdown_pct"] < -25:
        razones.append(
            f"Está un {abs(price['drawdown_pct']):.0f} % por debajo de su "
            "máximo del año: comprueba qué pasó antes de entrar."
        )

    return {
        "action": accion,
        "label": ACCIONES[accion],
        "reasons": razones,
        "levels": niveles if accion in {"comprar", "vigilar"} else None,
        "triggers": disparadores,
        "confidence": _confianza(signal),
        "owned": False,
    }


def _confianza(signal: dict) -> str:
    """Si las reglas están validadas contra histórico o solo son razonables."""
    if signal.get("probability") is not None:
        return "calibrada"
    return "sin_calibrar"
