"""Valoración relativa ajustada por crecimiento y calidad.

Comparar el P/E de una empresa con la mediana de su sector es la valoración
relativa de toda la vida, y tiene un problema que la hace casi inútil: **las
empresas del mismo sector no merecen el mismo múltiplo**. Una que crece al 15 %
con un ROE del 30 % debe cotizar más cara que una que crece al 3 % con un ROE del
8 %, y decir «cotiza un 40 % por encima de la mediana del sector» sin ajustar por
eso no es un hallazgo: es no haber mirado.

Aquí el múltiplo se explica con los pares mediante una regresión sobre dos
variables —crecimiento y calidad—, **excluyendo a la empresa objetivo del
ajuste**, para que su múltiplo predicho sea una predicción fuera de muestra y no
un ejercicio de memorizar el dato que se quiere explicar.

**Y con seis pares esto no puede dar un número.** Dos regresores y siete
observaciones dejan cuatro grados de libertad: cualquier predicción puntual sería
una ficción estadística. Lo que se devuelve es el **intervalo de predicción**,
que es matemáticamente lo correcto y además ancho, que es lo honesto. Cuando el
ajuste no explica nada —R² bajo, o muy pocos pares— se dice y se cae a la
comparación cruda por cuartiles, declarando que no hay ajuste.

Lo que este módulo NO hace: decir si está cara o barata. Dice dónde cotiza
respecto a lo que sus comparables sugerirían para su crecimiento y su calidad,
con el intervalo que corresponde. Eso ya es bastante.
"""

from __future__ import annotations

import math

import numpy as np

# Menos de esto y una regresión de dos variables no tiene grados de libertad
# suficientes para nada. Es un límite duro, no una recomendación.
MIN_PARES = 5

# Por debajo de este R², la relación entre múltiplo, crecimiento y calidad en
# esta muestra no explica lo bastante como para ajustar por ella.
MIN_R2 = 0.30

# Índice de condición máximo. Por encima de 30 se considera colinealidad grave
# (regla de Belsley): los coeficientes dejan de ser interpretables por separado.
MAX_CONDICION = 30.0

# Valores críticos de la t de Student al 95 % bilateral, por grados de libertad.
# Va una tabla en vez de scipy: la app no arrastra una dependencia de 30 MB por
# doce números, y usar 1,96 con tres grados de libertad estrecharía el intervalo
# a la mitad de lo que debe ser — justo el error que este módulo existe para no
# cometer.
_T_95 = {
    1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365,
    8: 2.306, 9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145,
    15: 2.131, 16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093, 20: 2.086,
    25: 2.060, 30: 2.042,
}


def _t_critico(gl: int) -> float:
    if gl <= 0:
        return float("inf")
    if gl in _T_95:
        return _T_95[gl]
    disponibles = sorted(_T_95)
    if gl > disponibles[-1]:
        return 1.96
    # Se coge el grado de libertad menor de los tabulados: da un intervalo más
    # ancho, que es el lado prudente al que equivocarse.
    return _T_95[max(g for g in disponibles if g <= gl)]


def _cuartiles(valores: list[float]) -> dict:
    orden = sorted(valores)
    n = len(orden)
    def q(p: float) -> float:
        i = p * (n - 1)
        bajo, alto = math.floor(i), math.ceil(i)
        return orden[bajo] + (orden[alto] - orden[bajo]) * (i - bajo)
    return {"p25": q(0.25), "mediana": q(0.5), "p75": q(0.75), "min": orden[0], "max": orden[-1]}


