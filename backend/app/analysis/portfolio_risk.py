"""Análisis de CARTERA, no de acciones sueltas.

Ocho análisis buenos de ocho empresas no son un análisis de la cartera. La
diferencia no es de agregación: es que las preguntas cambian. «¿Es buena esta
empresa?» y «¿qué le pasa a mi dinero si el mercado se gira?» se contestan con
datos distintos, y la segunda no se deduce de ocho respuestas a la primera.

Cuatro cosas que solo se ven mirando el conjunto:

1. **Correlación entre posiciones.** Ocho tickers pueden ser una sola apuesta.
2. **Exposición agregada** por sector, geografía y características de factor.
3. **Concentración real**, que no es la del ticker más grande: es cuánta de la
   variación de la cartera la explica un solo movimiento común. Con un ETF
   dentro, además, tu exposición a una empresa es la directa MÁS la que llevas
   sin saberlo dentro del fondo.
4. **Qué le pasó a ESTA composición** en 2008, 2020 y 2022.

El límite honesto del punto 4, dicho una vez y en alto: aplicar los pesos de hoy
al pasado responde «cómo se habría comportado esta mezcla», no «cómo se habría
comportado tu cartera». La empresa de hoy tampoco es la de entonces — Apple en
2008 vendía iPods— y ninguna aritmética arregla eso. Sirve para ver de qué
tamaño es el riesgo, no para predecir la próxima caída.
"""

from __future__ import annotations

from datetime import date

import numpy as np

# Ventanas de crisis, pico a valle del S&P 500. Fechas fijas y públicas: no se
# eligen para que el resultado quede bonito, y por eso van escritas aquí y no
# calculadas sobre la propia cartera.
CRISIS = [
    {
        "clave": "2008",
        "nombre": "Crisis financiera de 2008",
        "desde": date(2007, 10, 9),
        "hasta": date(2009, 3, 9),
        "caida_sp500_pct": -56.8,
        "contexto": "Pico a valle del S&P 500. Diecisiete meses de caída sostenida.",
    },
    {
        "clave": "2020",
        "nombre": "Desplome de la COVID",
        "desde": date(2020, 2, 19),
        "hasta": date(2020, 3, 23),
        "caida_sp500_pct": -33.9,
        "contexto": "Treinta y tres días. La caída más rápida de la historia moderna.",
    },
    {
        "clave": "2022",
        "nombre": "Mercado bajista de 2022",
        "desde": date(2022, 1, 3),
        "hasta": date(2022, 10, 12),
        "caida_sp500_pct": -25.4,
        "contexto": "Subidas de tipos. Cayeron a la vez bonos y bolsa, que es lo raro.",
    },
]

# Por debajo de esta cobertura, el número agregado deja de describir la cartera.
COBERTURA_MINIMA = 0.50
MIN_OBSERVACIONES = 40  # para una correlación diaria que signifique algo

# Sesiones que se usan para correlacionar. Dos años: suficiente para que la
# correlación signifique algo y poco para que siga describiendo la cartera de
# ahora. La correlación media de 2007-2024 no es la correlación de tu cartera:
# es un promedio de regímenes que ya no existen.
VENTANA_CORRELACION = 504


# --- Correlación entre posiciones ---------------------------------------------


def ventana_reciente(
    series: dict[str, list[tuple[date, float]]], sesiones: int = VENTANA_CORRELACION
) -> dict[str, list[tuple[date, float]]]:
    """Se queda con las últimas N sesiones de cada serie.

    El estrés quiere TODO el histórico —2008 está en 2008— pero la correlación
    quiere el reciente. Son preguntas distintas sobre los mismos precios y
    mezclarlas da una correlación media de regímenes que ya no existen.
    """
    return {s: sorted(p)[-sesiones:] for s, p in series.items() if p}


def volatilidad_anualizada(
    puntos: list[tuple[date, float]], sesiones: int = 252
) -> float | None:
    """Volatilidad anualizada en %, del último año de cierres.

    Se calcula aquí y no se pide a ninguna API porque el histórico ya está
    descargado para el estrés: gastar una llamada por posición para un número
    que sale de datos que ya tenemos sería pagar dos veces por lo mismo.
    """
    cierres = [v for _, v in sorted(puntos)[-(sesiones + 1) :]]
    retornos = [
        cierres[i] / cierres[i - 1] - 1 for i in range(1, len(cierres)) if cierres[i - 1]
    ]
    if len(retornos) < 60:
        return None
    media = sum(retornos) / len(retornos)
    varianza = sum((r - media) ** 2 for r in retornos) / (len(retornos) - 1)
    return (varianza**0.5) * (252**0.5) * 100


