"""Señales del mercado de opciones, al lado del fundamental y NO mezcladas.

El mercado de opciones cotiza algo que el fundamental no cotiza: cuánto se
espera que se mueva la acción, en qué dirección duele más, y cuánto está
dispuesta a pagar la gente por cubrirse. Son preguntas distintas de «¿vale lo
que cuesta?», y por eso van en su propio panel.

**Estas señales no se suman al score fundamental.** Fundirlas en un número
único destruiría justo lo que las hace útiles: que pueden contradecirse. Una
empresa barata con la volatilidad implícita por las nubes está diciendo dos
cosas a la vez, y esa contradicción es la información — promediarla la borra.

Cuatro límites del dato gratuito, dichos aquí y repetidos en cada salida:

1. **La cadena no trae delta.** Se calcula con Black-Scholes a partir de la IV
   que sí viene, para poder dar un skew de 25 delta de verdad y no un «skew»
   por moneyness disfrazado.
2. **No hay histórico de IV ni de open interest.** «Inusual respecto a su
   media» necesita una media, y el día uno no existe: se construye guardando
   instantáneas. Hasta entonces se dice que no hay base, no se inventa.
3. **Muchos contratos cotizan basura.** Strikes ilíquidos con IV de 300 %,
   precios de hace tres días, horquillas del 80 %. Se filtran antes de calcular
   y se informa de cuántos se tiraron.
4. **IV es a futuro y la volatilidad realizada es del pasado.** Compararlas es
   lo estándar y sigue siendo una comparación sesgada. Ver `prima_de_riesgo`.
"""

from __future__ import annotations

import math
from datetime import date, datetime, timezone

# Un contrato cuyo último cruce es de hace días no cotiza: su IV describe otro
# mundo. Dos sesiones es generoso y aun así tira mucha morralla.
MAX_DIAS_SIN_CRUZAR = 2
# Horquilla relativa por encima de la cual el punto medio no significa nada.
MAX_HORQUILLA = 0.35
# IV fuera de esto es error de la fuente, no una opinión del mercado.
IV_MIN, IV_MAX = 0.01, 3.0
# Con menos contratos limpios que esto, ninguna curva es una curva.
MIN_CONTRATOS = 6
# Días objetivo del tenor de referencia. 30 es la convención (VIX, etc.).
TENOR_REFERENCIA = 30
# Instantáneas mínimas para que una «media» sea una media y no un punto.
MIN_BASE_HISTORICA = 10


# --- Black-Scholes: solo lo que hace falta ------------------------------------


def _miles(n: float) -> str:
    """Separador de miles a la española, sobre el número y NO sobre la frase.

    Estaba escrito como `.replace(",", ".")` aplicado al texto entero, que
    convertía en punto cualquier coma de la prosa: «Es un salto grande, y
    merece» salía «Es un salto grande. y merece».
    """
    return f"{n:,.0f}".replace(",", ".")


def _norm_cdf(x: float) -> float:
    """N(x) sin scipy. `math.erf` está en la librería estándar desde 3.2."""
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def delta_call(spot: float, strike: float, iv: float, años: float, tasa: float) -> float | None:
    """Delta de una call: N(d1).

    Se calcula aquí porque la cadena gratuita no lo trae, y sin delta el
    «skew de 25 delta» del que habla todo el mundo no se puede construir. La
    alternativa —comparar IV a un 10 % por encima y por debajo del spot— cambia
    de significado según la volatilidad de cada empresa: en una acción tranquila
    ese 10 % está lejísimos y en una volátil está al lado, así que compara cosas
    distintas y las llama iguales.

    La tasa libre de riesgo influye poco a 30 días (mover r un punto entero
    cambia el delta en la tercera cifra), así que un valor razonable basta y no
    se gasta una llamada a FRED por esto.
    """
    if spot <= 0 or strike <= 0 or iv <= 0 or años <= 0:
        return None
    d1 = (math.log(spot / strike) + (tasa + iv * iv / 2) * años) / (iv * math.sqrt(años))
    return _norm_cdf(d1)


# --- Limpieza de la cadena ----------------------------------------------------


def _dias_hasta(vencimiento: date, hoy: date | None = None) -> int:
    return (vencimiento - (hoy or date.today())).days


