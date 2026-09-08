"""Screener multifactor: seis exposiciones, normalizadas por sector.

El modelo que ya usa la lista diaria puntúa cuatro familias con pesos fijos.
Esto es otra cosa: **seis exposiciones estándar, con los pesos en tus manos**, y
—lo que de verdad falta en casi todos los screeners— el percentil de cada
métrica **frente a la propia historia de la empresa**, no solo frente a sus
comparables de hoy.

Esa segunda parte es la que cambia lecturas. Un corte transversal dice quién es
mejor *ahora mismo*: una empresa con ROE del 18 % puntúa bien contra su sector.
Lo que no dice es que ese mismo negocio venía del 30 % y lleva tres años
cayendo. El z-score la sigue premiando mientras se deteriora, porque compara
hacia los lados y no hacia atrás. Al revés pasa lo mismo: un margen en su máximo
de diez años puntúa como excelencia cuando puede ser un pico del ciclo a punto
de revertir. **El corte transversal dice quién va mejor; la serie temporal dice
si eso es normal en ellos.** Hacen falta las dos.

Las seis familias, y qué se sabe de verdad de cada una:

| Familia | Evidencia | Lo que hay que saber |
|---|---|---|
| **value** | Sólida y muy replicada | Se paga con rachas malas largas (2010-2020 fue brutal) |
| **quality** | Sólida | La más estable, y la que más se solapa con low-vol |
| **momentum** | Sólida | Se desploma en los giros de mercado (*momentum crashes*) |
| **growth** | **Débil como factor de retorno** | Crecer no es lo mismo que rendir: pagar por crecimiento pasado tiende a restar. Lo que sí funciona en la literatura es rentabilidad + inversión (RMW/CMA), no ventas pasadas |
| **low volatility** | Real pero discutida | Buena parte se explica por quality; y aquí se solapa con el dimensionador, que YA penaliza la volatilidad |
| **size** | **La más erosionada** | Casi desaparece tras ajustar por calidad, y en un universo de grandes cotizadas «pequeña» significa 30.000 millones: no es el factor académico |

No es una lista de seis apuestas independientes. Value y growth tiran en
direcciones opuestas por construcción; quality y low-vol suelen cargar sobre los
mismos nombres. Por eso el resultado incluye la **matriz de correlación entre
las familias**: poner los seis pesos al máximo no diversifica, concentra.

**Este screener no está validado contra histórico.** El backtest de reglas de la
app valida el compuesto de cuatro familias de la lista diaria, no este. Ordenar
por seis factores con pesos elegidos a mano es exactamente la clase de cosa que
produce resultados bonitos por azar, así que lo que sale de aquí es una
herramienta de exploración, no una señal probada. Ver `experiments.py`.
"""

from __future__ import annotations

import math

from app.analysis.factors import zscores
from app.analysis.valuation_history import percentile_rank

# --- Las seis familias -------------------------------------------------------

FAMILIAS: dict[str, list[str]] = {
    "value": ["earnings_yield", "book_yield", "fcf_yield"],
    "quality": ["roe", "roic", "operating_margin", "interest_coverage", "low_leverage"],
    "momentum": ["momentum_12_1"],
    "growth": ["revenue_cagr", "eps_cagr", "fcf_cagr"],
    "low_volatility": ["baja_volatilidad"],
    "size": ["small_cap"],
}

# Pesos por defecto. NO son un resultado medido en esta app: son un prior que
# refleja la fuerza de la evidencia publicada de cada factor, y están aquí para
# poder discutirlos y moverlos. Value, quality y momentum se llevan tres cuartas
# partes porque son los tres que sobreviven a la replicación con holgura.
PESOS_POR_DEFECTO = {
    "value": 0.25,
    "quality": 0.25,
    "momentum": 0.25,
    "growth": 0.10,
    "low_volatility": 0.10,
    "size": 0.05,
}

# Un sector con menos de esto no produce z-scores con sentido: puntuar una
# empresa contra dos comparables es ruido con formato de número.
MIN_POR_SECTOR = 5

# Menos observaciones anuales que esto no describen un rango histórico.
MIN_ANOS_HISTORICO = 5

# Para la correlación ENTRE familias basta con menos muestra que para dos series
# de retornos diarios: aquí cada observación es una empresa entera, no un día.
MIN_EMPRESAS_CORRELACION = 10


