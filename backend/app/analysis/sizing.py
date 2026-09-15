"""Cuánto comprar. Separado de qué comprar, porque son preguntas distintas.

`decision.py` analiza **una empresa**: si la tesis se sostiene, dónde está el
stop, qué la invalidaría. Todo eso se puede contestar mirándola sola.

El tamaño no. Cuánto poner en una idea depende de qué más tienes, de cuánto se
parecen entre sí tus posiciones y de cuánta volatilidad soporta la cartera
entera. La misma empresa, con la misma tesis y el mismo stop, merece un peso
distinto según el resto del libro — y una función que solo mira una empresa no
puede saberlo.

Tenerlas juntas producía un error concreto y silencioso: `decide()` devolvía
«peso sugerido 12,5 %» para cada idea por separado, así que aceptar ocho ideas
daba el 100 % de la cartera en ocho apuestas, varias del mismo sector, sin que
nada lo impidiera. Cada número era correcto; el conjunto, insostenible.

Cuatro límites, en orden de aplicación:

1. **Por posición.** Ninguna idea pasa de un tope, diga lo que diga la
   aritmética del riesgo. Un stop muy ceñido puede justificar un 25 % de la
   cartera en una sola empresa; el modelo puede estar equivocado sobre esa
   empresa, y entonces el tamaño no te salva el stop.
2. **Por sector.** Cinco tecnológicas no son cinco apuestas.
3. **Por correlación.** El sector es una aproximación; lo que de verdad importa
   es qué se mueve junto. Dos empresas de sectores distintos con correlación
   0,85 son una sola posición repartida.
4. **Volatility targeting.** Se escala el libro entero para que la volatilidad
   estimada de la cartera se acerque a un objetivo. Solo hacia ABAJO: escalar
   hacia arriba es apalancarse, y eso es una decisión que no toma un algoritmo.

Los cuatro cuentan **lo que ya tienes**, no solo lo que se propone comprar. Un
tope que ignora la cartera abierta no es un tope: con un 20 % en tecnología ya
en el libro, seguía autorizando otro 25 % del mismo sector y el resultado era un
45 % en una sola apuesta con el límite marcando verde.
"""

from __future__ import annotations

import math

# --- Límites. Todos aquí, con nombre, para poder discutirlos. ---

MAX_POR_POSICION_PCT = 10.0     # ninguna idea pasa de aquí, diga lo que diga el stop
MAX_POR_SECTOR_PCT = 25.0
MAX_POR_CLUSTER_PCT = 25.0      # lo que se mueve junto cuenta como uno
UMBRAL_CORRELACION = 0.70       # a partir de aquí, dos posiciones son una
OBJETIVO_VOL_ANUAL_PCT = 12.0   # volatilidad que se busca para la cartera
SESIONES_ANO = 252


# --- Correlación y agrupación ------------------------------------------------


def correlacion(a: list[float], b: list[float]) -> float | None:
    """Correlación de Pearson entre dos series de retornos."""
    n = min(len(a), len(b))
    if n < 20:
        return None
    a, b = a[-n:], b[-n:]
    ma, mb = sum(a) / n, sum(b) / n
    va = sum((x - ma) ** 2 for x in a)
    vb = sum((y - mb) ** 2 for y in b)
    if va <= 0 or vb <= 0:
        return None
    cov = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    return cov / math.sqrt(va * vb)


def matriz_correlacion(retornos: dict[str, list[float]]) -> dict[tuple[str, str], float]:
    simbolos = sorted(retornos)
    salida: dict[tuple[str, str], float] = {}
    for i, a in enumerate(simbolos):
        for b in simbolos[i + 1 :]:
            c = correlacion(retornos[a], retornos[b])
            if c is not None:
                salida[(a, b)] = round(c, 3)
    return salida


