"""Divisas. Sumar dólares con euros sin convertir es la peor clase de error.

Hasta ahora la app sumaba `market_value` de todas las posiciones sin mirar en
qué moneda estaba cada una. Una posición canadiense y otra estadounidense se
sumaban como si un dólar fuera lo mismo que el otro, y eso no daba un aviso ni
un hueco: daba **un número perfectamente creíble y equivocado**, del que luego
cuelgan los pesos, el presupuesto de riesgo y la concentración. El propio
TODO.md lo tenía marcado como lo primero que había que arreglar.

## La trampa de FRED, que es donde se rompe esto de verdad

FRED publica los tipos de cambio pero **NO con una dirección uniforme**:

    DEXCAUS  =  dólares canadienses por UN dólar estadounidense   (1,37)
    DEXUSEU  =  dólares estadounidenses por UN euro               (1,08)

Los dos son «el cambio con el dólar» y van en sentidos opuestos. Invertir uno
sin darse cuenta convierte 1,37 en 0,73: la cartera no falla, no avisa, y sale
casi el doble o casi la mitad. Por eso aquí la dirección va **escrita a mano en
cada entrada, con el título literal de la serie al lado**, y no deducida de un
patrón que parece regular hasta que deja de serlo.

## Cuando no se puede convertir, no se suma

La alternativa —convertir con un tipo inventado, o peor, sumar sin convertir—
produce un total que parece completo. Aquí lo que no se puede convertir queda
FUERA del total y se nombra, igual que hace `estres_en_crisis` con la cobertura.
Un total parcial que se sabe parcial sirve; uno que se cree completo, no.
"""

from __future__ import annotations

from datetime import date, timedelta

# Serie de FRED por divisa, con su dirección explícita.
#
# `por_usd=True`  -> la serie da UNIDADES DE ESA MONEDA por un dólar (CAD/USD).
# `por_usd=False` -> la serie da DÓLARES por una unidad de esa moneda (USD/EUR).
#
# El título es el de FRED, copiado tal cual: es lo que hace comprobable la
# dirección sin salir de este fichero.
SERIES: dict[str, dict] = {
    "CAD": {"serie": "DEXCAUS", "por_usd": True,
            "titulo": "Canadian Dollars to One U.S. Dollar"},
    "EUR": {"serie": "DEXUSEU", "por_usd": False,
            "titulo": "U.S. Dollars to One Euro"},
    "GBP": {"serie": "DEXUSUK", "por_usd": False,
            "titulo": "U.S. Dollars to One U.K. Pound Sterling"},
    "AUD": {"serie": "DEXUSAL", "por_usd": False,
            "titulo": "U.S. Dollars to One Australian Dollar"},
    "JPY": {"serie": "DEXJPUS", "por_usd": True,
            "titulo": "Japanese Yen to One U.S. Dollar"},
    "CHF": {"serie": "DEXSZUS", "por_usd": True,
            "titulo": "Swiss Francs to One U.S. Dollar"},
    "MXN": {"serie": "DEXMXUS", "por_usd": True,
            "titulo": "Mexican Pesos to One U.S. Dollar"},
    "SEK": {"serie": "DEXSDUS", "por_usd": True,
            "titulo": "Swedish Kronor to One U.S. Dollar"},
    "NOK": {"serie": "DEXNOUS", "por_usd": True,
            "titulo": "Norwegian Kroner to One U.S. Dollar"},
    "DKK": {"serie": "DEXDNUS", "por_usd": True,
            "titulo": "Danish Kroner to One U.S. Dollar"},
    "HKD": {"serie": "DEXHKUS", "por_usd": True,
            "titulo": "Hong Kong Dollars to One U.S. Dollar"},
    "SGD": {"serie": "DEXSIUS", "por_usd": True,
            "titulo": "Singapore Dollars to One U.S. Dollar"},
    "CNY": {"serie": "DEXCHUS", "por_usd": True,
            "titulo": "Chinese Yuan Renminbi to One U.S. Dollar"},
    "INR": {"serie": "DEXINUS", "por_usd": True,
            "titulo": "Indian Rupees to One U.S. Dollar"},
    "BRL": {"serie": "DEXBZUS", "por_usd": True,
            "titulo": "Brazilian Reals to One U.S. Dollar"},
    "KRW": {"serie": "DEXKOUS", "por_usd": True,
            "titulo": "South Korean Won to One U.S. Dollar"},
}