def limpiar(contratos: list[dict], hoy: date | None = None) -> tuple[list[dict], dict]:
    """Se queda con los contratos que de verdad cotizan, y cuenta lo que tira.

    El filtrado no es cosmética: una sola IV de 300 % de un strike que no cruza
    desde el martes arrastra cualquier media y convierte el panel en ruido con
    aspecto de señal. Y como filtrar es tirar datos, se informa de cuántos y por
    qué — un panel construido sobre el 8 % de la cadena no es un panel de la
    cadena.
    """
    hoy = hoy or date.today()
    limpios, motivos = [], {"sin_cruce_reciente": 0, "horquilla": 0, "iv_absurda": 0, "sin_precio": 0}

    for c in contratos:
        iv = c.get("iv")
        bid, ask = c.get("bid"), c.get("ask")
        if not iv or not (IV_MIN <= iv <= IV_MAX):
            motivos["iv_absurda"] += 1
            continue
        if not bid or not ask or bid <= 0 or ask <= 0:
            motivos["sin_precio"] += 1
            continue
        medio = (bid + ask) / 2
        if medio <= 0 or (ask - bid) / medio > MAX_HORQUILLA:
            motivos["horquilla"] += 1
            continue
        ultimo = c.get("ultimo_cruce")
        if ultimo is not None and (hoy - ultimo).days > MAX_DIAS_SIN_CRUZAR:
            motivos["sin_cruce_reciente"] += 1
            continue
        limpios.append({**c, "medio": medio})

    total = len(contratos)
    return limpios, {
        "recibidos": total,
        "usados": len(limpios),
        "descartados": total - len(limpios),
        "motivos": {k: v for k, v in motivos.items() if v},
        "nota": (
            f"De {total} contratos se usan {len(limpios)}. Se descartan los que no "
            f"cruzan desde hace más de {MAX_DIAS_SIN_CRUZAR} días, los de horquilla "
            f"mayor del {MAX_HORQUILLA:.0%} y los de IV fuera de "
            f"[{IV_MIN:.0%}, {IV_MAX:.0%}]: un strike ilíquido con IV de 300 % "
            "arrastra cualquier media y parece señal."
        ),
    }


# --- Volatilidad implícita ATM y estructura temporal ---------------------------


def iv_atm(contratos: list[dict], spot: float) -> float | None:
    """IV en el dinero: media de los dos strikes que abrazan el spot.

    Se promedian call y put del mismo strike cuando ambas están: por paridad
    deberían dar la misma IV, y que no la den es señal de que una de las dos
    está mal cotizada. Promediar es más robusto que elegir.
    """
    if not contratos or spot <= 0:
        return None
    por_strike: dict[float, list[float]] = {}
    for c in contratos:
        por_strike.setdefault(c["strike"], []).append(c["iv"])
    strikes = sorted(por_strike)
    if not strikes:
        return None
    # Los dos strikes más cercanos al spot, uno por debajo y otro por encima si
    # los hay; si el spot cae fuera de la cadena, el más cercano a secas.
    abajo = [s for s in strikes if s <= spot]
    arriba = [s for s in strikes if s >= spot]
    elegidos = []
    if abajo:
        elegidos.append(max(abajo))
    if arriba:
        elegidos.append(min(arriba))
    if not elegidos:
        return None
    ivs = [v for s in elegidos for v in por_strike[s]]
    return sum(ivs) / len(ivs)


def estructura_temporal(cadenas: dict[date, list[dict]], spot: float, hoy: date | None = None) -> dict:
    """IV ATM por vencimiento: qué precio tiene el riesgo a cada plazo.

    Lo normal es contango —cuanto más lejos, más IV— porque a más plazo cabe
    más incertidumbre. Cuando se invierte (backwardation) el mercado está
    diciendo que el susto es AHORA: pasa antes de resultados, de una sentencia,
    de una decisión regulatoria. Es de las pocas señales de opciones que se lee
    sin saber de opciones.
    """
    hoy = hoy or date.today()
    puntos = []
    for venc in sorted(cadenas):
        dias = _dias_hasta(venc, hoy)
        if dias <= 0:
            continue
        iv = iv_atm(cadenas[venc], spot)
        if iv is not None:
            puntos.append({"vencimiento": venc.isoformat(), "dias": dias, "iv": round(iv, 4)})

    if len(puntos) < 2:
        return {
            "disponible": False,
            "puntos": puntos,
            "nota": "Hacen falta al menos dos vencimientos con IV utilizable.",
        }

    corto, largo = puntos[0], puntos[-1]
    pendiente = largo["iv"] - corto["iv"]
    forma = "contango" if pendiente > 0.01 else ("backwardation" if pendiente < -0.01 else "plana")
    return {
        "disponible": True,
        "puntos": puntos,
        "pendiente": round(pendiente, 4),
        "forma": forma,
        "nota": (
            {
                "contango": (
                    "Contango: la IV sube con el plazo, que es lo normal — a más "
                    "tiempo, más cosas pueden pasar."
                ),
                "backwardation": (
                    "BACKWARDATION: el corto plazo paga más volatilidad que el largo. "
                    "El mercado dice que el susto es ahora, no dentro de seis meses. "
                    "Suele haber una fecha concreta detrás: resultados, una sentencia, "
                    "un regulador."
                ),
                "plana": "Estructura plana: el mercado no distingue entre plazos.",
            }[forma]
            + f" De {corto['dias']} a {largo['dias']} días la IV ATM va del "
            f"{corto['iv']:.1%} al {largo['iv']:.1%}."
        ),
    }


