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

# Los topes del stop dependen de la clase de activo, y no es un detalle. Con el
# rango de las acciones aplicado a cripto, Bitcoin (27 %), Ethereum (37 %) y
# cualquier altcoin (60 %) se pegan TODAS al tope de 25 %: el stop deja de
# dimensionarse por volatilidad y pasa a ser una constante demasiado ceñida que
# el ruido normal perfora una y otra vez. Un stop que salta por ruido no
# protege, solo materializa pérdidas.
#
# La contrapartida se paga donde toca: con un stop del 60 %, arriesgar el mismo
# 1 % obliga a una posición de 1,7 % de la cartera. El riesgo por idea sigue
# siendo el mismo; lo que cambia es cuánto dinero hace falta para asumirlo.
TOPES_STOP: dict[str, tuple[float, float]] = {
    "accion": (STOP_MIN_PCT, STOP_MAX_PCT),
    "cripto": (15.0, 60.0),
    "etf": (6.0, 20.0),  # un índice diversificado se mueve menos que sus partes
}
RATIO_OBJETIVO = 2.0         # se busca ganar el doble de lo que se arriesga
BANDA_ENTRADA_PCT = 2.0      # zona de compra alrededor del último cierre

# Banda muerta alrededor de la media de 200 sesiones. Sin ella, un precio que
# oscila un 1 % en torno a su media cruza la línea varias veces por semana y la
# señal salta de "comprar" a "vigilar" y de "mantener" a "reducir" un día sí y
# otro también. Cada ida y vuelta cuesta ~3,3 % en comisiones y cambio de
# divisa, así que el vaivén no es un detalle estético: se paga.
#
# Es asimétrica a propósito: hace falta superar la media por 2 % para entrar,
# pero solo perderla por 1 % para salir. Cuesta más entrar que salir, que es
# como debe ser cuando la penalización por equivocarse es asimétrica.
BANDA_TENDENCIA_ENTRAR_PCT = 2.0
BANDA_TENDENCIA_SALIR_PCT = 1.0
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


def _stop_pct(vol_diaria_pct: float | None, clase: str = "accion") -> float:
    """Distancia del stop, dimensionada por la volatilidad y la clase de activo."""
    minimo, maximo = TOPES_STOP.get(clase, TOPES_STOP["accion"])
    if not vol_diaria_pct:
        # Sin volatilidad medible, el punto medio del rango de su clase: es
        # explícito y no finge una precisión que no hay.
        return round((minimo + maximo) / 2, 1)
    mensual = vol_diaria_pct * math.sqrt(SESIONES_MES)
    return round(min(max(STOP_VOLATILIDADES * mensual, minimo), maximo), 1)


def _niveles(precio: float, vol_diaria_pct: float | None, clase: str = "accion") -> dict:
    stop_pct = _stop_pct(vol_diaria_pct, clase)
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
    reglas: dict | None = None,
    clase: str = "accion",
    resultados_en: str | None = None,
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
    sma200 = price.get("sma200")
    # `above_sma200` es un booleano crudo que cambia con cualquier roce de la
    # línea. Aquí se aplica la banda muerta: hay tres estados, no dos.
    # Tres estados: True (claramente encima), False (claramente debajo) y None
    # (dentro de la banda). None se propaga a propósito — volver al booleano
    # crudo aquí anularía la banda entera. Aguas abajo, None no basta para
    # entrar (se va a "vigilar") ni basta para salir (se queda en "mantener"),
    # que es exactamente la asimetría que corta el vaivén.
    sobre_media = _tendencia(ultimo, sma200, price.get("above_sma200"))
    niveles = _niveles(ultimo, price.get("daily_vol_pct"), clase)
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

        # Sobre algo que ya tienes, una "zona de compra" y un objetivo medidos
        # desde el precio de hoy no significan nada: los niveles que importan
        # se anclan a TU coste. Y el porcentaje del stop se expresa desde el
        # precio actual, que es la distancia que de verdad te queda.
        niveles_posicion = None
        if stop_posicion is not None:
            objetivo = round(coste * (1 + niveles["objetivo_pct"] / 100), 2)
            niveles_posicion = {
                "entrada_desde": None,
                "entrada_hasta": None,
                "stop": stop_posicion,
                "stop_pct": round((stop_posicion / ultimo - 1) * 100, 1),
                "objetivo": objetivo,
                "objetivo_pct": round((objetivo / ultimo - 1) * 100, 1),
                "ratio": niveles["ratio"],
                "peso_sugerido_pct": None,
            }
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
            "levels": niveles_posicion,
            "triggers": disparadores,
            "confidence": _confianza(signal, reglas),
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

    # Entrar dos días antes de una presentación de resultados convierte una
    # apuesta de factores en cara o cruz: el precio se moverá por una noticia
    # que el modelo no conoce y que no está en ningún múltiplo. La idea no se
    # descarta, se aplaza — que es justo lo que hace "vigilar".
    if resultados_en and accion == "comprar":
        accion = "vigilar"
        razones.insert(
            0,
            f"Presenta resultados el {resultados_en}. La idea es buena, pero "
            "entrar justo antes es apostar a una noticia que el modelo no puede "
            "ver; el movimiento del día lo decide la sorpresa, no los factores.",
        )
        disparadores = [
            f"Comprar cuando hayan publicado ({resultados_en}) y la puntuación aguante",
            *disparadores[1:],
        ]
    elif resultados_en:
        razones.append(f"Presenta resultados el {resultados_en}: espera volatilidad.")

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
        "confidence": _confianza(signal, reglas),
        "owned": False,
    }


def _confianza(signal: dict, reglas: dict | None = None) -> str:
    """En qué apoyarse: reglas probadas, reglas refutadas o solo razonables.

    `reglas` es el resumen guardado por el backtest de reglas. Tiene tres
    desenlaces posibles y los tres importan:

    - **refutada**: se probaron y perdieron dinero. Es el caso que ninguna app
      enseña, y el único que de verdad te ahorra dinero. Pesa más que cualquier
      otra señal, así que se devuelve aunque el modelo de factores esté calibrado.
    - **calibrada**: hay respaldo histórico con muestra suficiente.
    - **sin_calibrar**: son razonables y nada más.
    """
    if reglas and reglas.get("fiable"):
        esperanza = reglas.get("esperanza_pct")
        ventaja = reglas.get("ventaja_pct")
        if esperanza is not None and (
            esperanza <= 0 or (ventaja is not None and ventaja <= 0)
        ):
            return "refutada"
        return "calibrada"
    if signal.get("probability") is not None:
        return "calibrada"
    return "sin_calibrar"


def _tendencia(ultimo: float, sma200: float | None, crudo: bool | None) -> bool | None:
    """¿Acompaña la tendencia? Con banda muerta alrededor de la media.

    Devuelve True (claramente encima), False (claramente debajo) o None (dentro
    de la banda: ni una cosa ni la otra). El estado intermedio es la pieza clave
    — sin él, «no está claro» se convierte por defecto en «está debajo», y esa
    conversión silenciosa es la que produce el vaivén.
    """
    if not sma200:
        return crudo
    if ultimo >= sma200 * (1 + BANDA_TENDENCIA_ENTRAR_PCT / 100):
        return True
    if ultimo <= sma200 * (1 - BANDA_TENDENCIA_SALIR_PCT / 100):
        return False
    return None