def _inverso(valor: float | None) -> float | None:
    """Múltiplo → rendimiento (P/E → E/P).

    Un múltiplo negativo o cero NO se convierte en rendimiento alto: una empresa
    en pérdidas no está «barata» por tener el P/E negativo.
    """
    if valor is None or valor <= 0:
        return None
    return 1.0 / valor


def factores_crudos(
    metrics: dict,
    *,
    momentum: float | None = None,
    vol_anual_pct: float | None = None,
    market_cap: float | None = None,
    crecimiento: dict | None = None,
) -> dict[str, float | None]:
    """Los factores de UNA empresa, ya orientados a «más alto = mejor».

    Un insumo ausente produce un factor None. Nunca se imputa: no saber el ROE
    de una empresa no es lo mismo que tener un ROE de cero, y rellenarlo con la
    media del sector inventaría una empresa promedio que no existe.
    """
    crecimiento = crecimiento or {}
    d_e = metrics.get("debt_to_equity")
    return {
        # Valor: rendimientos, no múltiplos, para que «más alto» sea «más barato».
        "earnings_yield": _inverso(metrics.get("pe_ttm")),
        "book_yield": _inverso(metrics.get("pb")),
        "fcf_yield": metrics.get("fcf_yield"),
        # Calidad.
        "roe": metrics.get("roe"),
        "roic": metrics.get("roic"),
        "operating_margin": metrics.get("operating_margin"),
        "interest_coverage": metrics.get("interest_coverage"),
        "low_leverage": -d_e if d_e is not None else None,
        # Momentum: llega ya calculado (12-1, saltándose el último mes).
        "momentum_12_1": momentum,
        # Crecimiento: CAGR reales de los estados financieros, no estimaciones.
        "revenue_cagr": crecimiento.get("revenue_cagr"),
        "eps_cagr": crecimiento.get("eps_cagr"),
        "fcf_cagr": crecimiento.get("fcf_cagr"),
        # Baja volatilidad: se invierte para que menos volatilidad puntúe más.
        "baja_volatilidad": -vol_anual_pct if vol_anual_pct is not None else None,
        # Tamaño: logaritmo, porque las capitalizaciones abarcan varios órdenes
        # de magnitud y un z-score sobre el valor crudo lo decidirían tres
        # gigantes. Negativo para que «pequeña» puntúe alto.
        "small_cap": (
            -math.log(market_cap) if market_cap and market_cap > 0 else None
        ),
    }


# --- Normalización por sector -------------------------------------------------


def zscores_por_sector(
    valores: dict[str, float | None], sectores: dict[str, str]
) -> tuple[dict[str, float | None], dict[str, int]]:
    """z-score DENTRO de cada sector, nunca contra el mercado entero.

    Comparar el P/E de un banco con el de una tecnológica castiga a la segunda
    por una diferencia estructural del negocio, no por estar cara: los bancos
    cotizan a múltiplos bajos *siempre*, y un corte absoluto llenaría la lista de
    bancos y utilities en cualquier mercado y cualquier año. Lo mismo con los
    márgenes al revés — el margen operativo de una distribuidora de alimentación
    jamás competirá con el de una empresa de software, y no por ser peor gestión.

    Devuelve además cuántas empresas tenía cada sector, para poder decir cuáles
    se quedaron sin puntuar en vez de que desaparezcan en silencio.
    """
    por_sector: dict[str, dict[str, float | None]] = {}
    for symbol, valor in valores.items():
        por_sector.setdefault(sectores.get(symbol) or "Sin sector", {})[symbol] = valor

    salida: dict[str, float | None] = {}
    tamanos: dict[str, int] = {}
    for sector, miembros in por_sector.items():
        tamanos[sector] = len(miembros)
        if len(miembros) < MIN_POR_SECTOR:
            salida.update({s: None for s in miembros})
            continue
        salida.update(zscores(miembros))
    return salida, tamanos


def puntuar_familias(
    factores_z: dict[str, dict[str, float | None]],
) -> dict[str, dict[str, float | None]]:
    """Promedia los z de cada familia. -> {familia: {símbolo: z}}.

    Una familia con todos sus factores ausentes queda en None; con algunos,
    promedia los que hay. Que falte un factor no descalifica a la empresa, pero
    sí baja su cobertura, y eso viaja en el resultado.
    """
    simbolos = {s for fila in factores_z.values() for s in fila}
    salida: dict[str, dict[str, float | None]] = {}
    for familia, factores in FAMILIAS.items():
        fila: dict[str, float | None] = {}
        for symbol in simbolos:
            presentes = [
                factores_z[f][symbol]
                for f in factores
                if f in factores_z and factores_z[f].get(symbol) is not None
            ]
            fila[symbol] = sum(presentes) / len(presentes) if presentes else None
        salida[familia] = fila
    return salida