def ajustar_por_crecimiento_y_calidad(
    pares: list[dict],
    objetivo: dict,
    *,
    etiqueta_multiplo: str = "P/E",
) -> dict:
    """Qué múltiplo sugieren los pares para el crecimiento y la calidad del objetivo.

    `pares` y `objetivo`: {symbol, multiplo, crecimiento, calidad}. El objetivo
    NO entra en el ajuste — su múltiplo predicho es una predicción fuera de
    muestra, no un residuo de sí mismo.

    Devuelve siempre el intervalo de predicción, nunca un múltiplo objetivo.
    """
    usables = [
        p
        for p in pares
        if p.get("symbol") != objetivo.get("symbol")
        and all(p.get(k) is not None for k in ("multiplo", "crecimiento", "calidad"))
        and p["multiplo"] > 0
    ]
    crudo = (
        _cuartiles([p["multiplo"] for p in usables]) if usables else None
    )

    faltan = [k for k in ("multiplo", "crecimiento", "calidad") if objetivo.get(k) is None]
    if faltan:
        return {
            "disponible": False,
            "pares_usables": len(usables),
            "crudo": crudo,
            "nota": (
                f"Del objetivo faltan {', '.join(faltan)}: no se puede situar en la "
                "relación de sus comparables."
            ),
        }
    if len(usables) < MIN_PARES:
        return {
            "disponible": False,
            "pares_usables": len(usables),
            "crudo": crudo,
            "nota": (
                f"Solo {len(usables)} pares con los tres datos (mínimo {MIN_PARES}). "
                "Una regresión de dos variables sobre esta muestra no tendría "
                "grados de libertad: se enseña la comparación cruda por cuartiles y "
                "se declara que NO está ajustada por crecimiento ni calidad."
            ),
        }

    X = np.column_stack(
        [
            np.ones(len(usables)),
            [p["crecimiento"] for p in usables],
            [p["calidad"] for p in usables],
        ]
    )
    y = np.array([p["multiplo"] for p in usables], dtype=float)
    n, k = X.shape
    gl = n - k

    # Colinealidad. En un conjunto de comparables real, crecimiento y calidad van
    # muy de la mano —las empresas buenas suelen crecer—, y entonces la regresión
    # no puede separar sus efectos: los coeficientes salen enormes, de signo
    # aleatorio y con una varianza que hace que dos muestras casi idénticas den
    # respuestas opuestas. `inv()` no falla en ese caso, devuelve basura, así que
    # comprobar solo la singularidad exacta no protege de nada.
    #
    # Se usa el índice de condición de Belsley sobre las columnas escaladas a
    # norma 1 (escalar es imprescindible: las columnas van de 1,0 a 0,05 y sin
    # normalizar el número de condición mide las unidades, no la colinealidad).
    escalada = X / np.linalg.norm(X, axis=0)
    condicion = float(np.linalg.cond(escalada))
    if condicion > MAX_CONDICION:
        return {
            "disponible": False,
            "pares_usables": n,
            "crudo": crudo,
            "indice_condicion": round(min(condicion, 1e6), 1),
            "nota": (
                f"Crecimiento y calidad se mueven casi juntos en estos pares "
                f"(índice de condición {min(condicion, 1e6):.0f}, umbral "
                f"{MAX_CONDICION:.0f}): la "
                "regresión no puede separar sus efectos y los coeficientes serían "
                "ruido con signo aleatorio. Se enseña la comparación cruda, sin "
                "ajustar. Que las empresas buenas crezcan más no es un fallo de los "
                "datos: es que en esta muestra las dos variables dicen lo mismo."
            ),
        }

    try:
        XtX_inv = np.linalg.inv(X.T @ X)
    except np.linalg.LinAlgError:
        return {
            "disponible": False,
            "pares_usables": n,
            "crudo": crudo,
            "nota": (
                "Los pares no aportan variación independiente en crecimiento y "
                "calidad (la matriz es singular): no hay relación que estimar."
            ),
        }

    beta = XtX_inv @ X.T @ y
    ajustados = X @ beta
    residuos = y - ajustados
    sse = float(residuos @ residuos)
    sst = float(((y - y.mean()) ** 2).sum())
    r2 = 1 - sse / sst if sst > 0 else None
    s = math.sqrt(sse / gl) if gl > 0 else None

    x0 = np.array([1.0, objetivo["crecimiento"], objetivo["calidad"]])
    predicho = float(x0 @ beta)

    if s is None or s == 0:
        intervalo = None
    else:
        # Intervalo de PREDICCIÓN (no de confianza de la media): incluye el
        # término 1 + ... porque lo que se predice es una empresa concreta, no
        # el promedio de las empresas con ese crecimiento y esa calidad.
        margen = _t_critico(gl) * s * math.sqrt(1 + float(x0 @ XtX_inv @ x0))
        intervalo = (predicho - margen, predicho + margen)

    dentro = (
        intervalo is not None
        and intervalo[0] <= objetivo["multiplo"] <= intervalo[1]
    )
    fiable = r2 is not None and r2 >= MIN_R2

    return {
        "disponible": True,
        "fiable": fiable,
        "etiqueta_multiplo": etiqueta_multiplo,
        "pares_usables": n,
        "grados_libertad": gl,
        "r2": round(r2, 3) if r2 is not None else None,
        "error_estandar": round(s, 3) if s else None,
        "coeficientes": {
            "constante": round(float(beta[0]), 3),
            "por_punto_de_crecimiento": round(float(beta[1]) / 100, 4),
            "por_punto_de_calidad": round(float(beta[2]) / 100, 4),
        },
        "multiplo_objetivo": round(objetivo["multiplo"], 2),
        "multiplo_sugerido": round(predicho, 2),
        "intervalo": (
            {"bajo": round(intervalo[0], 2), "alto": round(intervalo[1], 2)}
            if intervalo
            else None
        ),
        "dentro_del_intervalo": dentro,
        "crudo": crudo,
        "pares": [
            {
                "symbol": p["symbol"],
                "multiplo": round(p["multiplo"], 2),
                "crecimiento": p["crecimiento"],
                "calidad": p["calidad"],
                "residuo": round(float(r), 2),
            }
            for p, r in zip(usables, residuos)
        ],
        "nota": _leer(fiable, r2, n, gl, dentro, objetivo, predicho, intervalo, etiqueta_multiplo),
    }


