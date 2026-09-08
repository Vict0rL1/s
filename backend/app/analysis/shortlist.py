"""De 98 candidatas a 5 ideas: la lista corta.

Que 98 empresas superen el umbral no significa que haya 98 oportunidades.
Significa que el umbral responde a otra pregunta. Un umbral contesta *¿quién
califica?*; una recomendación contesta *¿cuáles pocas?*, y son cosas distintas:
la primera es un filtro, la segunda exige ordenar por convicción y elegir.

La convicción aquí no es la puntuación a secas. Se compone de tres cosas que un
analista mira antes de poner dinero:

1. **Cuánto supera el listón**, no si lo supera. Pasar de 0,36 y pasar de 1,20
   son situaciones distintas que un umbral binario aplasta.

2. **Si los factores están de acuerdo.** Una empresa buena en valor, calidad y
   momentum a la vez es una idea mucho más sólida que otra con la misma
   puntuación media sostenida por un solo factor mientras otro se hunde. Esa
   segunda es una apuesta a un factor, no a una empresa, y encima el promedio la
   disfraza.

3. **Cuánto hay que arriesgar para participar.** A igualdad de todo lo demás, la
   idea con el stop más ceñido permite una posición mayor con el mismo riesgo.

Y una regla que no es de puntuación sino de cartera: **como mucho dos por
sector**. Cinco tecnológicas no son cinco ideas, son una sola apuesta repartida
en cinco tickets — se hunden juntas. Diversificar aquí no es cosmética, es lo
que evita que la lista corta concentre todo el riesgo en un sitio.
"""

from __future__ import annotations

FACTORES_CLAVE = ("value", "quality", "momentum")

MAX_IDEAS = 5
MAX_POR_SECTOR = 2
MAX_EVITAR = 5

# Un factor por debajo de esto contradice a los demás lo bastante como para
# que la idea deje de ser "todo apunta igual".
FACTOR_EN_CONTRA = -0.5


def _familias(signal: dict) -> dict[str, float]:
    return {
        f: v
        for f, v in (signal.get("families") or {}).items()
        if f in FACTORES_CLAVE and v is not None
    }


def _acuerdo(familias: dict[str, float]) -> float:
    """Cuánto coinciden los factores, de 0 a 1.

    Mide dos cosas a la vez: cuántos están a favor y si alguno rema en contra.
    Con un solo factor disponible no hay acuerdo posible que valga: se penaliza,
    porque una idea sostenida por un dato no es una idea contrastada.
    """
    if len(familias) < 2:
        return 0.3
    a_favor = sum(1 for v in familias.values() if v > 0)
    proporcion = a_favor / len(familias)
    if any(v <= FACTOR_EN_CONTRA for v in familias.values()):
        proporcion *= 0.5
    return proporcion


def conviccion(signal: dict) -> dict:
    """Convicción de una idea y de dónde sale, para poder discutirla."""
    score = signal.get("score") or 0.0
    familias = _familias(signal)
    acuerdo = _acuerdo(familias)

    decision = signal.get("decision") or {}
    niveles = decision.get("levels") or {}
    stop_pct = niveles.get("stop_pct")
    # Stop ceñido = más posición con el mismo riesgo. Se normaliza sobre el
    # rango que el motor puede producir (8-25 %).
    eficiencia = 1.0 if not stop_pct else max(0.0, min(1.0, (25 - abs(stop_pct)) / 17))

    valor = score * (0.5 + 0.5 * acuerdo) + 0.15 * eficiencia
    return {
        "valor": round(valor, 4),
        "acuerdo": round(acuerdo, 2),
        "factores_a_favor": sorted(f for f, v in familias.items() if v > 0),
        "factores_en_contra": sorted(f for f, v in familias.items() if v <= 0),
        "eficiencia_riesgo": round(eficiencia, 2),
    }


def _sector(signal: dict) -> str:
    return (signal.get("context") or {}).get("sector_name") or "—"


def _elegir(candidatas: list[dict], maximo: int, max_sector: int) -> list[dict]:
    """Las mejores respetando el tope por sector.

    Se recorre en orden de convicción y se salta lo que ya está lleno. Si al
    final no se llegó al máximo, se completa relajando el tope: es preferible
    una quinta idea del mismo sector que una lista a medias.
    """
    elegidas: list[dict] = []
    por_sector: dict[str, int] = {}
    for señal in candidatas:
        sector = _sector(señal)
        if por_sector.get(sector, 0) >= max_sector:
            continue
        elegidas.append(señal)
        por_sector[sector] = por_sector.get(sector, 0) + 1
        if len(elegidas) >= maximo:
            return elegidas

    for señal in candidatas:
        if len(elegidas) >= maximo:
            break
        if señal not in elegidas:
            elegidas.append(señal)
    return elegidas