# --- El compuesto, con los pesos que tú pongas --------------------------------


def normalizar_pesos(pesos: dict[str, float] | None) -> dict[str, float]:
    """Acepta pesos en cualquier escala y los deja sumando 1.

    Da igual que mandes {value: 2, quality: 1} o {value: 0.67, quality: 0.33}:
    lo que importa es la proporción. Los negativos se rechazan — apostar CONTRA
    un factor es una decisión distinta que merece su propia interfaz, no un
    signo menos escondido en un control deslizante.
    """
    pesos = {k: float(v) for k, v in (pesos or PESOS_POR_DEFECTO).items() if k in FAMILIAS}
    if any(v < 0 for v in pesos.values()):
        raise ValueError(
            "Los pesos negativos no se aceptan: apostar en contra de un factor "
            "es una estrategia distinta, no un peso al revés."
        )
    total = sum(pesos.values())
    if total <= 0:
        return dict(PESOS_POR_DEFECTO)
    return {k: v / total for k, v in pesos.items()}


def combinar(familias: dict[str, float | None], pesos: dict[str, float]) -> dict:
    """Compuesto ponderado de UNA empresa, renormalizado sobre lo disponible.

    `cobertura` dice qué fracción del peso que pediste se pudo medir de verdad.
    Un compuesto con cobertura 0,4 y otro con 1,0 no son comparables aunque
    salgan del mismo número, y ordenarlos juntos sin decirlo premia a las
    empresas de las que menos se sabe.
    """
    disponibles = {f: z for f, z in familias.items() if z is not None and pesos.get(f)}
    peso_disponible = sum(pesos[f] for f in disponibles)
    if not disponibles or peso_disponible == 0:
        return {"score": None, "cobertura": 0.0, "aportaciones": {}}
    return {
        "score": sum(pesos[f] * z for f, z in disponibles.items()) / peso_disponible,
        "cobertura": peso_disponible / sum(pesos.values()),
        # Atribución: de dónde sale la nota. Sin esto, una empresa que puntúa
        # 1,8 por momentum puro parece lo mismo que una que puntúa 1,8 con las
        # seis familias de acuerdo, y son ideas muy distintas.
        "aportaciones": {
            f: (pesos[f] * z) / peso_disponible for f, z in disponibles.items()
        },
    }


# --- Cuánto se solapan las familias entre sí ----------------------------------


def _pearson(a: list[float], b: list[float]) -> float | None:
    n = len(a)
    if n < MIN_EMPRESAS_CORRELACION:
        return None
    ma, mb = sum(a) / n, sum(b) / n
    va = sum((x - ma) ** 2 for x in a)
    vb = sum((y - mb) ** 2 for y in b)
    if va <= 0 or vb <= 0:
        return None
    return sum((x - ma) * (y - mb) for x, y in zip(a, b)) / math.sqrt(va * vb)


def correlacion_entre_familias(
    familias: dict[str, dict[str, float | None]],
) -> dict:
    """Cuánto se pisan las familias en ESTE universo.

    Seis controles deslizantes sugieren seis apuestas independientes y no lo
    son: value y growth tiran en direcciones opuestas casi por definición, y
    quality y low-vol suelen cargar sobre los mismos nombres. Subir los seis al
    máximo no diversifica — concentra en lo que las familias tengan en común, y
    eso no se ve en ningún sitio salvo aquí.

    Se mide sobre las puntuaciones de este universo concreto, no sobre una tabla
    de la literatura: en tu lista, hoy, es esto lo que se solapa.
    """
    nombres = sorted(familias)
    pares: dict[str, float] = {}
    for i, a in enumerate(nombres):
        for b in nombres[i + 1 :]:
            comunes = [
                (familias[a][s], familias[b][s])
                for s in familias[a]
                if familias[a].get(s) is not None and familias[b].get(s) is not None
            ]
            if len(comunes) < MIN_EMPRESAS_CORRELACION:
                continue
            c = _pearson([x for x, _ in comunes], [y for _, y in comunes])
            if c is not None:
                pares[f"{a}|{b}"] = round(c, 3)

    fuertes = [
        f"{k.replace('|', ' y ')}: {v:+.2f}"
        for k, v in sorted(pares.items(), key=lambda kv: -abs(kv[1]))
        if abs(v) >= 0.5
    ]
    return {
        "pares": pares,
        "solapamientos": fuertes,
        "nota": (
            "Correlación entre las puntuaciones de cada familia en este universo. "
            "Dos familias con |correlación| alta no son dos apuestas: subir sus "
            "dos pesos concentra en lo que tienen en común en vez de repartir."
            if pares
            else "Universo demasiado pequeño para medir el solapamiento entre familias."
        ),
    }


