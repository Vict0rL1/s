"""Registro de experimentos, Sharpe deflactado y holdout bloqueado.

El problema que resuelve este módulo no es de cálculo, es de honestidad. Si
pruebas cuarenta variantes de una estrategia y te quedas con la mejor, esa mejor
tiene un Sharpe alto **por construcción**: con cuarenta intentos sobre ruido puro
alguno sale bien. El Sharpe que publicas no mide la estrategia, mide cuántas
veces miraste. Y nadie lleva la cuenta, porque las variantes descartadas se
olvidan enseguida.

Tres piezas, y ninguna sirve sin las otras dos:

1. **El registro.** Cada intento queda escrito con su hipótesis, sus parámetros,
   su periodo y su resultado. Sin esto, el número de pruebas es una estimación
   sentimental y siempre a la baja.

2. **El Sharpe deflactado** (Bailey y López de Prado, 2014). Descuenta el Sharpe
   que cabría esperar del mejor de N intentos aunque ninguno tuviera ventaja
   real, y devuelve la probabilidad de que el Sharpe verdadero sea positivo.
   Depende de N, así que **solo es tan honesto como el recuento**: un registro
   incompleto produce un DSR optimista, y eso se avisa en la salida.

3. **El holdout bloqueado.** Un tramo final que ningún experimento puede tocar.
   No se puede impedir por código que alguien lo mire —siempre se puede editar
   el código—, pero sí se puede lograr que mirarlo **deje huella permanente** y
   que el camino por defecto nunca pase por ahí. Un holdout mirado dos veces ya
   no es un holdout: es otro conjunto de desarrollo.
"""

from __future__ import annotations

import math
from datetime import date
from statistics import NormalDist

# Fracción final del periodo que queda reservada e intocable.
FRACCION_HOLDOUT = 0.30

EULER_MASCHERONI = 0.5772156649015329
_N = NormalDist()


# --- Partición desarrollo / holdout ------------------------------------------


def partir_periodo(fechas: list[date], fraccion: float = FRACCION_HOLDOUT) -> dict:
    """Separa las fechas en desarrollo y holdout. El corte va por TIEMPO.

    Partir al azar sería un error de método, no un detalle: los retornos están
    autocorrelados y comparten régimen de mercado, así que un holdout entrelazado
    con el desarrollo comparte con él la mayor parte de la información. El único
    corte que produce un conjunto de verdad nuevo es el cronológico.
    """
    if len(fechas) < 10:
        return {
            "desarrollo": list(fechas),
            "holdout": [],
            "suficiente": False,
            "nota": "Periodo demasiado corto para reservar un holdout con sentido.",
        }
    ordenadas = sorted(fechas)
    corte = int(len(ordenadas) * (1 - fraccion))
    return {
        "desarrollo": ordenadas[:corte],
        "holdout": ordenadas[corte:],
        "suficiente": True,
        "corte": ordenadas[corte].isoformat(),
        "nota": (
            f"Desarrollo: {ordenadas[0]} → {ordenadas[corte - 1]}. "
            f"Holdout reservado: {ordenadas[corte]} → {ordenadas[-1]}. "
            "El corte es cronológico a propósito: partir al azar dejaría un "
            "holdout que comparte régimen de mercado con el desarrollo y no "
            "sería información nueva."
        ),
    }


class HoldoutBloqueado(Exception):
    """Se intentó usar el holdout sin desbloquearlo explícitamente."""


def abrir_holdout(confirmacion: str, veces_abierto: int) -> dict:
    """Abre el holdout. Solo una vez tiene valor estadístico; el resto, no.

    Pide una frase exacta en vez de un booleano porque un `True` se teclea sin
    pensar, y el sentido de esto es justamente obligar a pensar. La cuenta de
    aperturas viaja con el resultado para que no se pueda olvidar.
    """
    esperada = "SI, QUEMAR EL HOLDOUT"
    if confirmacion != esperada:
        raise HoldoutBloqueado(
            "El holdout está reservado y no se toca durante el desarrollo. "
            f'Para abrirlo hay que pasar exactamente: "{esperada}". '
            "Piénsalo: solo la PRIMERA vez que se mira es fuera de muestra."
        )
    return {
        "abierto": True,
        "veces_abierto": veces_abierto + 1,
        "sigue_siendo_fuera_de_muestra": veces_abierto == 0,
        "aviso": (
            "Primera apertura: este resultado sí es fuera de muestra. A partir "
            "de ahora el holdout está quemado — cualquier decisión que tomes "
            "viéndolo lo convierte en otro conjunto de desarrollo."
            if veces_abierto == 0
            else f"El holdout ya se abrió {veces_abierto} vez/veces. Este "
            "resultado NO es fuera de muestra: ya has ajustado mirándolo, aunque "
            "haya sido sin querer. Trátalo como desarrollo."
        ),
    }


# --- Sharpe deflactado --------------------------------------------------------