def _alinear(
    series: dict[str, list[tuple[date, float]]],
) -> tuple[list[str], np.ndarray, list[date]]:
    """Retornos diarios en las fechas COMUNES a todas las posiciones.

    Alinear es obligatorio: correlacionar dos series con fechas distintas mide el
    calendario, no las empresas. El precio se convierte a retorno porque dos
    precios que suben correlacionan siempre — lo que interesa es si se mueven
    juntos día a día.
    """
    if len(series) < 2:
        return [], np.empty((0, 0)), []
    comunes: set[date] | None = None
    for puntos in series.values():
        fechas = {d for d, _ in puntos}
        comunes = fechas if comunes is None else (comunes & fechas)
    if not comunes or len(comunes) < MIN_OBSERVACIONES + 1:
        return [], np.empty((0, 0)), []

    orden = sorted(comunes)
    simbolos = sorted(series)
    filas = []
    for s in simbolos:
        precios = dict(series[s])
        valores = [precios[d] for d in orden]
        filas.append(
            [
                valores[i] / valores[i - 1] - 1 if valores[i - 1] else 0.0
                for i in range(1, len(valores))
            ]
        )
    return simbolos, np.array(filas), orden


def matriz_correlacion(series: dict[str, list[tuple[date, float]]]) -> dict:
    """Correlación de todos contra todos, sobre fechas comunes."""
    if len(series) < 2:
        return {
            "disponible": False,
            "nota": "Con una sola posición no hay nada que correlacionar.",
        }
    simbolos, retornos, fechas = _alinear(series)
    if len(simbolos) < 2:
        return {
            "disponible": False,
            "nota": (
                f"Las posiciones no comparten al menos {MIN_OBSERVACIONES + 1} "
                "sesiones de histórico. Correlacionar series con fechas distintas "
                "mide el calendario, no las empresas, así que no se calcula."
            ),
        }
    # Una serie plana (sin varianza) rompe la correlación: se descarta antes.
    vivas = [i for i in range(len(simbolos)) if retornos[i].std() > 0]
    if len(vivas) < 2:
        return {"disponible": False, "nota": "Las series no tienen variación que correlacionar."}
    descartadas = [simbolos[i] for i in range(len(simbolos)) if i not in vivas]
    simbolos = [simbolos[i] for i in vivas]
    corr = np.corrcoef(retornos[vivas])

    parejas = [
        {"a": simbolos[i], "b": simbolos[j], "corr": round(float(corr[i, j]), 3)}
        for i in range(len(simbolos))
        for j in range(i + 1, len(simbolos))
    ]
    parejas.sort(key=lambda p: -p["corr"])
    n_obs = retornos.shape[1]

    # La ventana la fija la posición con menos histórico: si una se compró el año
    # pasado, TODAS se correlacionan sobre ese año. Hay que decir cuál manda,
    # porque el usuario cree estar viendo la correlación de siempre.
    #
    # Solo se señala a una posición si de verdad es más corta que las demás.
    # Cuando todas empatan, la ventana la fija el recorte que se pide desde
    # fuera, y nombrar a una cualquiera acusaría a una posición inocente de
    # estar recortando algo que no recorta.
    longitudes = {s: len(p) for s, p in series.items()}
    mas_corta = min(longitudes, key=lambda s: longitudes[s])
    limita = mas_corta if longitudes[mas_corta] < max(longitudes.values()) else None
    return {
        "disponible": True,
        "simbolos": simbolos,
        "matriz": [[round(float(v), 3) for v in fila] for fila in corr],
        "parejas": parejas,
        "observaciones": n_obs,
        "desde": fechas[0].isoformat(),
        "hasta": fechas[-1].isoformat(),
        "limita_la_ventana": limita,
        "descartadas": descartadas,
        "media": round(float(np.mean([p["corr"] for p in parejas])), 3) if parejas else None,
        "nota": (
            f"Retornos diarios de {fechas[0].isoformat()} a {fechas[-1].isoformat()} "
            f"({n_obs} sesiones comunes a todas). Se mide sobre retornos y no sobre "
            "precios: dos precios que suben correlacionan siempre, y eso no dice nada. "
            + (
                f"La ventana la limita «{limita}», la posición con menos histórico: "
                "todas se correlacionan sobre el tramo que ella cubre."
                if limita
                else "Todas las posiciones cubren la ventana entera."
            )
            + (
                f" Se descartan {', '.join(descartadas)}: su precio no varía en esta "
                "ventana."
                if descartadas
                else ""
            )
        ),
    }


