"""Recomendación de ETFs. Otro activo, otros criterios.

El modelo de factores de las acciones **no se puede reutilizar aquí**, y usarlo
sería el error más fácil de cometer: un ETF no tiene P/E ni ROE propios, y los
que se le calculan son medias ponderadas de sus posiciones — comparar el "P/E"
de un ETF de tecnología con el de uno de utilities mide en qué invierte cada
uno, no cuál es mejor. Aplicar ahí un z-score de valor produciría un ranking con
aspecto riguroso y sin significado.

Lo que sí predice el resultado de un ETF, por orden de solidez de la evidencia:

1. **El coste.** Es el único factor con evidencia robusta y estable: de todo lo
   observable de antemano, el gasto corriente es el mejor predictor del
   rendimiento relativo futuro. Y a diferencia de la rentabilidad, es un dato
   conocido y garantizado — lo pagas seguro, gane o pierda el fondo.

2. **La tendencia.** El mismo filtro de la media de 200 sesiones que las
   acciones. Un precio es un precio.

3. **El tamaño.** Un ETF pequeño tiene horquillas más anchas y puede cerrarse:
   si liquidan el fondo, te devuelven el dinero cuando a ellos les conviene, y
   si estabas en pérdidas las realizas sin elegirlo.

Lo que este módulo NO hace: predecir qué sector lo hará mejor. Elegir entre un
ETF de salud y uno de energía es una apuesta sectorial, y esa decisión es tuya
— aquí solo se dice, dentro de lo que compares, cuál está mejor construido.
"""

from __future__ import annotations

# Umbrales. Están aquí, con nombre, para poder discutirlos.
COSTE_BARATO = 0.0020    # 0,20 % anual: por debajo, indexación estándar
COSTE_CARO = 0.0060      # 0,60 %: por encima hay que justificarlo muy bien
AUM_MINIMO = 100e6       # 100 M$: por debajo, riesgo real de cierre
AUM_COMODO = 1e9         # 1.000 M$: horquillas estrechas, sin dudas
SOLAPAMIENTO_ALTO = 0.60  # 60 % de cartera común: no son dos ideas, es una


def _nota_coste(expense_ratio: float | None) -> tuple[float, str]:
    """Puntúa el coste y lo explica en euros por cada 10.000 invertidos."""
    if expense_ratio is None:
        return 0.0, "Sin dato de coste, que ya es una señal: no lo esconden los baratos."
    anual = expense_ratio * 10_000
    if expense_ratio <= COSTE_BARATO:
        return 1.0, f"Coste {expense_ratio * 100:.2f} % — {anual:.0f} € al año por cada 10.000."
    if expense_ratio <= COSTE_CARO:
        return 0.4, (
            f"Coste {expense_ratio * 100:.2f} % — {anual:.0f} € al año por cada 10.000. "
            "Aceptable si cubre algo que no puedes obtener más barato."
        )
    return 0.0, (
        f"Coste {expense_ratio * 100:.2f} % — {anual:.0f} € al año por cada 10.000, "
        "los pagues gane o pierda. En 20 años eso se come una parte grande del interés compuesto."
    )


def _nota_tamano(aum: float | None) -> tuple[float, str]:
    if aum is None:
        return 0.3, "Sin dato de patrimonio."
    if aum >= AUM_COMODO:
        return 1.0, f"Patrimonio {aum / 1e9:.1f} B$ — líquido, sin riesgo de cierre."
    if aum >= AUM_MINIMO:
        return 0.5, f"Patrimonio {aum / 1e6:.0f} M$ — suficiente, pero no grande."
    return 0.0, (
        f"Patrimonio {aum / 1e6:.0f} M$ — por debajo de 100 M$ hay riesgo real de "
        "liquidación, y si cierran te devuelven el dinero cuando a ellos les conviene."
    )


def evaluar_etf(etf: dict, price: dict | None) -> dict:
    """Evalúa un ETF con sus propios criterios y explica cada parte."""
    coste_v, coste_txt = _nota_coste(etf.get("expense_ratio"))
    tam_v, tam_txt = _nota_tamano(etf.get("aum"))

    sobre_media = (price or {}).get("above_sma200")
    if sobre_media is True:
        tend_v, tend_txt = 1.0, "Cotiza sobre su media de 200 sesiones: la tendencia acompaña."
    elif sobre_media is False:
        tend_v, tend_txt = 0.0, "Cotiza bajo su media de 200 sesiones: tendencia en contra."
    else:
        tend_v, tend_txt = 0.5, "Sin histórico suficiente para juzgar la tendencia."

    # El coste pesa el doble que lo demás porque es lo único garantizado: la
    # tendencia puede girarse mañana, el gasto corriente lo pagas seguro.
    valor = round((coste_v * 2 + tend_v + tam_v) / 4, 3)

    if coste_v == 0.0 and etf.get("expense_ratio") is not None:
        accion = "evitar"
    elif tam_v == 0.0:
        accion = "evitar"
    elif valor >= 0.75 and sobre_media is True:
        accion = "comprar"
    elif valor >= 0.75:
        accion = "vigilar"
    else:
        accion = "ninguna"

    return {
        "symbol": etf.get("symbol"),
        "name": etf.get("name"),
        "valor": valor,
        "action": accion,
        "expense_ratio": etf.get("expense_ratio"),
        "aum": etf.get("aum"),
        "reasons": [coste_txt, tend_txt, tam_txt],
    }


def avisos_de_solapamiento(evaluados: list[dict], solapamientos: list[dict]) -> list[str]:
    """Dos ETFs que se solapan al 60 % no son dos ideas, son una repetida.

    Es el error más común y más caro al montar una cartera de ETFs: se compran
    tres fondos creyendo que se diversifica y los tres tienen dentro las mismas
    diez empresas, así que la cartera concentra justo lo que creía repartir.
    """
    elegidos = {e["symbol"] for e in evaluados if e["action"] in {"comprar", "vigilar"}}
    avisos = []
    for s in solapamientos:
        if s.get("overlap_weight", 0) < SOLAPAMIENTO_ALTO:
            continue
        if s.get("a") in elegidos and s.get("b") in elegidos:
            avisos.append(
                f"{s['a']} y {s['b']} comparten un {s['overlap_weight'] * 100:.0f} % "
                "de su cartera: comprar los dos no diversifica, concentra. Elige uno."
            )
    return avisos


def recomendar(
    etfs: list[dict], precios: dict[str, dict | None], solapamientos: list[dict]
) -> dict:
    """Ordena los ETFs comparados y avisa de lo que se repite entre ellos."""
    evaluados = [evaluar_etf(e, precios.get(e.get("symbol"))) for e in etfs]
    evaluados.sort(key=lambda e: e["valor"], reverse=True)
    recomendados = [e for e in evaluados if e["action"] == "comprar"]

    return {
        "evaluados": evaluados,
        "recomendados": [e["symbol"] for e in recomendados],
        "avisos": avisos_de_solapamiento(evaluados, solapamientos),
        "nota": (
            "El coste pesa el doble que la tendencia y el tamaño porque es lo "
            "único garantizado: lo pagas gane o pierda el fondo. Esto compara "
            "cómo están construidos los ETFs que le des — NO predice qué sector "
            "irá mejor. Elegir entre salud y energía es una apuesta sectorial y "
            "esa decisión es tuya."
        ),
    }