def iv_a_tenor(
    cadenas: dict[date, list[dict]], spot: float, dias: int = TENOR_REFERENCIA, hoy: date | None = None
) -> dict:
    """IV ATM interpolada al tenor pedido (30 días por convención).

    Los vencimientos que cotizan no caen en el día que a uno le viene bien, así
    que se interpola linealmente en varianza —no en volatilidad— porque la
    varianza es lo que escala con el tiempo. Interpolar en vol da un número
    parecido y sistemáticamente sesgado.
    """
    hoy = hoy or date.today()
    puntos = []
    for venc in sorted(cadenas):
        d = _dias_hasta(venc, hoy)
        iv = iv_atm(cadenas[venc], spot) if d > 0 else None
        if iv is not None:
            puntos.append((d, iv))
    if not puntos:
        return {"disponible": False, "nota": "Ningún vencimiento con IV utilizable."}

    exacto = next((iv for d, iv in puntos if d == dias), None)
    if exacto is not None:
        return {"disponible": True, "iv": round(exacto, 4), "dias": dias, "interpolada": False}

    antes = [(d, iv) for d, iv in puntos if d < dias]
    despues = [(d, iv) for d, iv in puntos if d > dias]
    if not antes or not despues:
        # Sin vencimientos a ambos lados no se interpola: se dice cuál se usa.
        d, iv = min(puntos, key=lambda p: abs(p[0] - dias))
        return {
            "disponible": True,
            "iv": round(iv, 4),
            "dias": d,
            "interpolada": False,
            "nota": (
                f"No hay vencimientos a ambos lados de {dias} días: se usa el de {d} "
                "días sin interpolar, y ese es el plazo que describe."
            ),
        }

    d0, iv0 = max(antes)
    d1, iv1 = min(despues)
    # Interpolación en varianza total: σ²·t
    v0, v1 = iv0 * iv0 * d0, iv1 * iv1 * d1
    v = v0 + (v1 - v0) * (dias - d0) / (d1 - d0)
    iv = math.sqrt(max(v, 0) / dias)
    return {
        "disponible": True,
        "iv": round(iv, 4),
        "dias": dias,
        "interpolada": True,
        "entre": [d0, d1],
        "nota": (
            f"Interpolada entre los vencimientos de {d0} y {d1} días. Se interpola "
            "en varianza, no en volatilidad: la varianza es lo que escala con el "
            "tiempo, y hacerlo en vol da un número parecido y sesgado siempre en la "
            "misma dirección."
        ),
    }


# --- Prima de riesgo: implícita contra realizada -------------------------------