# --- El percentil histórico de cada métrica -----------------------------------
#
# La parte que casi ningún screener enseña, y la que cambia lecturas.

# Orientación de cada métrica: si un valor alto es bueno o malo. Sin esto el
# percentil se puede leer al revés — un percentil 90 de deuda no es un logro.
ORIENTACION = {
    "roe": "alto_mejor",
    "roic": "alto_mejor",
    "operating_margin": "alto_mejor",
    "net_margin": "alto_mejor",
    "gross_margin": "alto_mejor",
    "fcf_margin": "alto_mejor",
    "current_ratio": "alto_mejor",
    "interest_coverage": "alto_mejor",
    "asset_turnover": "alto_mejor",
    "debt_to_equity": "bajo_mejor",
    "pe": "bajo_mejor",
    "pb": "bajo_mejor",
    "fcf_yield": "alto_mejor",
}


def percentil_de_metrica(serie: list[float], actual: float | None, metrica: str) -> dict:
    """Dónde cae el valor de hoy dentro de la propia historia de la empresa.

    `percentil` es la posición cruda (0 = el más bajo que ha tenido nunca).
    `percentil_favorable` la traduce a «qué tan bueno es para esta métrica», que
    es lo que se puede colorear sin equivocarse: para la deuda, estar en el
    percentil 90 es la peor lectura posible, no la mejor.
    """
    valores = [v for v in serie if v is not None]
    if len(valores) < MIN_ANOS_HISTORICO or actual is None:
        return {
            "disponible": False,
            "n": len(valores),
            "actual": actual,
            "motivo": (
                f"Solo {len(valores)} observaciones (mínimo {MIN_ANOS_HISTORICO}): "
                "no hay rango histórico que interpretar."
                if actual is not None
                else "Sin valor actual con el que comparar."
            ),
        }
    ordenados = sorted(valores)
    n = len(ordenados)
    mediana = (
        ordenados[n // 2] if n % 2 else (ordenados[n // 2 - 1] + ordenados[n // 2]) / 2
    )
    pct = percentile_rank(valores, actual)
    alto_mejor = ORIENTACION.get(metrica, "alto_mejor") == "alto_mejor"
    return {
        "disponible": True,
        "n": n,
        "actual": actual,
        "percentil": round(pct, 3) if pct is not None else None,
        "percentil_favorable": (
            round(pct if alto_mejor else 1 - pct, 3) if pct is not None else None
        ),
        "orientacion": "alto_mejor" if alto_mejor else "bajo_mejor",
        "mediana": mediana,
        "min": ordenados[0],
        "max": ordenados[-1],
        "vs_mediana_pct": (
            (actual / mediana - 1) if mediana not in (None, 0) else None
        ),
        "lectura": _lectura(pct, alto_mejor, metrica),
    }


def _lectura(pct: float | None, alto_mejor: bool, metrica: str) -> str:
    if pct is None:
        return ""
    favorable = pct if alto_mejor else 1 - pct
    donde = "en su máximo histórico" if pct >= 0.9 else (
        "en su mínimo histórico" if pct <= 0.1 else f"en el percentil {pct * 100:.0f} de su historia"
    )
    if favorable >= 0.8:
        return (
            f"{metrica} {donde}. Un máximo puede ser excelencia o un pico de "
            "ciclo a punto de revertir: mira si el sector entero está igual."
        )
    if favorable <= 0.2:
        return (
            f"{metrica} {donde}. Puntúa bien contra sus comparables solo si "
            "ellas están peor todavía — el corte transversal no ve este deterioro."
        )
    return f"{metrica} {donde}, dentro de su rango normal."


def historia_de_la_empresa(
    serie_anual: list[dict], actuales: dict, metricas: list[str] | None = None
) -> dict:
    """Percentil histórico de cada métrica fundamental, desde los estados reales.

    `serie_anual` es lo que produce `fundamentals.derive_ratio_series()`: un
    registro por ejercicio, calculado desde lo que la empresa presentó a la SEC.
    El año en curso se compara contra sus propios ejercicios anteriores.

    Sale gratis: los estados financieros ya están descargados y cacheados para
    puntuar los factores. No cuesta ni una llamada más.
    """
    metricas = metricas or [
        "roe",
        "roic",
        "operating_margin",
        "net_margin",
        "fcf_margin",
        "debt_to_equity",
        "current_ratio",
        "interest_coverage",
        "asset_turnover",
    ]
    salida = {}
    for metrica in metricas:
        # El valor actual NO entra en la serie contra la que se compara: un dato
        # comparado consigo mismo se arrastra el percentil hacia el centro.
        serie = [r.get(metrica) for r in serie_anual[:-1] if r.get(metrica) is not None]
        actual = actuales.get(metrica)
        if actual is None and serie_anual:
            actual = serie_anual[-1].get(metrica)
        salida[metrica] = percentil_de_metrica(serie, actual, metrica)
    return salida


def resumen_historico(historia: dict) -> dict:
    """Lo que la serie temporal dice y el corte transversal no puede ver.

    Se queda con lo que merece un aviso: métricas en un extremo de su propio
    rango. Es el resumen que convierte una tabla de percentiles en algo que se
    lee en dos segundos.
    """
    medibles = [(m, d) for m, d in historia.items() if d.get("disponible")]
    if not medibles:
        return {
            "medidas": 0,
            "deteriorandose": [],
            "en_maximos": [],
            "nota": (
                "Sin histórico anual suficiente para situar ninguna métrica frente "
                "a la propia empresa."
            ),
        }
    # `if (pct or 1) <= 0.2` sería el idioma corto y estaría MAL: un percentil de
    # 0,0 —peor que todos sus años, la lectura más extrema que existe y la razón
    # de ser de este módulo— es falsy y se sustituiría por 1, con lo que el aviso
    # se perdería justo en el caso que lo justifica. El None se comprueba aparte.
    favorables = [
        (m, d["percentil_favorable"])
        for m, d in medibles
        if d.get("percentil_favorable") is not None
    ]
    deteriorando = sorted(m for m, p in favorables if p <= 0.2)
    maximos = sorted(m for m, p in favorables if p >= 0.8)
    # Los avisos viajan en piezas —lista de métricas por un lado, advertencia por
    # otro— para que quien los pinte pueda rotular cada métrica en su idioma. Una
    # frase ya montada obliga a la UI a enseñar «asset_turnover, fcf_margin»
    # junto a una tabla que las llama «Rotación de activos» y «Margen FCF»: los
    # mismos datos con dos nombres en la misma pantalla.
    avisos = []
    if deteriorando:
        avisos.append(
            {
                "tipo": "deterioro",
                "metricas": deteriorando,
                "advertencia": (
                    "En la peor parte de su propio rango. El z-score sectorial no lo "
                    "ve: puede seguir puntuando bien si sus comparables están "
                    "todavía peor."
                ),
            }
        )
    if maximos:
        avisos.append(
            {
                "tipo": "maximo",
                "metricas": maximos,
                "advertencia": (
                    "En la mejor parte de su propio rango. Comprueba si es una mejora "
                    "del negocio o un pico de ciclo antes de extrapolarlo."
                ),
            }
        )
    return {
        "medidas": len(medibles),
        "deteriorandose": deteriorando,
        "en_maximos": maximos,
        "avisos": avisos,
        # `nota` se conserva montada para quien consuma la API en crudo.
        "nota": " ".join(
            f"{', '.join(a['metricas'])}: {a['advertencia']}" for a in avisos
        )
        or "Todas las métricas medibles están dentro de su rango histórico normal.",
    }


# --- El screener completo -----------------------------------------------------


def rankear(
    empresas: list[dict], pesos: dict[str, float] | None = None
) -> dict:
    """Ordena el universo por el compuesto de seis factores.

    `empresas`: [{symbol, sector, metrics, momentum, vol_anual_pct, market_cap,
    crecimiento}]. Todo lo que hace falta ya lo descarga la app para la lista
    diaria: este screener **no cuesta ni una llamada adicional**.
    """
    pesos = normalizar_pesos(pesos)
    sectores = {e["symbol"]: e.get("sector") or "Sin sector" for e in empresas}

    crudos = {
        e["symbol"]: factores_crudos(
            e.get("metrics") or {},
            momentum=e.get("momentum"),
            vol_anual_pct=e.get("vol_anual_pct"),
            market_cap=e.get("market_cap"),
            crecimiento=e.get("crecimiento"),
        )
        for e in empresas
    }

    # El tamaño de cada sector no depende del factor, así que se cuenta una vez.
    tamanos: dict[str, int] = {}
    for sector in sectores.values():
        tamanos[sector] = tamanos.get(sector, 0) + 1

    nombres = {f for fila in crudos.values() for f in fila}
    factores_z: dict[str, dict[str, float | None]] = {
        factor: zscores_por_sector(
            {s: fila.get(factor) for s, fila in crudos.items()}, sectores
        )[0]
        for factor in nombres
    }

    familias = puntuar_familias(factores_z)

    filas = []
    for e in empresas:
        symbol = e["symbol"]
        compuesto = combinar(
            {f: familias[f].get(symbol) for f in familias}, pesos
        )
        filas.append(
            {
                "symbol": symbol,
                "sector": sectores[symbol],
                "score": compuesto["score"],
                "cobertura": round(compuesto["cobertura"], 3),
                # Seis decimales, no tres. El cliente reordena en vivo al mover
                # los pesos usando estos mismos z, así que redondearlos para la
                # pantalla hacía que dos empresas separadas por menos que el
                # redondeo salieran en un orden al mover el control y en otro al
                # pulsar «Recalcular» — sin nada que lo explicara. La precisión
                # es del dato; el redondeo, de quien lo pinta.
                "familias": {
                    f: (round(v, 6) if v is not None else None)
                    for f, v in ((f, familias[f].get(symbol)) for f in FAMILIAS)
                },
                "aportaciones": {
                    f: round(v, 3) for f, v in compuesto["aportaciones"].items()
                },
                "crudos": {
                    f: v for f, v in crudos[symbol].items() if v is not None
                },
            }
        )

    puntuadas = [f for f in filas if f["score"] is not None]
    puntuadas.sort(key=lambda f: f["score"], reverse=True)
    for i, fila in enumerate(puntuadas, start=1):
        fila["puesto"] = i

    sin_puntuar = [
        {"symbol": f["symbol"], "sector": f["sector"], "motivo": _motivo(f, tamanos)}
        for f in filas
        if f["score"] is None
    ]
    sectores_pequenos = sorted(
        s for s, n in tamanos.items() if n < MIN_POR_SECTOR
    )

    return {
        "ranking": puntuadas,
        "sin_puntuar": sin_puntuar,
        "pesos": {f: round(w, 4) for f, w in pesos.items()},
        "correlacion_familias": correlacion_entre_familias(familias),
        "sectores": tamanos,
        "sectores_sin_muestra": sectores_pequenos,
        "aviso_sectores": (
            f"Sectores con menos de {MIN_POR_SECTOR} empresas en este universo "
            f"({', '.join(sectores_pequenos)}): sus empresas no se puntúan. "
            "Puntuar contra dos comparables sería ruido con formato de número."
            if sectores_pequenos
            else None
        ),
        "nota": (
            "Cada factor se normaliza DENTRO de su sector, no contra el mercado: "
            "comparar el P/E de un banco con el de una tecnológica llenaría la "
            "lista de bancos y utilities en cualquier mercado y cualquier año. "
            "Los pesos son tuyos y los de partida son un prior sobre la evidencia "
            "publicada, no un resultado medido aquí."
        ),
        "advertencia": (
            "Este screener NO está validado contra histórico. El backtest de "
            "reglas de la app valida el compuesto de cuatro familias de la lista "
            "diaria, no este. Ordenar por seis factores con pesos elegidos a mano "
            "es justo la clase de cosa que produce resultados bonitos por azar: "
            "úsalo para explorar, no como señal probada."
        ),
    }


def _motivo(fila: dict, tamanos: dict[str, int]) -> str:
    if tamanos.get(fila["sector"], 0) < MIN_POR_SECTOR:
        return (
            f"Su sector ({fila['sector']}) tiene menos de {MIN_POR_SECTOR} "
            "empresas en este universo."
        )
    return "Sin ninguna familia con datos suficientes."
