"""¿Ganan dinero las reglas? Simulación operación a operación.

El backtest de `backtest.py` responde a una pregunta distinta y más estrecha:
*¿la puntuación ordena las empresas mejor que la mediana?* Es una prueba del
**modelo de factores**, y está bien resuelta.

Pero eso no es lo que ejecuta la app. La app aplica reglas: entra solo si además
el precio está sobre su media de 200 sesiones, pone un stop dimensionado por
volatilidad, un objetivo al doble, y sale por lo que llegue antes. Ninguna de
esas piezas aparecía en el backtest anterior, así que **el sistema que de verdad
se usa nunca se había medido**.

Este módulo lo mide de la única forma que sirve: abriendo cada operación en su
fecha, siguiéndola día a día hasta que salta el stop, toca el objetivo o vence
el plazo, y contando el resultado neto de costes.

Tres decisiones que condicionan lo que sale, y que conviene tener presentes al
leer los números:

1. **Costes dentro, no fuera.** Un sistema con stops rota posiciones, y para
   quien compra en EE. UU. desde Canadá la conversión de divisa suele pesar más
   que cualquier ventaja del modelo. Un backtest sin costes no es optimista: es
   falso.

2. **La entrada es al cierre SIGUIENTE a la señal.** La señal se conoce con el
   cierre del día; comprar a ese mismo precio sería comprar con información que
   aún no tenías.

3. **Sesgo de supervivencia: presente y sin arreglar.** El universo son los
   miembros de HOY del índice. Las empresas que quebraron o fueron expulsadas no
   están, así que cualquier resultado aquí está inflado en una cantidad que no
   se puede cuantificar con fuentes gratuitas. Se declara en la salida y la UI
   debe enseñarlo: es la diferencia entre un backtest y un espejismo.
"""

from __future__ import annotations

from datetime import date, timedelta

from app.analysis.backtest import (
    BACKTESTABLE_WEIGHTS,
    _closest_bar,
    _to_date,
    metrics_from_period,
    momentum_12_1,
    point_in_time_period,
)
from app.analysis.decision import _stop_pct
from app.analysis.factors import (
    build_raw_factors,
    composite_score,
    family_scores,
    zscores,
)
from app.analysis.signal import FAVORABLE_MIN, wilson_interval

# --- Costes. Los valores por defecto describen a un inversor particular
# canadiense comprando acciones estadounidenses, que es el caso de esta app. ---

COMISION_PCT = 0.10   # ida o vuelta, sobre el importe. ~10 $ en una posición de 10 000 $
DIVISA_PCT = 1.50     # conversión CAD→USD en un bróker canadiense típico, por lado
DESLIZAMIENTO_PCT = 0.05  # diferencia entre el precio visto y el ejecutado

MAX_SESIONES = 252    # un año: si no salta stop ni objetivo, se cierra y se cuenta
SESIONES_SMA = 200
MIN_BARRAS_VOL = 63


def costes_por_lado(con_divisa: bool = True) -> float:
    """Coste porcentual de UNA operación (entrar o salir)."""
    return COMISION_PCT + DESLIZAMIENTO_PCT + (DIVISA_PCT if con_divisa else 0.0)


def _serie(bars: list[dict]) -> list[tuple[date, float]]:
    salida = [
        (d, b["close"])
        for b in bars
        if (d := _to_date(b.get("ts"))) is not None and b.get("close")
    ]
    salida.sort(key=lambda par: par[0])
    return salida


def _sma(serie: list[tuple[date, float]], as_of: date, n: int) -> float | None:
    previos = [c for d, c in serie if d <= as_of]
    if len(previos) < n:
        return None
    return sum(previos[-n:]) / n


def _vol_diaria_pct(serie: list[tuple[date, float]], as_of: date) -> float | None:
    """Volatilidad diaria point-in-time: la misma que dimensiona el stop en vivo."""
    previos = [c for d, c in serie if d <= as_of][-(MIN_BARRAS_VOL + 1):]
    if len(previos) < MIN_BARRAS_VOL:
        return None
    retornos = [
        previos[i] / previos[i - 1] - 1
        for i in range(1, len(previos))
        if previos[i - 1]
    ]
    if len(retornos) < 20:
        return None
    medio = sum(retornos) / len(retornos)
    varianza = sum((r - medio) ** 2 for r in retornos) / (len(retornos) - 1)
    return (varianza ** 0.5) * 100