# --- Concentración real -------------------------------------------------------


def numero_efectivo_de_apuestas(corr: list[list[float]]) -> dict:
    """Cuántas apuestas INDEPENDIENTES hay de verdad detrás de N tickers.

    La concentración que se suele mirar —el peso del ticker más grande— no ve el
    problema de fondo: diez posiciones distintas que se mueven juntas son una
    sola apuesta repartida en diez recibos.

    Se descompone la matriz de correlación en sus componentes principales. La
    primera componente es el movimiento común —el «mercado» de esa cartera— y su
    peso en la varianza total dice cuánto del riesgo viene de una sola cosa. El
    número efectivo de apuestas es el inverso del índice de concentración de esos
    autovalores: con diez posiciones idénticas da 1, con diez independientes da
    10, y con una cartera real suele dar bastante menos de lo que uno espera.
    """
    matriz = np.array(corr, dtype=float)
    n = matriz.shape[0]
    if n < 2:
        return {"disponible": False, "nota": "Hacen falta al menos dos posiciones."}

    autovalores = np.linalg.eigvalsh(matriz)
    # Los autovalores de una matriz de correlación son >= 0; los negativos que
    # salen son ruido numérico y se recortan antes de normalizar.
    autovalores = np.clip(autovalores, 0, None)[::-1]
    total = autovalores.sum()
    if total <= 0:
        return {"disponible": False, "nota": "La matriz no tiene varianza que repartir."}

    pesos = autovalores / total
    efectivo = 1.0 / float((pesos**2).sum())
    primera = float(pesos[0])

    return {
        "disponible": True,
        "posiciones": n,
        "apuestas_efectivas": round(efectivo, 2),
        "primera_componente_pct": round(primera * 100, 1),
        "autovalores_pct": [round(float(p) * 100, 1) for p in pesos[: min(n, 5)]],
        "nota": (
            f"Tienes {n} posiciones pero se comportan como "
            f"{efectivo:.1f} apuestas independientes: el "
            f"{primera * 100:.0f} % de la variación de la cartera la explica un "
            "solo movimiento común. "
            + (
                "Diversificar más dentro de ese movimiento no reduce el riesgo, "
                "solo reparte el mismo riesgo en más recibos."
                if efectivo < n * 0.5
                else "El reparto entre apuestas distintas es razonable."
            )
        ),
    }