def agrupar_por_correlacion(
    simbolos: list[str],
    corr: dict[tuple[str, str], float],
    umbral: float = UMBRAL_CORRELACION,
) -> list[list[str]]:
    """Agrupa lo que se mueve junto. Componentes conexas por encima del umbral.

    Se usa enlace simple (basta con que UNA pareja supere el umbral) a
    propósito: para el riesgo, lo relevante es que exista un camino de
    correlación alta entre dos posiciones. Exigir que todas las parejas del
    grupo estén correlacionadas partiría clusters reales en trozos y daría una
    falsa sensación de diversificación.
    """
    padre = {s: s for s in simbolos}

    def raiz(x):
        while padre[x] != x:
            padre[x] = padre[padre[x]]
            x = padre[x]
        return x

    for (a, b), c in corr.items():
        if a in padre and b in padre and abs(c) >= umbral:
            ra, rb = raiz(a), raiz(b)
            if ra != rb:
                padre[ra] = rb

    grupos: dict[str, list[str]] = {}
    for s in simbolos:
        grupos.setdefault(raiz(s), []).append(s)
    return [sorted(g) for g in grupos.values()]


# --- Volatilidad de la cartera -----------------------------------------------


def volatilidad_cartera(
    pesos: dict[str, float],
    vol_anual: dict[str, float],
    corr: dict[tuple[str, str], float],
) -> float | None:
    """√(wᵀΣw) anualizada. **Pesos y volatilidades, ambos en FRACCIÓN.**

    El contrato de unidades es explícito y no se adivina: 0,10 para un 10 % de
    peso y 0,20 para un 20 % de volatilidad. Devuelve también fracción.

    Sumar volatilidades ponderadas sería el error clásico y siempre exagera:
    ignora que las posiciones no se mueven a la vez. Y usar correlación cero
    sería el error contrario, que subestima justo en las caídas —cuando todo
    se correlaciona— y es el más caro de los dos.
    """
    simbolos = [s for s in pesos if vol_anual.get(s)]
    if not simbolos:
        return None
    # UNIDADES EXPLÍCITAS. Antes se adivinaban por magnitud («si la volatilidad
    # pasa de 3, estará en porcentaje»), y eso fallaba justo con las carteras
    # tranquilas: dos activos al 2,5 % anual se tomaban por fracciones y daban
    # una volatilidad de cartera del 216 %, con lo que el targeting habría
    # recortado el libro a la nada. Un heurístico de unidades es un bug
    # esperando su caso; el contrato se declara y ya está.
    total = 0.0
    for i, a in enumerate(simbolos):
        for b in simbolos[i:]:
            wa, wb = pesos[a], pesos[b]
            va, vb = vol_anual[a], vol_anual[b]
            if a == b:
                total += (wa * va) ** 2
            else:
                c = corr.get((min(a, b), max(a, b)))
                # Sin correlación medida se asume 0,5: ni independencia (que
                # subestimaría) ni movimiento idéntico (que paralizaría la
                # cartera). Es un supuesto, y como tal se declara.
                c = 0.5 if c is None else c
                total += 2 * wa * wb * va * vb * c
    return math.sqrt(total) if total > 0 else None


# --- El dimensionador ---------------------------------------------------------