NOMBRES = {"value": "valor", "quality": "calidad", "momentum": "momentum"}


def _enumerar(items: list[str]) -> str:
    """«a, b y c» — no «a y b y c»."""
    if len(items) <= 1:
        return "".join(items)
    return f"{', '.join(items[:-1])} y {items[-1]}"


def _resumen_idea(señal: dict) -> str:
    """Por qué esta y no otra de las 98."""
    conv = señal["conviction"]
    favor = [NOMBRES[f] for f in conv["factores_a_favor"]]
    if len(favor) >= 3:
        base = "Los tres factores apuntan igual: valor, calidad y momentum"
    elif favor:
        base = f"Destaca en {_enumerar(favor)}"
    else:
        base = "Puntuación por encima del listón"

    contra = [NOMBRES[f] for f in conv["factores_en_contra"]]
    if contra:
        base += f", aunque flojea en {_enumerar(contra)}"
    return base + "."


def _resumen_evitar(señal: dict) -> str:
    """Por qué NO comprarla.

    No vale reutilizar el resumen de una idea: decir «destaca en valor» de algo
    que la app te está diciendo que evites invita justo a lo contrario de lo que
    la lista pretende. Aquí lo que manda es lo que va en contra.
    """
    conv = señal["conviction"]
    contra = [NOMBRES[f] for f in conv["factores_en_contra"]]
    favor = [NOMBRES[f] for f in conv["factores_a_favor"]]

    if len(contra) >= 3:
        base = "Queda por detrás de sus comparables en los tres factores"
    elif contra:
        base = f"Queda por detrás en {_enumerar(contra)}"
    else:
        base = "Puntuación por debajo del listón frente a sus comparables"

    if favor:
        # Nombrar lo que sí tiene es lo que distingue una trampa de valor de una
        # empresa simplemente mala, y son situaciones distintas.
        base += (
            f". Aguanta en {_enumerar(favor)}, pero no compensa: barato y en "
            "declive es la trampa de valor clásica"
        )
    return base + "."


def construir_lista_corta(
    signals: list[dict],
    max_ideas: int = MAX_IDEAS,
    max_por_sector: int = MAX_POR_SECTOR,
) -> dict:
    """Las pocas que comprar y las pocas que evitar, con su porqué.

    Solo entran las que ya pasaron TODAS las reglas del motor de decisión: esto
    ordena y recorta, no relaja nada. Una empresa que el motor no manda comprar
    no puede aparecer aquí por muy alta que puntúe.
    """
    comprar, evitar = [], []
    for señal in signals:
        accion = (señal.get("decision") or {}).get("action")
        if accion == "comprar":
            comprar.append({**señal, "conviction": conviccion(señal)})
        elif accion == "evitar":
            evitar.append({**señal, "conviction": conviccion(señal)})

    comprar.sort(key=lambda s: s["conviction"]["valor"], reverse=True)
    # Las peores primero: aquí el valor más negativo es el más informativo.
    evitar.sort(key=lambda s: s["conviction"]["valor"])

    ideas = _elegir(comprar, max_ideas, max_por_sector)
    for i, señal in enumerate(ideas, start=1):
        señal["conviction"]["puesto"] = i
        señal["conviction"]["resumen"] = _resumen_idea(señal)

    fuera = _elegir(evitar, MAX_EVITAR, max_por_sector)
    for señal in fuera:
        señal["conviction"]["resumen"] = _resumen_evitar(señal)

    return {
        "ideas": ideas,
        "evitar": fuera,
        "candidatas": len(comprar),
        "descartadas_por_sector": max(0, len(comprar) - len(ideas)),
        "nota": _nota(len(comprar), len(ideas), max_por_sector),
    }


def _nota(candidatas: int, elegidas: int, max_sector: int) -> str:
    if candidatas == 0:
        return (
            "Hoy ninguna empresa cumple las condiciones de compra. No actuar "
            "también es una decisión."
        )
    if candidatas <= elegidas:
        return (
            f"{candidatas} empresas cumplen las condiciones y caben todas en la "
            "lista corta."
        )
    return (
        f"{candidatas} empresas cumplen las condiciones de compra; aquí están las "
        f"{elegidas} de mayor convicción, con un máximo de {max_sector} por sector. "
        "Las demás siguen en «Comprar»: no se han descartado, se han ordenado."
    )