def simular_operacion(
    serie: list[tuple[date, float]],
    señal_en: date,
    stop_pct: float,
    objetivo_pct: float,
    coste_lado: float,
    max_sesiones: int = MAX_SESIONES,
) -> dict | None:
    """Abre en el cierre siguiente a la señal y sigue el precio hasta salir.

    Salidas posibles, por orden de comprobación en cada sesión: stop, objetivo,
    y vencimiento del plazo. Si en una misma sesión el cierre está por debajo
    del stop se asume stop — el caso desfavorable, porque con datos diarios no
    se puede saber cuál se tocó primero dentro del día.
    """
    futuras = [(d, c) for d, c in serie if d > señal_en]
    if not futuras:
        return None

    entrada_fecha, entrada = futuras[0]
    if not entrada:
        return None
    stop = entrada * (1 - stop_pct / 100)
    objetivo = entrada * (1 + objetivo_pct / 100)

    camino = futuras[1 : max_sesiones + 1]
    if not camino:
        return None

    salida_fecha, salida, motivo = camino[-1][0], camino[-1][1], "plazo"
    for d, cierre in camino:
        if cierre <= stop:
            salida_fecha, salida, motivo = d, cierre, "stop"
            break
        if cierre >= objetivo:
            salida_fecha, salida, motivo = d, cierre, "objetivo"
            break

    # El coste se paga dos veces: al entrar y al salir.
    bruto_pct = (salida / entrada - 1) * 100
    neto_pct = bruto_pct - 2 * coste_lado

    return {
        "entrada_fecha": entrada_fecha.isoformat(),
        "entrada": round(entrada, 2),
        "salida_fecha": salida_fecha.isoformat(),
        "salida": round(salida, 2),
        "motivo": motivo,
        "sesiones": (salida_fecha - entrada_fecha).days,
        "stop_pct": stop_pct,
        "objetivo_pct": objetivo_pct,
        "bruto_pct": round(bruto_pct, 2),
        "neto_pct": round(neto_pct, 2),
        "ganadora": neto_pct > 0,
    }


def _snapshot(
    universe: dict[str, dict], as_of: date, solo_momentum: bool = False
) -> dict[str, dict]:
    """Puntuación y estado técnico de todo el universo en una fecha, sin mirar
    ni un dato posterior a `as_of`.

    `solo_momentum` existe para cripto y ETFs: sin estados financieros no hay
    valor ni calidad que puntuar, y exigirlos dejaba esos activos **imposibles
    de validar por construcción** — sus señales se quedarían en «sin calibrar»
    para siempre, no por falta de ejecutar el backtest sino porque nunca podría
    producir una sola operación.
    """
    crudo: dict[str, dict] = {}
    for symbol, data in universe.items():
        period = None
        if not solo_momentum:
            period = point_in_time_period(
                data.get("periods", []), data.get("filings", []), as_of
            )
            if period is None:
                continue
        serie = data["_serie"]
        barra = _closest_bar(
            [(d, {"close": c}) for d, c in serie], as_of
        )
        if barra is None:
            continue
        metrics = (
            {}
            if period is None
            else metrics_from_period(
                period, barra["close"], period.get("shares_outstanding")
            )
        )
        crudo[symbol] = {
            "raw": build_raw_factors(
                metrics, momentum=momentum_12_1(data.get("bars", []), as_of), sentiment=None
            ),
            "precio": barra["close"],
            "sma200": _sma(serie, as_of, SESIONES_SMA),
            "vol": _vol_diaria_pct(serie, as_of),
        }

    if len(crudo) < 3:
        return {}

    nombres = {f for e in crudo.values() for f in e["raw"]}
    factor_z = {
        f: zscores({s: e["raw"].get(f) for s, e in crudo.items()}) for f in nombres
    }
    familias = family_scores(factor_z)
    for symbol, entrada in crudo.items():
        compuesto = composite_score(
            {f: familias[f].get(symbol) for f in familias}, BACKTESTABLE_WEIGHTS
        )
        entrada["score"] = compuesto["score"]
    return crudo