def dimensionar(
    candidatas: list[dict],
    *,
    retornos: dict[str, list[float]] | None = None,
    cartera: list[dict] | None = None,
    objetivo_vol_pct: float = OBJETIVO_VOL_ANUAL_PCT,
    max_posicion_pct: float = MAX_POR_POSICION_PCT,
    max_sector_pct: float = MAX_POR_SECTOR_PCT,
    max_cluster_pct: float = MAX_POR_CLUSTER_PCT,
) -> dict:
    """Convierte ideas en pesos de cartera, aplicando todos los límites.

    `candidatas`: [{symbol, sector, peso_bruto_pct, vol_anual_pct}]. El peso
    bruto es el que sale del riesgo por operación — el que `decision.py` calcula
    mirando solo esa empresa. Aquí se recorta.

    `cartera`: [{symbol, sector, peso_pct, vol_anual_pct}], las posiciones ya
    abiertas. **Ocupan presupuesto pero no se redimensionan**: qué hacer con lo
    que ya tienes es una decisión de mantener o soltar, y esa la toma
    `decision.py` mirando la tesis, no el dimensionador mirando el tamaño. Sin
    este argumento los topes solo veían las ideas nuevas, con lo que un libro
    con un 20 % en tecnología seguía autorizando otro 25 % del mismo sector: el
    tope existía en el código y no existía en la cartera.

    Los pesos devueltos son lo que se AÑADE, no el peso final de la posición.
    """
    cartera = cartera or []
    en_libro = {p["symbol"]: float(p.get("peso_pct") or 0.0) for p in cartera}
    sector_libro = {p["symbol"]: p.get("sector") or "Sin sector" for p in cartera}
    vol_libro = {
        p["symbol"]: float(p["vol_anual_pct"])
        for p in cartera
        if p.get("vol_anual_pct")
    }

    if not candidatas:
        return {
            "pesos": {},
            "recortes": [],
            "clusters": [],
            "nota": "Sin candidatas que dimensionar.",
        }

    pesos = {c["symbol"]: float(c.get("peso_bruto_pct") or 0.0) for c in candidatas}
    sectores = {c["symbol"]: c.get("sector") or "Sin sector" for c in candidatas}
    vols = {
        c["symbol"]: float(c["vol_anual_pct"])
        for c in candidatas
        if c.get("vol_anual_pct")
    }
    recortes: list[str] = []

    # 1) Tope por posición. Lo que ya tienes de ese mismo símbolo cuenta contra
    #    el mismo tope: reforzar una posición hasta el 10 % teniendo ya un 8 %
    #    la deja en el 18 %, y el tope diría que todo está en orden.
    for s, w in list(pesos.items()):
        tope = max(0.0, max_posicion_pct - en_libro.get(s, 0.0))
        if w > tope:
            if en_libro.get(s):
                recortes.append(
                    f"{s}: {w:.1f} % → {tope:.1f} % (tope por posición). Ya tienes "
                    f"un {en_libro[s]:.1f} % en {s}, y el tope de "
                    f"{max_posicion_pct:.0f} % cuenta lo que tienes más lo que añades."
                )
            else:
                recortes.append(
                    f"{s}: {w:.1f} % → {tope:.1f} % (tope por posición). "
                    "Un stop ceñido puede justificar aritméticamente mucho más, pero "
                    "el modelo puede estar equivocado sobre esa empresa y entonces el "
                    "tamaño no te salva el stop."
                )
            pesos[s] = tope

    # 2) Tope por sector, contando lo que el libro ya ocupa en cada uno.
    ocupado_sector: dict[str, float] = {}
    for s, w in en_libro.items():
        clave = sector_libro[s]
        ocupado_sector[clave] = ocupado_sector.get(clave, 0.0) + w

    pesos, r = _recortar_por_grupo(
        pesos,
        {s: [k for k, v in sectores.items() if v == s] for s in set(sectores.values())},
        max_sector_pct, "sector", ocupado=ocupado_sector,
    )
    recortes += r

    # 3) Tope por correlación. El sector es una aproximación; lo que importa es
    #    qué se mueve junto, y eso cruza sectores. Los clusters se calculan
    #    sobre candidatas Y posiciones abiertas: una idea nueva correlacionada
    #    con algo que ya tienes es la que más falta hace detectar, y mirando
    #    solo las candidatas entre sí era invisible.
    corr = matriz_correlacion(retornos or {})
    clusters = agrupar_por_correlacion(sorted(set(pesos) | set(en_libro)), corr)
    grupos: dict[str, list[str]] = {}
    ocupado_cluster: dict[str, float] = {}
    for g in clusters:
        if len(g) < 2:
            continue
        nombre = f"grupo {'+'.join(g[:3])}{'…' if len(g) > 3 else ''}"
        grupos[nombre] = g
        ya = sum(en_libro.get(s, 0.0) for s in g)
        if ya:
            ocupado_cluster[nombre] = ya
    pesos, r = _recortar_por_grupo(
        pesos, grupos, max_cluster_pct, "correlación", ocupado=ocupado_cluster
    )
    recortes += r

    # 4) Volatility targeting sobre el libro entero: el que tienes más el que
    #    propones. Las candidatas traen la volatilidad en PORCENTAJE; aquí se
    #    convierte, que es el único sitio donde se conoce la unidad de origen.
    vols_frac = {s: v / 100 for s, v in vols.items()}
    for s, v in vol_libro.items():
        vols_frac.setdefault(s, v / 100)

    def vol_con(escala: float) -> float | None:
        combinados = {s: w / 100 for s, w in en_libro.items()}
        for s, w in pesos.items():
            combinados[s] = combinados.get(s, 0.0) + (w * escala) / 100
        return volatilidad_cartera(combinados, vols_frac, corr)

    vol_solo_libro = vol_con(0.0) if en_libro else None
    vol_llena = vol_con(1.0)
    escala = 1.0
    if vol_llena and vol_llena * 100 > objetivo_vol_pct:
        if vol_solo_libro and vol_solo_libro * 100 >= objetivo_vol_pct:
            escala = 0.0
            recortes.append(
                f"Ideas nuevas al 0 %: la cartera que YA tienes estima un "
                f"{vol_solo_libro * 100:.1f} % de volatilidad, por encima del "
                f"objetivo ({objetivo_vol_pct} %). No es que las ideas sean malas "
                "— es que no cabe más riesgo. Bajar del objetivo pasa por soltar "
                "algo de lo que ya tienes, y eso no lo decide el dimensionador."
            )
        else:
            # Bisección en vez de despejar: con un libro ya abierto la
            # volatilidad combinada no es proporcional a la escala (hay términos
            # cruzados entre lo que tienes y lo que añades), así que la fórmula
            # cerrada «objetivo / vol» solo vale para la cartera vacía.
            bajo, alto = 0.0, 1.0
            for _ in range(40):
                medio = (bajo + alto) / 2
                v = vol_con(medio)
                if v and v * 100 > objetivo_vol_pct:
                    alto = medio
                else:
                    bajo = medio
            escala = bajo
            recortes.append(
                f"Ideas nuevas escaladas al {escala * 100:.0f} %: la volatilidad "
                f"estimada de la cartera combinada ({vol_llena * 100:.1f} %) "
                f"superaba el objetivo ({objetivo_vol_pct} %)."
            )
        pesos = {s: w * escala for s, w in pesos.items()}

    invertido = sum(pesos.values())
    ya_invertido = sum(en_libro.values())
    vol_final = vol_con(1.0)

    return {
        "pesos": {s: round(w, 2) for s, w in sorted(pesos.items(), key=lambda kv: -kv[1])},
        "invertido_pct": round(invertido, 2),
        "ya_invertido_pct": round(ya_invertido, 2),
        "invertido_total_pct": round(invertido + ya_invertido, 2),
        "liquidez_pct": round(max(0.0, 100 - invertido - ya_invertido), 2),
        "vol_estimada_pct": round(vol_final * 100, 2) if vol_final else None,
        "vol_cartera_actual_pct": (
            round(vol_solo_libro * 100, 2) if vol_solo_libro else None
        ),
        "objetivo_vol_pct": objetivo_vol_pct,
        "escala_aplicada": round(escala, 3),
        "clusters": [g for g in clusters if len(g) > 1],
        "cartera_actual": {
            s: round(w, 2) for s, w in sorted(en_libro.items(), key=lambda kv: -kv[1])
        },
        "recortes": recortes,
        "nota": (
            "El tamaño se decide sobre la cartera entera, no idea por idea: la "
            "misma empresa merece un peso distinto según qué más tengas. Los "
            "topes cuentan lo que YA tienes — con un 20 % en tecnología, una "
            "idea nueva del sector solo puede aspirar al 5 % que queda — y los "
            "pesos que salen aquí son lo que se AÑADE, no el peso final. La "
            "volatilidad solo se escala hacia ABAJO: escalar hacia arriba es "
            "apalancarse, y esa decisión no la toma un algoritmo. Dos supuestos "
            "que conviene tener presentes: si la correlación entre dos "
            "posiciones no se pudo medir se asume 0,5 —es un supuesto, no un "
            "dato—, y el peso de lo que ya tienes se mide sobre el valor de tus "
            "posiciones abiertas, porque la app no registra tu efectivo: si "
            "guardas liquidez fuera, tu concentración real es menor y los topes "
            "aprietan antes de lo debido."
        ),
    }