def look_through_etf(posiciones: list[dict], holdings: dict[str, list[dict]]) -> dict:
    """Tu exposición REAL a cada empresa: la directa más la que llevas dentro.

    Si tienes AAPL y también un ETF del S&P 500, tu exposición a Apple no es la
    de tu posición en AAPL: es esa más el 7 % de Apple que lleva dentro el fondo.
    Es la forma más común de estar más concentrado de lo que uno cree, y no se ve
    en ninguna tabla de posiciones.

    Límite que hay que decir: la fuente gratuita solo da los ~10 mayores holdings
    de cada ETF, así que esto ve la punta del iceberg. Lo que encuentre es real;
    lo que no salga puede existir igualmente.
    """
    directa = {p["symbol"]: p["peso_pct"] for p in posiciones}
    indirecta: dict[str, dict] = {}
    cobertura: dict[str, float] = {}
    etfs_vistos, etfs_sin_datos = [], []

    for p in posiciones:
        lista = holdings.get(p["symbol"])
        if not lista:
            if p.get("es_etf"):
                etfs_sin_datos.append(p["symbol"])
            continue
        etfs_vistos.append(p["symbol"])
        cubierto = 0.0
        for h in lista:
            peso = h.get("weight")
            sub = (h.get("symbol") or "").upper()
            if not peso or not sub:
                continue
            cubierto += peso
            entrada = indirecta.setdefault(sub, {"pct": 0.0, "via": []})
            entrada["pct"] += p["peso_pct"] * peso
            entrada["via"].append(
                {"etf": p["symbol"], "peso_en_etf_pct": round(peso * 100, 2)}
            )
        # Cuánto del fondo ven estos ~10 holdings. Un 30 % de cobertura y un 95 %
        # dicen cosas muy distintas sobre lo que este cálculo se está perdiendo.
        cobertura[p["symbol"]] = round(cubierto * 100, 1)

    combinada = []
    for sym in sorted(set(directa) | set(indirecta)):
        d = directa.get(sym, 0.0)
        i = indirecta.get(sym, {}).get("pct", 0.0)
        if d + i <= 0:
            continue
        combinada.append(
            {
                "symbol": sym,
                "directa_pct": round(d, 2),
                "indirecta_pct": round(i, 2),
                "total_pct": round(d + i, 2),
                "via": indirecta.get(sym, {}).get("via", []),
            }
        )
    combinada.sort(key=lambda x: -x["total_pct"])

    ocultas = [c for c in combinada if c["indirecta_pct"] > 0 and c["directa_pct"] > 0]
    return {
        "disponible": bool(etfs_vistos),
        "exposicion": combinada,
        "etfs_analizados": etfs_vistos,
        "etfs_sin_composicion": etfs_sin_datos,
        "cobertura_por_etf_pct": cobertura,
        "duplicadas": [c["symbol"] for c in ocultas],
        "nota": (
            (
                f"{len(ocultas)} empresa(s) las tienes por dos vías a la vez "
                f"({', '.join(c['symbol'] for c in ocultas[:5])}): posición directa "
                "más lo que llevas dentro de un ETF. Es la forma más común de estar "
                "más concentrado de lo que uno cree."
                if ocultas
                else "Ninguna posición directa se solapa con lo que llevas dentro de "
                "los ETFs analizados."
            )
            + " La fuente gratuita solo da los ~10 mayores holdings de cada fondo, "
            "así que esto ve la punta: lo que encuentra es real, lo que no sale "
            "puede existir igual."
            if etfs_vistos
            else "No hay ETFs en la cartera, o no se pudo leer su composición."
        ),
    }


# --- Exposición agregada ------------------------------------------------------


def exposicion(posiciones: list[dict], clave: str, etiqueta_vacia: str) -> dict:
    """Peso agregado por una dimensión (sector, país…), con lo desconocido aparte.

    Lo que no tiene dato va a su propio cubo y se cuenta. Repartirlo entre los
    demás o esconderlo daría una foto más limpia y menos cierta: si un tercio de
    la cartera no tiene país conocido, esa es la información.
    """
    cubos: dict[str, float] = {}
    for p in posiciones:
        cubos[p.get(clave) or etiqueta_vacia] = cubos.get(
            p.get(clave) or etiqueta_vacia, 0.0
        ) + p["peso_pct"]

    filas = sorted(
        ({"etiqueta": k, "peso_pct": round(v, 2)} for k, v in cubos.items()),
        key=lambda x: -x["peso_pct"],
    )
    desconocido = next((f["peso_pct"] for f in filas if f["etiqueta"] == etiqueta_vacia), 0.0)
    mayor = filas[0] if filas else None
    return {
        "filas": filas,
        "desconocido_pct": desconocido,
        "concentracion_mayor_pct": mayor["peso_pct"] if mayor else None,
        "nota": (
            (
                f"«{mayor['etiqueta']}» concentra el {mayor['peso_pct']:.0f} % de la "
                "cartera."
                if mayor and mayor["etiqueta"] != etiqueta_vacia
                else ""
            )
            + (
                f" Un {desconocido:.0f} % no tiene este dato y se cuenta aparte: "
                "repartirlo entre los demás daría una foto más limpia y menos cierta."
                if desconocido > 0
                else ""
            )
        ).strip(),
    }