def run_rule_backtest(
    universe: dict[str, dict],
    rebalance_dates: list[date],
    favorable_min: float = FAVORABLE_MIN,
    ratio_objetivo: float = 2.0,
    con_divisa: bool = True,
    exigir_tendencia: bool = True,
    solo_momentum: bool = False,
    clase: str = "accion",
) -> dict:
    """Simula las reglas de compra tal y como las ejecuta la app.

    `exigir_tendencia=False` desactiva el filtro de la media de 200 sesiones.
    Sirve para responder a una pregunta concreta: ese filtro, ¿aporta algo o es
    superstición? Sin poder contestarla, mantenerlo es un acto de fe.
    """
    for data in universe.values():
        data["_serie"] = _serie(data.get("bars", []))

    coste_lado = costes_por_lado(con_divisa)
    operaciones: list[dict] = []
    descartes = {"sin_puntuacion": 0, "sin_tendencia": 0, "sin_volatilidad": 0}
    referencia: list[float] = []

    for as_of in rebalance_dates:
        crudo = _snapshot(universe, as_of, solo_momentum)
        if not crudo:
            continue

        for symbol, entrada in crudo.items():
            score = entrada.get("score")
            if score is None:
                descartes["sin_puntuacion"] += 1
                continue

            # Referencia: qué habría dado comprar TODO el universo a ciegas en
            # esta misma fecha. Sin ella, un 55 % de aciertos no significa nada.
            base = simular_operacion(
                universe[symbol]["_serie"], as_of, 100.0, 1e9, coste_lado
            )
            if base:
                referencia.append(base["neto_pct"])

            if score < favorable_min:
                continue
            if exigir_tendencia:
                sma = entrada["sma200"]
                if sma is None or entrada["precio"] <= sma:
                    descartes["sin_tendencia"] += 1
                    continue

            stop_pct = _stop_pct(entrada["vol"], clase)
            operacion = simular_operacion(
                universe[symbol]["_serie"],
                as_of,
                stop_pct,
                round(stop_pct * ratio_objetivo, 1),
                coste_lado,
            )
            if operacion is None:
                continue
            operaciones.append({**operacion, "symbol": symbol, "score": round(score, 3)})

    resumen = _resumen(
        operaciones, referencia, descartes, coste_lado, exigir_tendencia, favorable_min
    )
    resumen["clase"] = clase
    resumen["solo_momentum"] = solo_momentum
    return resumen