def _recortar_por_grupo(
    pesos: dict[str, float],
    grupos: dict[str, list[str]],
    tope: float,
    etiqueta: str,
    ocupado: dict[str, float] | None = None,
) -> tuple[dict[str, float], list[str]]:
    """Recorta proporcionalmente los grupos que superan su tope.

    `ocupado` es lo que las posiciones ya abiertas consumen de cada grupo. El
    tope se reparte entre lo que tienes y lo que añades, así que el margen para
    ideas nuevas es `tope − ocupado`, no `tope`.
    """
    salida = dict(pesos)
    avisos = []
    ocupado = ocupado or {}
    for nombre, miembros in grupos.items():
        presentes = [s for s in miembros if s in salida]
        nuevo = sum(salida[s] for s in presentes)
        if nuevo <= 0:
            continue
        ya = ocupado.get(nombre, 0.0)
        disponible = max(0.0, tope - ya)
        if nuevo <= disponible:
            continue
        factor = disponible / nuevo
        for s in presentes:
            salida[s] *= factor
        if ya and disponible <= 0:
            avisos.append(
                f"«{nombre}»: sin margen para ideas nuevas (tope por {etiqueta}). "
                f"Lo que ya tienes ({ya:.1f} %) agota el tope del {tope:.0f} %: "
                f"añadir aquí exige soltar antes. Afecta a {', '.join(presentes)}."
            )
        elif ya:
            avisos.append(
                f"«{nombre}»: {nuevo:.1f} % → {disponible:.1f} % (tope por "
                f"{etiqueta}). Ya tienes un {ya:.1f} % en el libro y el tope de "
                f"{tope:.0f} % cuenta lo que tienes más lo que añades. Afecta a "
                f"{', '.join(presentes)}."
            )
        else:
            avisos.append(
                f"«{nombre}»: {nuevo:.1f} % → {tope:.1f} % (tope por {etiqueta}). "
                f"Afecta a {', '.join(presentes)}, que se mueven juntas y por "
                "tanto cuentan como una sola apuesta."
            )
    return salida, avisos