def caracteristicas_ponderadas(posiciones: list[dict], referencia: dict | None = None) -> dict:
    """Las características medias de la cartera, ponderadas por peso.

    Esto NO es una exposición a factores en el sentido académico —para eso hace
    falta una regresión contra series de factores que las fuentes gratuitas no
    dan— y llamarlo así sería vestir de rigor una media ponderada. Es lo que es:
    cómo se ve tu cartera en las dimensiones que mueven los factores.

    Con una referencia (la empresa típica del universo escaneado) sí se puede
    decir hacia dónde te inclinas, que es la pregunta útil. Sin ella se dice que
    falta.
    """
    campos = {
        "pe_ttm": ("P/E medio", "value", False),
        "roe": ("ROE medio", "quality", True),
        "revenue_growth_5y": ("Crecimiento de ingresos", "growth", True),
        "vol_anual_pct": ("Volatilidad anualizada", "low_volatility", False),
        "market_cap": ("Capitalización media", "size", True),
    }
    salida = []
    for campo, (etiqueta, familia, alto_es_mas) in campos.items():
        con_dato = [p for p in posiciones if p.get(campo) is not None]
        peso = sum(p["peso_pct"] for p in con_dato)
        if peso <= 0:
            salida.append(
                {
                    "campo": campo,
                    "etiqueta": etiqueta,
                    "familia": familia,
                    "valor": None,
                    "cobertura_pct": 0.0,
                    "motivo": "Ninguna posición tiene este dato.",
                }
            )
            continue
        valor = sum(p[campo] * p["peso_pct"] for p in con_dato) / peso
        fila = {
            "campo": campo,
            "etiqueta": etiqueta,
            "familia": familia,
            "valor": round(valor, 4),
            "cobertura_pct": round(peso, 1),
        }
        ref = (referencia or {}).get(campo)
        if ref:
            fila["referencia"] = round(ref, 4)
            fila["desvio_pct"] = round((valor / ref - 1) * 100, 1) if ref else None
            inclina = valor > ref if alto_es_mas else valor < ref
            fila["inclinacion"] = "hacia" if inclina else "en contra"
        salida.append(fila)

    return {
        "caracteristicas": salida,
        "con_referencia": bool(referencia),
        "nota": (
            "A la izquierda, dónde está TU DINERO: media ponderada por peso. A la "
            "derecha, la empresa TÍPICA del universo escaneado: mediana, porque un "
            "P/E de 900 de una empresa que casi no gana dinero arrastra cualquier "
            "media. Son dos estadísticos distintos a propósito, y la comparación "
            "que interesa es justo esa. Es una inclinación descriptiva, no una "
            "exposición a factores estimada por regresión: para eso harían falta "
            "series de factores que las fuentes gratuitas no dan."
            if referencia
            else "Medias ponderadas de la cartera. SIN referencia con la que "
            "compararlas no dicen si estás inclinado hacia algo: ejecuta el barrido "
            "de mercado en «Hoy» y la comparación aparece sola."
        ),
    }


# --- Estrés en crisis reales ---------------------------------------------------


def _tramo(puntos: list[tuple[date, float]], desde: date, hasta: date) -> list[tuple[date, float]]:
    return [(d, v) for d, v in puntos if desde <= d <= hasta]