# Bandas de cordura, en unidades de la moneda por un dólar. NO son una
# validación de mercado: son un detector de inversión. Están puestas tan
# anchas que ningún movimiento real las cruza, y aun así una serie leída del
# revés las cruza siempre — 1,37 CAD/USD invertido da 0,73, fuera de [0,9; 2,2].
#
# Donde no hay banda no se comprueba nada: prefiero no tener guarda a tener una
# que rechace un tipo legítimo por haberla ajustado de memoria.
BANDAS_POR_USD: dict[str, tuple[float, float]] = {
    "CAD": (0.9, 2.2),
    "EUR": (0.5, 1.8),
    "GBP": (0.4, 1.5),
    "AUD": (0.8, 2.5),
    "CHF": (0.5, 2.0),
    "JPY": (60.0, 400.0),
    "MXN": (8.0, 60.0),
    "SEK": (5.0, 20.0),
    "NOK": (5.0, 20.0),
    "DKK": (4.0, 12.0),
    "HKD": (6.0, 9.0),
    "SGD": (1.0, 2.2),
    "CNY": (5.0, 10.0),
    "INR": (40.0, 150.0),
    "BRL": (1.5, 12.0),
    "KRW": (700.0, 2500.0),
}

BASE = "USD"
# Un tipo de hace una semana no mueve una decisión de cartera; uno de hace un
# año sí. Por encima de esto se sigue usando pero se dice la fecha.
DIAS_FRESCO = 7


class SinTipo(Exception):
    """No hay tipo utilizable. El motivo va en el mensaje y acaba en pantalla."""


def normalizar(moneda: str | None) -> str | None:
    if not moneda or not isinstance(moneda, str):
        return None
    m = moneda.strip().upper()
    # Algunas fuentes devuelven peniques o centavos como si fueran la moneda.
    # Convertirlos como si fueran libras daría un valor 100 veces mayor, así
    # que se rechazan en vez de adivinar.
    if m in ("GBX", "GBP.", "ZAC", "ILA"):
        raise SinTipo(
            f"«{m}» son céntimos, no una moneda: convertirlo daría un valor cien "
            "veces mayor. Corrige la divisa de la posición."
        )
    return m or None


def a_por_usd(moneda: str, valor: float) -> float:
    """Pasa la observación de FRED a «unidades de `moneda` por un dólar».

    Es la única función que toca la dirección, y por eso está sola: si la
    inversión estuviera repartida por varios sitios, arreglarla en uno y no en
    otro daría una cartera que cuadra a medias.
    """
    info = SERIES.get(moneda)
    if info is None:
        raise SinTipo(f"No hay serie de FRED configurada para {moneda}.")
    if valor <= 0:
        raise SinTipo(f"Tipo no positivo para {moneda}: {valor}.")
    return valor if info["por_usd"] else 1.0 / valor


def comprobar_banda(moneda: str, por_usd: float) -> None:
    """Detector de inversión. Deja pasar cualquier movimiento real."""
    banda = BANDAS_POR_USD.get(moneda)
    if banda is None:
        return
    bajo, alto = banda
    if not (bajo <= por_usd <= alto):
        raise SinTipo(
            f"El tipo de {moneda} sale {por_usd:.4f} por dólar y lo esperable está "
            f"entre {bajo} y {alto}. Eso no es un movimiento de mercado: casi seguro "
            f"que la serie {SERIES[moneda]['serie']} está leída del revés. No se "
            "convierte nada antes que convertir mal."
        )


def tipo_desde_observaciones(moneda: str, puntos: list[dict], hoy: date | None = None) -> dict:
    """La última observación utilizable de una serie de FRED -> tipo por dólar.

    FRED publica huecos como `.` en días de fiesta, así que se busca hacia atrás
    hasta encontrar un número. Si el más reciente es viejo se usa igual y se
    dice su fecha: un tipo de hace tres días es información; uno sin fecha es un
    número suelto.
    """
    hoy = hoy or date.today()
    for punto in sorted(puntos, key=lambda p: str(p.get("ts") or ""), reverse=True):
        valor = punto.get("value")
        if valor is None:
            continue
        try:
            crudo = float(valor)
        except (TypeError, ValueError):
            continue
        if crudo <= 0:
            continue
        por_usd = a_por_usd(moneda, crudo)
        comprobar_banda(moneda, por_usd)
        try:
            fecha = date.fromisoformat(str(punto["ts"])[:10])
        except (KeyError, TypeError, ValueError):
            fecha = None
        antiguedad = (hoy - fecha).days if fecha else None
        return {
            "moneda": moneda,
            "por_usd": por_usd,
            "fecha": fecha.isoformat() if fecha else None,
            "dias": antiguedad,
            "fresco": antiguedad is not None and antiguedad <= DIAS_FRESCO,
            "serie": SERIES[moneda]["serie"],
        }
    raise SinTipo(f"La serie {SERIES[moneda]['serie']} no trae ninguna observación con valor.")