# --- Estrés: qué le habría pasado a ESTA cartera ------------------------------
#
# Un retorno esperado sin su caída esperada al lado no es información, es
# publicidad. «+12 % anual» y «+12 % anual con un −45 % por el camino» son
# propuestas distintas, y la segunda la abandona mucha gente en el peor momento
# — con lo cual nunca cobra el +12 %.

VENTANA_ESTRES_MESES = 12


def peor_ventana(
    pesos: dict[str, float],
    series: dict[str, list[tuple]],
    meses: int = VENTANA_ESTRES_MESES,
) -> dict:
    """La peor racha que ESTA composición habría sufrido en el histórico.

    No es una simulación de escenarios inventados: se aplica la cartera actual
    a cada ventana del pasado disponible y se reporta la peor, con sus fechas.

    Se simula **con mezcla constante**, rebalanceando a los pesos que tienes en
    cada paso. Comprar y no tocar respondería a otra pregunta: los pesos derivan
    hacia lo que más subió y la caída sale más suave que la de tu cartera real.
    """
    if not pesos or not series:
        return {"suficiente": False, "nota": "Sin cartera o sin histórico."}

    # Serie de valor de la cartera con pesos fijos (rebalanceo implícito).
    fechas_comunes = None
    for s in pesos:
        if s not in series:
            continue
        f = {d for d, _ in series[s]}
        fechas_comunes = f if fechas_comunes is None else (fechas_comunes & f)
    if not fechas_comunes or len(fechas_comunes) < 60:
        return {"suficiente": False, "nota": "Histórico común insuficiente."}

    orden = sorted(fechas_comunes)
    precios = {s: dict(series[s]) for s in pesos if s in series}
    total_peso = sum(pesos[s] for s in precios) or 1.0
    normal = {s: pesos[s] / total_peso for s in precios}

    # Mezcla constante: los pesos se mantienen en los que TIENES, rebalanceando
    # en cada paso. Antes se acumulaba `Σ wᵢ·(Pᵢ(t)/Pᵢ(0))`, que es comprar y no
    # tocar, y con eso los pesos derivan solos: una cartera declarada 50/50
    # acababa simulada como 92/8 en favor de lo que más había subido, justo
    # porque había subido. El sesgo no tiene un signo fijo —lo que se desploma al
    # final llega sobreponderado y exagera la caída; lo que baja despacio se
    # diluye y la tapa— y por eso no se puede corregir leyendo el número con
    # cuidado: sencillamente contesta a otra pregunta que la que se hizo.
    valores = [(orden[0], 1.0)]
    for anterior, d in zip(orden, orden[1:]):
        retorno = 0.0
        for s, w in normal.items():
            p0, p1 = precios[s][anterior], precios[s][d]
            if p0:
                retorno += w * (p1 / p0 - 1)
        valores.append((d, valores[-1][1] * (1 + retorno)))

    # Peor caída pico-a-valle de todo el histórico.
    pico, peor, pico_f, valle_f = valores[0][1], 0.0, valores[0][0], valores[0][0]
    p_actual = valores[0][0]
    for d, v in valores:
        if v > pico:
            pico, p_actual = v, d
        caida = v / pico - 1 if pico else 0.0
        if caida < peor:
            peor, pico_f, valle_f = caida, p_actual, d

    # Peor ventana de `meses` consecutivos. Si no cabe ni una ventana entera no
    # se calcula: antes se recortaba al histórico disponible y se seguía
    # rotulando «12 meses», así que un −29 % de diez semanas viajaba con la
    # etiqueta de un año. Un número mal rotulado es peor que ninguno, porque se
    # compara con otros que sí significan lo que dicen.
    ventana = meses * 21
    peor_v, desde_v, hasta_v = None, None, None
    if len(valores) > ventana:
        paso = 21  # se desplaza la ventana mes a mes
        for i in range(0, len(valores) - ventana, paso):
            j = i + ventana
            ret = valores[j][1] / valores[i][1] - 1 if valores[i][1] else 0.0
            if peor_v is None or ret < peor_v:
                peor_v, desde_v, hasta_v = ret, valores[i][0], valores[j][0]

    cobertura_desde, cobertura_hasta = orden[0], orden[-1]
    años = (cobertura_hasta - cobertura_desde).days / 365.25
    return {
        "suficiente": True,
        "max_drawdown_pct": round(peor * 100, 2),
        "drawdown_desde": pico_f.isoformat(),
        "drawdown_hasta": valle_f.isoformat(),
        "peor_ventana_pct": round(peor_v * 100, 2) if peor_v is not None else None,
        "peor_ventana_meses": meses,
        "peor_ventana_desde": desde_v.isoformat() if desde_v else None,
        "peor_ventana_hasta": hasta_v.isoformat() if hasta_v else None,
        "peor_ventana_nota": (
            None
            if peor_v is not None
            else (
                f"El histórico común no llega a {meses} meses, así que no hay "
                "ninguna ventana entera que medir. Se deja vacío en vez de "
                "recortar el periodo y seguir rotulándolo igual."
            )
        ),
        "cobertura": f"{cobertura_desde.isoformat()} → {cobertura_hasta.isoformat()}",
        "años_cubiertos": round(años, 1),
        # La advertencia más importante del módulo, y la que más se olvida.
        "aviso_cobertura": _aviso_cobertura(cobertura_desde.year, años),
    }