def estres_en_crisis(
    posiciones: list[dict],
    series: dict[str, list[tuple[date, float]]],
    crisis: list[dict] | None = None,
) -> dict:
    """Qué le habría pasado a ESTA mezcla en cada crisis, con su cobertura.

    La honestidad de esta función está en el denominador. Si de ocho posiciones
    solo tres existían en 2008, el resultado NO es «tu cartera en 2008»: es «las
    tres que existían, reponderadas». Se calcula igual —es informativo— pero se
    dice qué fracción del dinero cubre, y por debajo de la mitad se retira el
    titular en vez de dejar que un número parcial pase por completo.

    Se simula con mezcla constante, rebalanceando a los pesos de hoy, por la
    misma razón que en `sizing.peor_ventana`: comprar y no tocar deja que los
    pesos deriven y acaba midiendo otra cartera.
    """
    resultados = []
    for c in crisis or CRISIS:
        cubiertas, sin_datos = [], []
        for p in posiciones:
            tramo = _tramo(series.get(p["symbol"]) or [], c["desde"], c["hasta"])
            # Se exige cubrir el tramo casi entero: unas pocas sesiones sueltas
            # dentro de una caída de un año no describen esa caída.
            if len(tramo) >= 20:
                cubiertas.append((p, sorted(tramo)))
            else:
                sin_datos.append(p["symbol"])

        peso_cubierto = sum(p["peso_pct"] for p, _ in cubiertas)
        peso_total = sum(p["peso_pct"] for p in posiciones) or 1.0
        cobertura = peso_cubierto / peso_total

        if not cubiertas or cobertura <= 0:
            resultados.append(
                {
                    **_meta(c),
                    "medible": False,
                    "cobertura_pct": 0.0,
                    "sin_datos": sin_datos,
                    "nota": (
                        f"Ninguna posición tiene histórico de {c['clave']}. No es que "
                        "aguantara bien: es que no existía o no hay datos."
                    ),
                }
            )
            continue

        # Fechas comunes a las cubiertas, y mezcla constante sobre ellas.
        comunes = None
        for _, tramo in cubiertas:
            fechas = {d for d, _ in tramo}
            comunes = fechas if comunes is None else (comunes & fechas)
        orden = sorted(comunes or [])
        if len(orden) < 20:
            resultados.append(
                {
                    **_meta(c),
                    "medible": False,
                    "cobertura_pct": round(cobertura * 100, 1),
                    "sin_datos": sin_datos,
                    "nota": "Las posiciones cubiertas no comparten suficientes sesiones.",
                }
            )
            continue

        normal = {p["symbol"]: p["peso_pct"] / peso_cubierto for p, _ in cubiertas}
        precios = {p["symbol"]: dict(tramo) for p, tramo in cubiertas}
        valor, curva = 1.0, []
        for anterior, hoy in zip(orden, orden[1:]):
            r = 0.0
            for sym, w in normal.items():
                p0, p1 = precios[sym][anterior], precios[sym][hoy]
                if p0:
                    r += w * (p1 / p0 - 1)
            valor *= 1 + r
            curva.append(valor)

        pico, peor = 1.0, 0.0
        for v in curva:
            pico = max(pico, v)
            peor = min(peor, v / pico - 1)
        retorno = (curva[-1] - 1) if curva else 0.0

        resultados.append(
            {
                **_meta(c),
                "medible": True,
                "retorno_pct": round(retorno * 100, 1),
                "max_drawdown_pct": round(peor * 100, 1),
                "vs_sp500_pp": round(retorno * 100 - c["caida_sp500_pct"], 1),
                "cobertura_pct": round(cobertura * 100, 1),
                "posiciones_cubiertas": len(cubiertas),
                "posiciones_totales": len(posiciones),
                "sin_datos": sin_datos,
                "sesiones": len(orden),
                "titular_fiable": cobertura >= COBERTURA_MINIMA,
                "nota": _leer_cobertura(cobertura, sin_datos, c, retorno),
            }
        )

    medibles = [r for r in resultados if r.get("medible")]
    return {
        "crisis": resultados,
        "medibles": len(medibles),
        "aviso_general": (
            "Aplicar los pesos de HOY al pasado responde «cómo se habría "
            "comportado esta mezcla», no «cómo se habría comportado tu cartera»: "
            "en 2008 no la tenías. Y la empresa de hoy tampoco es la de entonces "
            "—Apple en 2008 vendía iPods—, así que ninguna aritmética arregla eso. "
            "Sirve para ver de qué tamaño es el riesgo, no para predecir la "
            "próxima caída."
        ),
    }


def _meta(c: dict) -> dict:
    return {
        "clave": c["clave"],
        "nombre": c["nombre"],
        "desde": c["desde"].isoformat(),
        "hasta": c["hasta"].isoformat(),
        "caida_sp500_pct": c["caida_sp500_pct"],
        "contexto": c["contexto"],
    }


def _leer_cobertura(cobertura: float, sin_datos: list[str], c: dict, retorno: float) -> str:
    if cobertura < COBERTURA_MINIMA:
        return (
            f"Solo el {cobertura * 100:.0f} % de la cartera tiene histórico de "
            f"{c['clave']} (faltan {', '.join(sin_datos[:5])}). El número de arriba "
            "describe esa parte reponderada, NO tu cartera: con menos de la mitad "
            "cubierta no se puede llamar de otra forma."
        )
    parte = (
        "Cubre la cartera entera."
        if not sin_datos
        else f"Cubre el {cobertura * 100:.0f} % de la cartera; faltan "
        f"{', '.join(sin_datos[:4])}."
    )
    pct = retorno * 100
    caida_indice = abs(c["caida_sp500_pct"])
    if abs(pct) < 1:
        comparacion = (
            f"Se habría quedado plana mientras el S&P 500 caía un {caida_indice:.0f} %."
        )
    elif pct > 0:
        comparacion = (
            f"Habría SUBIDO un {pct:.0f} % mientras el S&P 500 caía un "
            f"{caida_indice:.0f} %."
        )
    elif pct < c["caida_sp500_pct"]:
        comparacion = (
            f"Habría caído un {abs(pct):.0f} %, MÁS que el {caida_indice:.0f} % del "
            "S&P 500."
        )
    else:
        comparacion = (
            f"Habría caído un {abs(pct):.0f} %, menos que el {caida_indice:.0f} % del "
            "S&P 500."
        )
    return f"{parte} {comparacion}"