def _momentos(retornos: list[float]) -> tuple[float, float]:
    """Asimetría y curtosis (no en exceso: normal = 3).

    El DSR las necesita porque el Sharpe de una serie con cola izquierda gorda
    es menos fiable de lo que su valor sugiere: una estrategia que gana poco
    muchas veces y pierde mucho de golpe tiene buen Sharpe hasta que no lo tiene.
    """
    n = len(retornos)
    if n < 4:
        return 0.0, 3.0
    media = sum(retornos) / n
    m2 = sum((r - media) ** 2 for r in retornos) / n
    if m2 <= 0:
        return 0.0, 3.0
    m3 = sum((r - media) ** 3 for r in retornos) / n
    m4 = sum((r - media) ** 4 for r in retornos) / n
    return m3 / m2**1.5, m4 / m2**2


def sharpe_esperado_del_mejor(n_pruebas: int, desviacion_sharpes: float) -> float:
    """Qué Sharpe cabe esperar del MEJOR de N intentos sin ventaja ninguna.

    Es el umbral que hay que superar para poder hablar de hallazgo. Con muchos
    intentos crece deprisa: probar cuarenta variantes sobre ruido produce, solo
    por selección, un Sharpe que parece bueno.
    """
    if n_pruebas < 2 or desviacion_sharpes <= 0:
        return 0.0
    a = _N.inv_cdf(1 - 1 / n_pruebas)
    b = _N.inv_cdf(1 - 1 / (n_pruebas * math.e))
    return desviacion_sharpes * ((1 - EULER_MASCHERONI) * a + EULER_MASCHERONI * b)


def sharpe_deflactado(
    retornos: list[float],
    n_pruebas: int,
    desviacion_sharpes: float | None = None,
    sharpes_probados: list[float] | None = None,
) -> dict:
    """Probabilidad de que el Sharpe verdadero sea positivo, tras descontar
    cuántas veces se miró. Bailey y López de Prado (2014).

    Devuelve `dsr`: probabilidad, no un Sharpe. Por encima de 0,95 se considera
    un hallazgo; por debajo, lo compatible con haber probado hasta encontrar algo.
    """
    n = len(retornos)
    if n < 8:
        return {"dsr": None, "suficiente": False, "nota": "Muy pocos periodos."}

    media = sum(retornos) / n
    var = sum((r - media) ** 2 for r in retornos) / (n - 1)
    if var <= 0:
        return {"dsr": None, "suficiente": False, "nota": "Serie sin variación."}
    sr = media / math.sqrt(var)  # Sharpe por periodo, sin anualizar

    # Respaldo del artículo: la desviación del propio estimador bajo la nula.
    respaldo = 1 / math.sqrt(n - 1)
    if desviacion_sharpes is None:
        desviacion_sharpes = respaldo
        if sharpes_probados and len(sharpes_probados) > 1:
            m = sum(sharpes_probados) / len(sharpes_probados)
            observada = math.sqrt(
                sum((s - m) ** 2 for s in sharpes_probados) / (len(sharpes_probados) - 1)
            )
            # Solo se usa la dispersión observada si supera al respaldo. Si las
            # pruebas registradas salieron casi idénticas —repeticiones de la
            # misma, por ejemplo— su dispersión tiende a cero y el umbral se
            # desvanecería: la corrección se desactivaría justo cuando más
            # pruebas hay. Ante la duda se deflacta MÁS, nunca menos.
            desviacion_sharpes = max(observada, respaldo)

    sr0 = sharpe_esperado_del_mejor(n_pruebas, desviacion_sharpes)
    asimetria, curtosis = _momentos(retornos)

    denominador = 1 - asimetria * sr + ((curtosis - 1) / 4) * sr**2
    if denominador <= 0:
        return {"dsr": None, "suficiente": False, "nota": "Momentos degenerados."}

    z = (sr - sr0) * math.sqrt(n - 1) / math.sqrt(denominador)
    dsr = _N.cdf(z)

    return {
        "dsr": round(dsr, 4),
        "suficiente": True,
        "sharpe_observado": round(sr, 4),
        "sharpe_umbral": round(sr0, 4),
        "n_pruebas": n_pruebas,
        "n_periodos": n,
        "asimetria": round(asimetria, 3),
        "curtosis": round(curtosis, 3),
        "es_hallazgo": dsr >= 0.95,
        "nota": (
            f"Con {n_pruebas} pruebas registradas, el mejor de ellas tendría un "
            f"Sharpe de {sr0:.3f} por periodo solo por haber mirado tantas veces. "
            f"El observado es {sr:.3f}. "
            + (
                "Supera el umbral con holgura: es un hallazgo."
                if dsr >= 0.95
                else "No supera el listón: este resultado es compatible con "
                "haber probado hasta que algo salió bien."
            )
            + " Y ojo: el DSR solo es tan honesto como el recuento de pruebas. "
            "Las variantes que probaste y no registraste lo inflan."
        ),
    }


# --- Corrección por comparaciones múltiples -----------------------------------