def _leer(
    fiable: bool,
    r2: float | None,
    n: int,
    gl: int,
    dentro: bool,
    objetivo: dict,
    predicho: float,
    intervalo: tuple[float, float] | None,
    etiqueta: str,
) -> str:
    if not fiable:
        return (
            f"El crecimiento y la calidad explican poco del múltiplo en esta "
            f"muestra (R² = {r2:.2f} con {n} pares): el ajuste no sostiene una "
            "conclusión. Puede ser que estos pares no sean realmente comparables, "
            "o que en este sector el múltiplo lo mande otra cosa. Mira la "
            "comparación cruda y trátala como lo que es — cruda."
        )
    if intervalo is None:
        return f"Ajuste calculado con {n} pares, pero sin dispersión para un intervalo."

    base = (
        f"Con {n} pares y {gl} grados de libertad, la relación entre múltiplo, "
        f"crecimiento y calidad (R² = {r2:.2f}) sugiere un {etiqueta} de "
        f"{intervalo[0]:.1f}–{intervalo[1]:.1f} para el perfil del objetivo. "
        f"Cotiza a {objetivo['multiplo']:.1f}. "
    )
    if dentro:
        return base + (
            "Está DENTRO del intervalo: para su crecimiento y su calidad, cotiza "
            "donde cotizan sus comparables. El intervalo es ancho porque con esta "
            "muestra no puede ser estrecho, y estrecharlo sería inventarse "
            "precisión."
        )
    lado = "por encima" if objetivo["multiplo"] > intervalo[1] else "por debajo"
    return base + (
        f"Queda {lado} del intervalo. Eso NO significa que esté cara o barata: "
        "significa que su múltiplo no se explica por su crecimiento ni por su "
        "calidad frente a estos comparables, y merece buscar qué más lo explica."
    )


def rango_de_precio_implicito(
    multiplo_bajo: float,
    multiplo_alto: float,
    valor_por_accion: float | None,
    precio_actual: float | None,
) -> dict:
    """Traduce un intervalo de múltiplos a un intervalo de precio.

    `valor_por_accion` es el denominador del múltiplo (BPA para el P/E, valor
    contable por acción para el P/B). Sale un RANGO porque entra un rango: no
    hay ningún punto del cálculo donde aparezca un precio objetivo único.
    """
    if not valor_por_accion or valor_por_accion <= 0:
        return {
            "disponible": False,
            "nota": (
                "Sin un denominador positivo (BPA o valor contable por acción) el "
                "múltiplo no se traduce a precio."
            ),
        }
    bajo, alto = multiplo_bajo * valor_por_accion, multiplo_alto * valor_por_accion
    salida = {
        "disponible": True,
        "precio_bajo": round(bajo, 2),
        "precio_alto": round(alto, 2),
        "precio_actual": precio_actual,
    }
    if precio_actual:
        salida["posicion"] = (
            "dentro" if bajo <= precio_actual <= alto
            else "por encima" if precio_actual > alto
            else "por debajo"
        )
        salida["nota"] = (
            f"El intervalo de comparables da {bajo:.0f}–{alto:.0f}, y cotiza a "
            f"{precio_actual:.0f} ({salida['posicion']}). Es un intervalo, no un "
            "precio objetivo: los extremos valen tanto como cualquier punto de "
            "dentro."
        )
    return salida