def _resumen(
    operaciones: list[dict],
    referencia: list[float],
    descartes: dict,
    coste_lado: float,
    exigir_tendencia: bool,
    favorable_min: float,
) -> dict:
    n = len(operaciones)
    if n == 0:
        return {
            "n_operaciones": 0,
            "fiable": False,
            "operaciones": [],
            "descartes": descartes,
            "coste_por_lado_pct": round(coste_lado, 2),
            "coste_total_por_operacion_pct": round(2 * coste_lado, 2),
            # La configuración describe la ejecución, no el resultado: sin ella
            # no se sabe qué se probó cuando no salió ninguna operación.
            "filtro_tendencia": exigir_tendencia,
            "umbral": favorable_min,
            "nota": (
                "Ninguna operación cumplió las condiciones en el periodo. Sin "
                "operaciones no hay nada que validar."
            ),
            "sesgo_supervivencia": _AVISO_SUPERVIVENCIA,
        }

    ganadoras = [o for o in operaciones if o["ganadora"]]
    perdedoras = [o for o in operaciones if not o["ganadora"]]
    netos = [o["neto_pct"] for o in operaciones]
    media_gana = sum(o["neto_pct"] for o in ganadoras) / len(ganadoras) if ganadoras else 0.0
    media_pierde = (
        sum(o["neto_pct"] for o in perdedoras) / len(perdedoras) if perdedoras else 0.0
    )
    tasa = len(ganadoras) / n
    bajo, alto = wilson_interval(len(ganadoras), n)

    ganancia_bruta = sum(o["neto_pct"] for o in ganadoras)
    perdida_bruta = abs(sum(o["neto_pct"] for o in perdedoras))

    media_ref = sum(referencia) / len(referencia) if referencia else None
    esperanza = sum(netos) / n

    # 30 observaciones es el mismo listón que el resto de la app usa para
    # publicar una probabilidad. Por debajo, esto es una anécdota.
    fiable = n >= 30

    return {
        "n_operaciones": n,
        "fiable": fiable,
        "tasa_acierto": round(tasa, 4),
        "tasa_acierto_ic": [round(bajo, 4), round(alto, 4)],
        "esperanza_pct": round(esperanza, 3),
        "media_ganadora_pct": round(media_gana, 2),
        "media_perdedora_pct": round(media_pierde, 2),
        "factor_beneficio": (
            round(ganancia_bruta / perdida_bruta, 2) if perdida_bruta else None
        ),
        "peor_operacion_pct": round(min(netos), 2),
        "mejor_operacion_pct": round(max(netos), 2),
        "racha_perdedora": _racha_perdedora(operaciones),
        "salidas": {
            motivo: sum(1 for o in operaciones if o["motivo"] == motivo)
            for motivo in ("stop", "objetivo", "plazo")
        },
        "referencia_pct": round(media_ref, 3) if media_ref is not None else None,
        "ventaja_pct": (
            round(esperanza - media_ref, 3) if media_ref is not None else None
        ),
        "coste_por_lado_pct": round(coste_lado, 2),
        "coste_total_por_operacion_pct": round(2 * coste_lado, 2),
        "filtro_tendencia": exigir_tendencia,
        "umbral": favorable_min,
        "descartes": descartes,
        "operaciones": operaciones[-200:],
        "sesgo_supervivencia": _AVISO_SUPERVIVENCIA,
        "metodologia": (
            "Simulación por eventos. En cada fecha de rebalanceo se puntúa el "
            "universo con datos point-in-time (estados financieros ya "
            "publicados, precios hasta esa fecha) y se abre posición al cierre "
            "SIGUIENTE en las que cumplen las reglas. Cada operación se sigue "
            "sesión a sesión hasta que salta el stop, toca el objetivo o vence "
            "el plazo de un año. Todos los porcentajes son netos de costes. "
            "Con datos diarios no se sabe qué se tocó primero dentro de una "
            "sesión: si el cierre está bajo el stop se asume stop, que es el "
            "caso desfavorable."
        ),
    }


def _racha_perdedora(operaciones: list[dict]) -> int:
    """Peor racha consecutiva de pérdidas, por fecha de entrada.

    Es el número que decide si un sistema es ejecutable: una esperanza positiva
    no sirve de nada si por el camino hay ocho pérdidas seguidas y lo abandonas
    en la sexta.
    """
    ordenadas = sorted(operaciones, key=lambda o: o["entrada_fecha"])
    peor = actual = 0
    for operacion in ordenadas:
        actual = 0 if operacion["ganadora"] else actual + 1
        peor = max(peor, actual)
    return peor


_AVISO_SUPERVIVENCIA = (
    "Sesgo de supervivencia: el universo son los miembros de HOY del índice. "
    "Las empresas que quebraron o fueron expulsadas no están, así que estos "
    "resultados están inflados en una cantidad que no se puede medir con "
    "fuentes gratuitas. Trátalos como un techo optimista, nunca como lo que "
    "cabe esperar."
)


def rebalance_dates_mensuales(start: date, end: date, step_months: int = 1) -> list[date]:
    """Fechas de entrada. Mensual por defecto: con trimestral salen tan pocas
    operaciones que el intervalo de confianza no dice nada."""
    fechas, actual = [], start
    while actual <= end:
        fechas.append(actual)
        mes = actual.month + step_months
        año = actual.year + (mes - 1) // 12
        mes = (mes - 1) % 12 + 1
        actual = date(año, mes, min(actual.day, 28))
    return fechas