def corregir_multiples(pvalores: dict[str, float], alfa: float = 0.05) -> dict:
    """Bonferroni y Benjamini-Hochberg sobre un conjunto de p-valores.

    Se dan los dos porque responden a preguntas distintas y conviene no
    confundirlas:

    - **Bonferroni** controla la probabilidad de UN solo falso positivo entre
      todos. Es muy estricto y con muchas pruebas descarta casi todo, incluido
      lo bueno.
    - **Benjamini-Hochberg** controla la *proporción* esperada de falsos entre
      los que declaras hallazgo. Es lo razonable cuando buscas candidatos y
      luego los vas a comprobar por separado — que es exactamente este caso.

    Con una sola prueba ambos coinciden con el p-valor crudo; el problema no
    aparece hasta que empiezas a probar variantes.
    """
    if not pvalores:
        return {"n": 0, "bonferroni": {}, "benjamini_hochberg": {}}

    m = len(pvalores)
    bonf = {k: (p <= alfa / m) for k, p in pvalores.items()}

    ordenados = sorted(pvalores.items(), key=lambda kv: kv[1])
    corte = 0
    for i, (_, p) in enumerate(ordenados, start=1):
        if p <= alfa * i / m:
            corte = i
    bh = {k: (i <= corte) for i, (k, _) in enumerate(ordenados, start=1)}

    return {
        "n": m,
        "alfa": alfa,
        "umbral_bonferroni": round(alfa / m, 5),
        "bonferroni": bonf,
        "benjamini_hochberg": bh,
        "sobreviven_bonferroni": [k for k, v in bonf.items() if v],
        "sobreviven_bh": [k for k, v in bh.items() if v],
        "nota": (
            f"Con {m} comparaciones y alfa {alfa}, Bonferroni exige un p-valor "
            f"por debajo de {alfa / m:.5f} para cada una. Benjamini-Hochberg es "
            "menos estricto porque controla la proporción de falsos entre los "
            "declarados, no la probabilidad de que haya uno solo — es lo "
            "adecuado cuando lo que buscas son candidatos a verificar después."
        ),
    }


def pvalor_desde_bootstrap(diferencias: list[float]) -> float:
    """p-valor a dos colas de una distribución bootstrap de diferencias.

    No se asume normalidad: se cuenta directamente qué proporción de la
    distribución queda al otro lado del cero. Los retornos financieros tienen
    colas gordas y asumir normalidad aquí estrecharía el resultado.
    """
    if not diferencias:
        return 1.0
    n = len(diferencias)
    por_debajo = sum(1 for d in diferencias if d <= 0) / n
    por_encima = sum(1 for d in diferencias if d >= 0) / n
    return min(1.0, 2 * min(por_debajo, por_encima))


# --- El registro --------------------------------------------------------------


def registrar(
    session,
    *,
    hipotesis: str,
    estrategia: str,
    parametros: dict,
    desde: str,
    hasta: str,
    universo: list[str],
    resultado: dict,
    sharpe: float | None,
    uso_holdout: bool = False,
    notas: str | None = None,
):
    """Escribe un experimento. Se llama SIEMPRE, salga bien o mal.

    Registrar solo los que funcionan es exactamente lo que rompe el DSR: el
    descuento por selección depende de cuántas veces miraste, y si las pruebas
    fallidas no se anotan, el recuento sale corto y el resultado parece mejor de
    lo que es. Un experimento fallido registrado vale más que uno bueno olvidado.
    """
    from app.db.models import Experiment

    fila = Experiment(
        hipotesis=hipotesis,
        estrategia=estrategia,
        parametros=parametros,
        periodo_desde=desde,
        periodo_hasta=hasta,
        universo={"n": len(universo), "simbolos": sorted(universo)[:50]},
        resultado=resultado,
        sharpe=sharpe,
        uso_holdout=uso_holdout,
        notas=notas,
    )
    session.add(fila)
    session.commit()
    return fila


def historial(session) -> dict:
    """Todo lo probado hasta ahora: es lo que alimenta el descuento del DSR."""
    from sqlalchemy import select

    from app.db.models import Experiment

    filas = session.execute(
        select(Experiment).order_by(Experiment.created_at)
    ).scalars().all()

    sharpes = [f.sharpe for f in filas if f.sharpe is not None]
    aperturas = sum(1 for f in filas if f.uso_holdout)
    return {
        "n_pruebas": len(filas),
        "sharpes": sharpes,
        "veces_holdout_abierto": aperturas,
        "experimentos": [
            {
                "id": f.id,
                "fecha": f.created_at.isoformat() if f.created_at else None,
                "hipotesis": f.hipotesis,
                "estrategia": f.estrategia,
                "parametros": f.parametros,
                "periodo": f"{f.periodo_desde} → {f.periodo_hasta}",
                "sharpe": f.sharpe,
                "uso_holdout": f.uso_holdout,
            }
            for f in filas
        ],
        "nota": (
            f"{len(filas)} pruebas registradas. El Sharpe deflactado descuenta "
            "exactamente ese número, así que solo es honesto si están todas — "
            "las variantes que probaste sin anotar lo inflan."
            + (
                ""
                if aperturas == 0
                else f" ATENCIÓN: el holdout se ha abierto {aperturas} vez/veces; "
                "a partir de la primera dejó de ser fuera de muestra."
            )
        ),
    }