def serie_por_usd(moneda: str, puntos: list[dict]) -> list[tuple[date, float]]:
    """Toda la serie de FRED como (fecha, unidades por dólar).

    La curva de valor necesita el tipo VIGENTE en cada fecha, no el de hoy: con
    el actual aplicado a todo el histórico, una depreciación de la divisa
    desaparece del gráfico y lo que movió el cambio parece que lo movió la
    acción. Pasa por la misma comprobación de banda que el tipo puntual — una
    serie del revés lo está en todas sus observaciones, no solo en la última.
    """
    salida: list[tuple[date, float]] = []
    for punto in puntos:
        valor = punto.get("value")
        if valor is None:
            continue
        try:
            crudo = float(valor)
            fecha = date.fromisoformat(str(punto["ts"])[:10])
        except (TypeError, ValueError, KeyError):
            continue
        if crudo <= 0:
            continue
        por_usd = a_por_usd(moneda, crudo)
        salida.append((fecha, por_usd))

    if salida:
        # Basta comprobar una: si la dirección está mal, lo está entera.
        comprobar_banda(moneda, salida[len(salida) // 2][1])
    return sorted(salida)


def convertir(
    importe: float, desde: str, hacia: str, tipos: dict[str, dict]
) -> float:
    """Convierte entre dos monedas cualesquiera pasando por el dólar.

    `tipos` son «unidades por dólar» por moneda, que es la forma en que quedan
    tras `a_por_usd`. El dólar no necesita tipo: es la pata común.
    """
    if desde == hacia:
        return importe
    en_usd = importe if desde == BASE else importe / _por_usd(desde, tipos)
    return en_usd if hacia == BASE else en_usd * _por_usd(hacia, tipos)


def _por_usd(moneda: str, tipos: dict[str, dict]) -> float:
    info = tipos.get(moneda)
    if not info or not info.get("por_usd"):
        raise SinTipo(f"No hay tipo de cambio disponible para {moneda}.")
    return float(info["por_usd"])


def convertir_cartera(
    posiciones: list[dict], tipos: dict[str, dict], base: str = BASE
) -> dict:
    """Pasa cada posición a la moneda base, dejando fuera lo que no se pueda.

    Devuelve las posiciones con `market_value_base` e `invested_base`, y la
    lista de las que quedaron sin convertir con su motivo. Quien sume después
    debe sumar SOLO las convertidas — y decir cuántas no lo están.
    """
    convertidas, sin_convertir = [], []
    monedas: dict[str, float] = {}

    for p in posiciones:
        try:
            moneda = normalizar(p.get("currency")) or base
        except SinTipo as exc:
            sin_convertir.append({"symbol": p.get("symbol"), "motivo": str(exc)})
            continue

        fila = {**p, "currency": moneda}
        try:
            for campo in ("market_value", "invested"):
                valor = p.get(campo)
                fila[f"{campo}_base"] = (
                    convertir(float(valor), moneda, base, tipos) if valor is not None else None
                )
        except SinTipo as exc:
            sin_convertir.append({"symbol": p.get("symbol"), "moneda": moneda, "motivo": str(exc)})
            continue

        if fila.get("market_value_base") is not None:
            monedas[moneda] = monedas.get(moneda, 0.0) + fila["market_value_base"]
        convertidas.append(fila)

    mezcla = len(monedas) > 1
    return {
        "base": base,
        "posiciones": convertidas,
        "sin_convertir": sin_convertir,
        "monedas": {k: round(v, 2) for k, v in sorted(monedas.items(), key=lambda x: -x[1])},
        "mezcla_de_divisas": mezcla,
        "tipos_usados": {
            m: {"por_usd": round(t["por_usd"], 6), "fecha": t.get("fecha"), "serie": t.get("serie")}
            for m, t in tipos.items()
            if m in monedas
        },
        "nota": _nota(base, monedas, sin_convertir, mezcla, tipos),
    }


def _nota(
    base: str, monedas: dict[str, float], sin_convertir: list[dict], mezcla: bool, tipos: dict
) -> str:
    partes = []
    if mezcla:
        partes.append(
            f"La cartera tiene {len(monedas)} divisas ({', '.join(monedas)}) y todo "
            f"se convierte a {base} antes de sumar. Antes se sumaban sin convertir, "
            "que es un total creíble y equivocado."
        )
    else:
        unica = next(iter(monedas), base)
        partes.append(f"Toda la cartera está en {unica}: no hay nada que convertir.")

    viejos = [
        f"{m} ({t['fecha']})"
        for m, t in tipos.items()
        if m in monedas and not t.get("fresco") and t.get("fecha")
    ]
    if viejos:
        partes.append(
            f"Tipos con más de {DIAS_FRESCO} días: {', '.join(viejos)}. FRED publica "
            "con retraso y no publica fines de semana."
        )
    if sin_convertir:
        nombres = ", ".join(str(s.get("symbol")) for s in sin_convertir[:5])
        partes.append(
            f"{len(sin_convertir)} posición(es) quedan FUERA del total por no poder "
            f"convertirse ({nombres}). Un total parcial que se sabe parcial sirve; "
            "uno que se cree completo, no."
        )
    return " ".join(partes)


def inicio_de_ventana(hoy: date | None = None, dias: int = 30) -> str:
    """Desde cuándo pedirle observaciones a FRED.

    Un mes cubre de sobra puentes, fiestas y el retraso de publicación, y sigue
    siendo una respuesta pequeña.
    """
    return ((hoy or date.today()) - timedelta(days=dias)).isoformat()