_CRISIS = {
    2008: "la crisis financiera de 2008",
    2020: "el desplome de marzo de 2020",
    2022: "el mercado bajista de 2022",
}


def _aviso_cobertura(primer_año: int, años: float) -> str:
    """Lo que el histórico NO vio es tan importante como lo que vio.

    Un «peor caso» calculado sobre cinco años tranquilos no es el peor caso: es
    el peor de lo que dio tiempo a pasar. Nombrar las crisis que quedan fuera
    convierte un número tranquilizador en uno interpretable.
    """
    fuera = [texto for año, texto in sorted(_CRISIS.items()) if año < primer_año]
    if not fuera:
        return (
            f"El histórico cubre {años:.1f} años e incluye las grandes caídas "
            "recientes conocidas."
        )
    return (
        f"ATENCIÓN: el histórico solo cubre {años:.1f} años, desde {primer_año}. "
        f"Esta cartera NO ha vivido {', ni '.join(fuera)}. Su peor caída "
        "histórica es el peor de los escenarios que dio tiempo a ocurrir, que no "
        "es lo mismo que el peor escenario posible."
    )


def con_caida_esperada(proyeccion: dict, estres: dict) -> dict:
    """Empareja cualquier proyección de retorno con su caída esperada.

    Existe para que no se pueda enseñar lo uno sin lo otro. «+12 % anual» y
    «+12 % anual con un −45 % por el camino» son propuestas distintas, y quien
    solo ve la primera abandona en el peor momento — con lo cual nunca cobra
    ese +12 %.
    """
    salida = dict(proyeccion)
    if estres.get("suficiente"):
        salida["max_drawdown_esperado_pct"] = estres["max_drawdown_pct"]
        salida["peor_ventana_pct"] = estres["peor_ventana_pct"]
        salida["aviso_cobertura"] = estres["aviso_cobertura"]
    else:
        salida["max_drawdown_esperado_pct"] = None
        salida["aviso_cobertura"] = (
            "Sin histórico suficiente para estimar la caída máxima. Un retorno "
            "esperado sin su caída al lado no se puede interpretar."
        )
    return salida