def volatilidad_realizada(cierres: list[float], dias: int = 30) -> float | None:
    """Volatilidad realizada anualizada, cierre a cierre."""
    ventana = cierres[-(dias + 1) :]
    retornos = [
        math.log(ventana[i] / ventana[i - 1])
        for i in range(1, len(ventana))
        if ventana[i - 1] > 0 and ventana[i] > 0
    ]
    if len(retornos) < max(10, dias // 3):
        return None
    media = sum(retornos) / len(retornos)
    var = sum((r - media) ** 2 for r in retornos) / (len(retornos) - 1)
    return math.sqrt(var * 252)


def prima_de_riesgo(iv: float | None, rv: float | None, base: list[float] | None = None) -> dict:
    """IV menos volatilidad realizada: cuánto se paga de más por cubrirse.

    Que la prima sea positiva de media es de los hallazgos más sólidos que hay
    en finanzas: vender volatilidad gana casi siempre y pierde muchísimo de
    golpe. Pero LA COMPARACIÓN ESTÁ SESGADA y hay que decirlo cada vez: la IV
    mira 30 días hacia ADELANTE y la realizada mira 30 días hacia ATRÁS. No son
    el mismo periodo. Cuando la volatilidad sube, la realizada de ayer subestima
    la de mañana y la prima parece más grande de lo que es; cuando baja, al
    revés.

    El número honesto sería IV contra la realizada de los 30 días SIGUIENTES, y
    esa no se sabe todavía. Por eso el juicio («prima alta») solo se emite
    contra la propia historia de la empresa —`base`—, no contra un umbral
    universal: un 5 % de prima es mucho en una eléctrica y poco en una
    biotecnológica.
    """
    if iv is None or rv is None:
        return {
            "disponible": False,
            "nota": "Falta la implícita o la realizada para comparar.",
        }
    prima = iv - rv
    salida = {
        "disponible": True,
        "iv": round(iv, 4),
        "rv": round(rv, 4),
        "prima": round(prima, 4),
        "ratio": round(iv / rv, 3) if rv > 0 else None,
        "aviso_sesgo": (
            "La IV mira 30 días hacia adelante y la realizada 30 hacia atrás: no son "
            "el mismo periodo. Con la volatilidad subiendo, esta resta exagera la "
            "prima; bajando, la encoge."
        ),
    }

    if not base or len(base) < MIN_BASE_HISTORICA:
        salida["percentil"] = None
        salida["nota"] = (
            f"Sin base histórica suficiente ({len(base or [])} de "
            f"{MIN_BASE_HISTORICA} instantáneas) no se puede decir si esta prima es "
            "alta PARA ESTA EMPRESA, que es la única comparación que significa algo. "
            "La base se construye sola según se consulte el panel."
        )
        return salida

    menores = sum(1 for p in base if p < prima)
    pct = menores / len(base) * 100
    salida["percentil"] = round(pct, 1)
    salida["base_n"] = len(base)
    salida["nota"] = (
        f"Esta prima está en el percentil {pct:.0f} de las {len(base)} lecturas "
        "guardadas de esta empresa. "
        + (
            "Prima alta para su propia historia: el mercado está pagando caro por "
            "cubrirse."
            if pct >= 80
            else "Prima baja para su propia historia: la cobertura está barata."
            if pct <= 20
            else "En su rango normal."
        )
    )
    return salida


# --- Skew ---------------------------------------------------------------------


def skew_25_delta(
    calls: list[dict],
    puts: list[dict],
    spot: float,
    dias: int,
    tasa: float = 0.04,
) -> dict:
    """IV de la put de 25 delta menos la de la call de 25 delta.

    Es la medida de a qué lado le tiene miedo el mercado. Casi siempre sale
    positiva en acciones —las caídas asustan más que las subidas y la cobertura
    a la baja se paga— así que lo informativo no es el signo sino el tamaño y,
    sobre todo, el cambio.

    Se busca el contrato cuyo delta calculado esté más cerca de 0,25 (call) y de
    −0,25 (put, es decir N(d1)=0,75). Si el más cercano se queda lejos, se dice:
    una cadena con cuatro strikes no tiene un 25 delta y fingir que sí lo tiene
    es inventarse el número.
    """
    if spot <= 0 or dias <= 0:
        return {"disponible": False, "nota": "Sin spot o sin plazo no hay delta que calcular."}
    años = dias / 365.0

    def _mas_cercano(contratos: list[dict], objetivo: float):
        mejor, mejor_dist = None, None
        for c in contratos:
            d = delta_call(spot, c["strike"], c["iv"], años, tasa)
            if d is None:
                continue
            dist = abs(d - objetivo)
            if mejor_dist is None or dist < mejor_dist:
                mejor, mejor_dist = {**c, "delta": d}, dist
        return mejor, mejor_dist

    call, dc = _mas_cercano(calls, 0.25)
    put, dp = _mas_cercano(puts, 0.75)
    if call is None or put is None:
        return {"disponible": False, "nota": "No hay contratos con delta calculable a este plazo."}

    # Tolerancia: más allá de esto no es un 25 delta, es el strike que había.
    TOLERANCIA = 0.10
    if dc > TOLERANCIA or dp > TOLERANCIA:
        return {
            "disponible": False,
            "delta_call_hallado": round(call["delta"], 3),
            "delta_put_hallado": round(put["delta"] - 1, 3),
            "nota": (
                "La cadena no llega al 25 delta a este plazo: lo más cercano está a "
                f"delta {call['delta']:.2f} (call) y {put['delta'] - 1:.2f} (put). "
                "Dar eso por «skew de 25 delta» sería ponerle nombre técnico al "
                "strike que hubiera."
            ),
        }

    valor = put["iv"] - call["iv"]
    return {
        "disponible": True,
        "skew": round(valor, 4),
        "iv_put_25d": round(put["iv"], 4),
        "iv_call_25d": round(call["iv"], 4),
        "strike_put": put["strike"],
        "strike_call": call["strike"],
        "dias": dias,
        "nota": (
            f"La put de 25 delta paga {abs(valor):.1%} "
            f"{'más' if valor > 0 else 'menos'} de volatilidad que la call. "
            + (
                "Es lo normal en acciones: las caídas asustan más que las subidas, "
                "así que el seguro a la baja siempre cuesta más. Lo que informa es "
                "el tamaño y el cambio, no el signo."
                if valor > 0
                else "Skew INVERTIDO: se paga más por la subida que por la caída. "
                "Es raro en acciones y suele haber una opa, una aprobación o un "
                "corto masivo detrás."
            )
        ),
    }


# --- Movimiento implícito antes de resultados ---------------------------------


def movimiento_implicito(contratos: list[dict], spot: float) -> dict:
    """Cuánto se espera que se mueva, del straddle ATM.

    El straddle en el dinero (call + put del mismo strike) cuesta
    aproximadamente lo que el mercado cree que se va a mover la acción, en
    cualquier dirección, hasta el vencimiento. Dividido por el precio da un
    porcentaje comparable entre empresas.

    La aproximación tiene un límite que hay que decir: el straddle cubre TODO el
    periodo hasta vencimiento, no solo el día de resultados. Si vence una semana
    después, dentro va también la volatilidad de esos días sueltos, así que esto
    sobreestima algo el salto del día. Es la convención y sirve para comparar;
    no es el salto exacto.
    """
    if spot <= 0:
        return {"disponible": False, "nota": "Sin precio de la acción no hay porcentaje."}
    por_strike: dict[float, dict[str, float]] = {}
    for c in contratos:
        tipo = c.get("tipo")
        if tipo not in ("call", "put"):
            continue
        por_strike.setdefault(c["strike"], {})[tipo] = c["medio"]

    completos = {k: v for k, v in por_strike.items() if "call" in v and "put" in v}
    if not completos:
        return {
            "disponible": False,
            "nota": "No hay ningún strike con call y put utilizables a la vez.",
        }

    strike = min(completos, key=lambda k: abs(k - spot))
    par = completos[strike]
    straddle = par["call"] + par["put"]
    pct = straddle / spot * 100
    return {
        "disponible": True,
        "movimiento_pct": round(pct, 2),
        "strike": strike,
        "straddle": round(straddle, 4),
        "distancia_atm_pct": round(abs(strike - spot) / spot * 100, 2),
        "nota": (
            f"El mercado paga por un movimiento de ±{pct:.1f} % hasta el "
            "vencimiento. Sale del straddle en el dinero, que cubre TODO el periodo "
            "y no solo el día de resultados: sobreestima algo el salto de ese día."
        ),
    }


def movimientos_historicos(
    cierres: list[tuple[date, float]], fechas: list[date], ventana: int = 1
) -> dict:
    """El movimiento REAL de esta empresa en sus últimos resultados.

    Sirve para lo único que hace útil al movimiento implícito: compararlo con lo
    que de verdad suele pasar. Un ±8 % implícito no dice nada solo; dice mucho si
    esta empresa se mueve un 3 % de mediana.

    Se mide del cierre anterior al anuncio al cierre de después. Si la empresa
    publica antes de abrir, el movimiento cae ese mismo día; si publica al
    cerrar, cae al siguiente. `ventana` cubre ambos casos mirando el cierre
    `ventana` sesiones después del previo.
    """
    if not cierres or not fechas:
        return {"disponible": False, "movimientos": [], "nota": "Faltan cierres o fechas."}

    serie = sorted(cierres)
    fechas_idx = {d: i for i, (d, _) in enumerate(serie)}
    orden = [d for d, _ in serie]

    movimientos = []
    for f in sorted(fechas):
        # Índice de la última sesión ANTERIOR o igual al anuncio.
        i = fechas_idx.get(f)
        if i is None:
            previas = [j for j, d in enumerate(orden) if d < f]
            if not previas:
                continue
            i = previas[-1]
        j = i + ventana
        if i == 0 or j >= len(serie):
            continue
        antes, despues = serie[i - 1][1], serie[j][1]
        if antes <= 0:
            continue
        movimientos.append(
            {"fecha": f.isoformat(), "movimiento_pct": round((despues / antes - 1) * 100, 2)}
        )

    if not movimientos:
        return {
            "disponible": False,
            "movimientos": [],
            "nota": (
                "Ninguna fecha de resultados cae dentro del histórico de precios "
                "disponible."
            ),
        }

    absolutos = sorted(abs(m["movimiento_pct"]) for m in movimientos)
    n = len(absolutos)
    mediana = absolutos[n // 2] if n % 2 else (absolutos[n // 2 - 1] + absolutos[n // 2]) / 2
    return {
        "disponible": True,
        "movimientos": movimientos,
        "n": n,
        "mediana_abs_pct": round(mediana, 2),
        "maximo_abs_pct": round(absolutos[-1], 2),
        "nota": (
            f"{n} resultados con precio alrededor. La mediana del movimiento absoluto "
            f"es {mediana:.1f} % y el mayor fue {absolutos[-1]:.1f} %. Se mide del "
            "cierre anterior al anuncio al cierre siguiente."
        ),
    }


def comparar_movimiento(implicito: dict, historico: dict) -> dict:
    """El implícito contra lo que esta empresa hace de verdad.

    No se emite ninguna recomendación. Que el implícito esté por encima de la
    mediana histórica NO significa «vende volatilidad»: significa que el mercado
    espera más de lo habitual, y puede tener razón — a veces la tiene y por eso
    vender volatilidad antes de resultados arruina a gente todos los trimestres.
    """
    if not implicito.get("disponible") or not historico.get("disponible"):
        return {
            "disponible": False,
            "nota": "Hace falta el implícito y al menos unos resultados pasados con precio.",
        }
    imp = implicito["movimiento_pct"]
    med = historico["mediana_abs_pct"]
    n = historico["n"]
    mayores = sum(1 for m in historico["movimientos"] if abs(m["movimiento_pct"]) > imp)

    return {
        "disponible": True,
        "implicito_pct": imp,
        "mediana_historica_pct": med,
        "razon": round(imp / med, 2) if med > 0 else None,
        "veces_superado": mayores,
        "de": n,
        "nota": (
            f"El mercado paga ±{imp:.1f} % y esta empresa se ha movido más que eso en "
            f"{mayores} de sus últimos {n} resultados (mediana histórica: "
            f"{med:.1f} %). "
            "Esto NO es una recomendación de vender ni comprar volatilidad: que el "
            "implícito supere a la mediana es lo habitual, y el trimestre en que el "
            "mercado acierta se lleva por delante a quien vendió los otros cuatro."
        ),
    }


# --- Actividad inusual --------------------------------------------------------


def actividad(contratos: list[dict], base: dict | None = None) -> dict:
    """Volumen y open interest, y qué tiene de raro lo de hoy.

    Cuatro lecturas que suelen confundirse entre sí:

    - **Volumen sobre open interest** se lee HOY, sin histórico: si en un strike
      se cruzan más contratos de los que había abiertos, ahí se está montando
      una posición nueva. Es la señal más limpia que da el dato gratuito.
    - **Volumen contra su media** necesita una media, y el día uno no hay
      ninguna. Se construye guardando instantáneas; hasta que haya suficientes
      se dice que no la hay en vez de comparar contra un número inventado.
    - **Open interest contra su media**, lo mismo. Y es la mitad que más
      informa: el volumen se cruza en las dos direcciones, así que una sesión
      frenética puede cerrar tantas posiciones como abre; el open interest es lo
      que quedó abierto.
    - **Variación del open interest** desde la lectura anterior, que es lo más
      cercano a «hay más gente dentro que ayer» que dan estos datos.

    Ninguna dice quién compra ni por qué. Un volumen enorme en puts puede ser
    miedo, puede ser una cobertura de alguien que acaba de comprar la acción, y
    puede ser el otro lado de una venta. Aquí se cuenta lo que pasó, no lo que
    significa.
    """
    calls = [c for c in contratos if c.get("tipo") == "call"]
    puts = [c for c in contratos if c.get("tipo") == "put"]
    vol_calls = sum(c.get("volumen") or 0 for c in calls)
    vol_puts = sum(c.get("volumen") or 0 for c in puts)
    oi_calls = sum(c.get("oi") or 0 for c in calls)
    oi_puts = sum(c.get("oi") or 0 for c in puts)
    vol_total, oi_total = vol_calls + vol_puts, oi_calls + oi_puts

    # Strikes donde hoy se ha cruzado más de lo que había abierto.
    nuevos = []
    for c in contratos:
        v, oi = c.get("volumen") or 0, c.get("oi") or 0
        if v >= 50 and oi > 0 and v > oi:
            nuevos.append(
                {
                    "tipo": c["tipo"],
                    "strike": c["strike"],
                    "volumen": v,
                    "oi": oi,
                    "ratio": round(v / oi, 2),
                }
            )
    nuevos.sort(key=lambda x: -x["ratio"])

    salida = {
        "volumen_calls": vol_calls,
        "volumen_puts": vol_puts,
        "oi_calls": oi_calls,
        "oi_puts": oi_puts,
        "put_call_volumen": round(vol_puts / vol_calls, 3) if vol_calls else None,
        "put_call_oi": round(oi_puts / oi_calls, 3) if oi_calls else None,
        "volumen_sobre_oi": round(vol_total / oi_total, 3) if oi_total else None,
        "posiciones_nuevas": nuevos[:10],
        "nota_posiciones": (
            f"{len(nuevos)} strike(s) con más volumen hoy que open interest abierto: "
            "ahí se está montando algo nuevo, no cerrando lo viejo. No dice quién ni "
            "por qué — un volumen enorme en puts puede ser miedo o puede ser la "
            "cobertura de alguien que acaba de comprar la acción."
            if nuevos
            else "Ningún strike cruza hoy más de lo que tenía abierto: actividad "
            "normal, sin posiciones nuevas de tamaño."
        ),
    }

    salida["volumen"] = _contra_su_media(vol_total, (base or {}).get("volumen") or [], "volumen")
    salida["open_interest"] = _contra_su_media(
        oi_total, (base or {}).get("oi") or [], "open interest"
    )
    salida["variacion_oi"] = _variacion_de_oi(oi_total, (base or {}).get("oi") or [])

    # `inusual` y `nota_base` se conservan apuntando al volumen: son lo que ya
    # consumía la pantalla, y romperlos para renombrarlos no arregla nada.
    salida["inusual"] = salida["volumen"]["detalle"]
    salida["nota_base"] = salida["volumen"]["nota"]
    return salida


def _contra_su_media(hoy: float, historico: list[float], etiqueta: str) -> dict:
    """Lo de hoy contra su propia media, o por qué todavía no se puede decir.

    Un solo sitio para el juicio, porque el volumen y el open interest hacen
    exactamente la misma pregunta y tenerlo duplicado era la forma segura de que
    la guarda de dispersión cero se arreglara en uno y no en el otro.
    """
    if len(historico) < MIN_BASE_HISTORICA:
        return {
            "disponible": False,
            "detalle": None,
            "nota": (
                f"«{etiqueta.capitalize()} inusual respecto a su media» necesita una "
                f"media: hay {len(historico)} instantáneas de las "
                f"{MIN_BASE_HISTORICA} que hacen falta. Se guarda una por día, así "
                "que la base se construye sola. Hasta entonces solo se informa del "
                "dato de hoy."
            ),
        }

    media = sum(historico) / len(historico)
    var = sum((v - media) ** 2 for v in historico) / (len(historico) - 1)
    sd = math.sqrt(var)

    if sd <= 0:
        # Base sin variación: la z sería una división por cero y devolver 0,0
        # diría «dentro de lo normal» justo cuando el dato de hoy puede estar al
        # doble de la media.
        return {
            "disponible": True,
            "detalle": {
                "hoy": hoy,
                "volumen_hoy": hoy,  # nombre viejo, para no romper la pantalla
                "media": round(media, 1),
                "z": None,
                "base_n": len(historico),
            },
            "nota": (
                f"El {etiqueta} de hoy ({_miles(hoy)}) contra una media de "
                f"{_miles(media)} sobre {len(historico)} lecturas, pero esas lecturas "
                "no varían entre sí: sin dispersión no hay forma de decir si esto es "
                "mucho. Con más instantáneas distintas el juicio aparece solo."
            ),
        }

    z = (hoy - media) / sd
    return {
        "disponible": True,
        "detalle": {
            "hoy": hoy,
            "volumen_hoy": hoy,
            "media": round(media, 1),
            "z": round(z, 2),
            "base_n": len(historico),
        },
        "nota": (
            f"El {etiqueta} de hoy ({_miles(hoy)}) está a {z:+.1f} desviaciones de su "
            f"media de {_miles(media)} sobre {len(historico)} lecturas. "
            + (
                "Es un salto grande, y merece mirar qué strikes."
                if abs(z) >= 2
                else "Dentro de lo normal para esta empresa."
            )
        ),
    }


def _variacion_de_oi(hoy: int, historico: list[float]) -> dict:
    """Cuánto ha cambiado el open interest desde la última lectura.

    Es la señal que el volumen no da. El volumen cuenta lo que se cruzó, y se
    cruza en las dos direcciones: media sesión frenética puede cerrar tantas
    posiciones como abre y dejar el mercado donde estaba. El open interest es lo
    que QUEDÓ abierto al final del día, así que su variación es lo más cercano a
    «hay más gente dentro que ayer» que dan estos datos.

    Cae del histórico que ya se guarda para la media, sin ninguna llamada extra.
    """
    if not historico:
        return {
            "disponible": False,
            "nota": (
                "Sin una lectura anterior no hay variación que medir. La primera "
                "consulta guarda la referencia; a partir de la segunda aparece."
            ),
        }
    anterior = historico[-1]
    if not anterior:
        return {"disponible": False, "nota": "La lectura anterior no tiene open interest."}
    cambio = hoy - anterior
    pct = cambio / anterior * 100
    return {
        "disponible": True,
        "anterior": anterior,
        "hoy": hoy,
        "cambio": cambio,
        "cambio_pct": round(pct, 1),
        "nota": (
            f"El open interest {'sube' if cambio > 0 else 'baja' if cambio < 0 else 'queda igual'} "
            f"un {abs(pct):.1f} % desde la lectura anterior "
            f"({_miles(anterior)} → {_miles(hoy)}). "
            + (
                "Subir es que quedan más posiciones abiertas que antes: se está "
                "montando algo, no deshaciendo."
                if pct > 5
                else "Bajar es que se están cerrando posiciones, no abriendo."
                if pct < -5
                else "Sin cambio de posicionamiento apreciable."
            )
        ),
    }


# --- Ensamblado ---------------------------------------------------------------


def panel(
    cadenas: dict[date, list[dict]],
    spot: float,
    cierres: list[tuple[date, float]],
    *,
    fechas_resultados: list[date] | None = None,
    proxima_resultados: date | None = None,
    base: dict | None = None,
    hoy: date | None = None,
    tasa: float = 0.04,
) -> dict:
    """Las cuatro señales, cada una con su cobertura y sus límites.

    Devuelve piezas separadas a propósito. No hay un `score_opciones` y no lo va
    a haber: la utilidad de esto es que puede contradecir al fundamental, y un
    número único borra la contradicción justo cuando es lo más informativo que
    hay en la pantalla.
    """
    hoy = hoy or date.today()
    todos = [c for lista in cadenas.values() for c in lista]
    limpios, calidad = limpiar(todos, hoy)

    if len(limpios) < MIN_CONTRATOS:
        # Dos causas distintas y el usuario necesita saber cuál: una cadena que
        # llegó fina, o una que llegó gorda y se quedó en nada al filtrar. La
        # primera es una empresa sin mercado de opciones; la segunda, un dato
        # malo. «Solo 4 de 4» sugiere un filtrado que no ocurrió.
        filtrado = calidad["descartados"] > 0
        return {
            "disponible": False,
            "calidad": calidad,
            "nota": (
                (
                    f"De {calidad['recibidos']} contratos solo {len(limpios)} pasan el "
                    f"filtro de liquidez, por debajo de los {MIN_CONTRATOS} mínimos."
                    if filtrado
                    else f"La cadena entera son {calidad['recibidos']} contratos, por "
                    f"debajo de los {MIN_CONTRATOS} mínimos: esta empresa casi no tiene "
                    "mercado de opciones."
                )
                + " Cualquier IV que se calculara aquí describiría el ruido de dos "
                "strikes, no lo que opina el mercado."
            ),
        }

    # Re-agrupar los limpios por vencimiento.
    por_venc: dict[date, list[dict]] = {}
    for c in limpios:
        por_venc.setdefault(c["vencimiento"], []).append(c)

    iv30 = iv_a_tenor(por_venc, spot, TENOR_REFERENCIA, hoy)
    cierres_ord = [v for _, v in sorted(cierres)]
    rv30 = volatilidad_realizada(cierres_ord, 30)

    # Skew al vencimiento más cercano a 30 días con contratos a ambos lados.
    venc_skew = min(por_venc, key=lambda v: abs(_dias_hasta(v, hoy) - TENOR_REFERENCIA))
    lista_skew = por_venc[venc_skew]
    sk = skew_25_delta(
        [c for c in lista_skew if c.get("tipo") == "call"],
        [c for c in lista_skew if c.get("tipo") == "put"],
        spot,
        _dias_hasta(venc_skew, hoy),
        tasa,
    )

    # Movimiento implícito: primer vencimiento DESPUÉS de los próximos resultados.
    mov_imp = {"disponible": False, "nota": "No hay fecha de próximos resultados."}
    if proxima_resultados:
        posteriores = [v for v in sorted(por_venc) if v >= proxima_resultados]
        if posteriores:
            venc = posteriores[0]
            mov_imp = movimiento_implicito(por_venc[venc], spot)
            if mov_imp.get("disponible"):
                mov_imp["vencimiento"] = venc.isoformat()
                mov_imp["resultados"] = proxima_resultados.isoformat()
                mov_imp["dias_tras_resultados"] = (venc - proxima_resultados).days
        else:
            mov_imp = {
                "disponible": False,
                "nota": (
                    f"No cotiza ningún vencimiento posterior a los resultados del "
                    f"{proxima_resultados.isoformat()}."
                ),
            }

    hist = movimientos_historicos(cierres, fechas_resultados or [])

    return {
        "disponible": True,
        "spot": spot,
        "calidad": calidad,
        "prima_de_riesgo": prima_de_riesgo(
            iv30.get("iv") if iv30.get("disponible") else None,
            rv30,
            (base or {}).get("prima"),
        ),
        "iv_30d": iv30,
        "skew": sk,
        "estructura_temporal": estructura_temporal(por_venc, spot, hoy),
        "movimiento_esperado": {
            "implicito": mov_imp,
            "historico": hist,
            "comparacion": comparar_movimiento(mov_imp, hist),
        },
        "actividad": actividad(limpios, base),
        "aviso": (
            "Estas señales van AL LADO del análisis fundamental, nunca sumadas a él. "
            "No hay un score de opciones porque fundirlas en un número borraría lo "
            "único que las hace útiles: que pueden contradecir al fundamental, y esa "
            "contradicción es la información."
        ),
    }
