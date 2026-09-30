"""Lo que entra de fuera se comprueba aquí, antes de que nadie lo crea.

Hasta ahora no había frontera. `providers/base.py` documenta la forma de cada
payload —«-> {symbol, price, change, ..., currency}»— pero era documentación,
no un contrato: `DataRouter.fetch()` devolvía lo que el proveedor hubiera
puesto, y `CacheStore.set()` lo persistía sin mirarlo. Un `{"price": None}` o
un `{"price": NaN}` entraba, se guardaba, y se servía durante todo el TTL.

Eso es lo que convertía un fallo de una API en una decisión de inversión: los
P0-1 a P0-4 de la auditoría son todos el mismo dato corrupto viajando sin que
nadie lo parara, y los saneadores de `datos.py` los cazan uno a uno aguas abajo
— pero cazarlos aguas abajo es parchear cada desembocadura del río.

## Dos decisiones que definen el comportamiento

**Un payload inválido es un fallo del proveedor, no un dato.** Por eso la
validación vive dentro del router, entre `provider.fetch()` y el `return`: si
lo que llega no sirve, se trata como si la llamada hubiera fallado y se pasa a
la siguiente fuente. Antes, el primer proveedor con una respuesta rota ganaba.

**Lo inválido no se cachea.** Guardar un precio corrupto lo convierte en la
respuesta oficial durante horas, y el reintento que lo arreglaría no llega a
hacerse porque la caché contesta antes.

## Lo que NO hace

No comprueba que el precio sea *correcto* — eso no se puede saber desde aquí.
Comprueba que sea *utilizable*: que exista, que sea finito y que esté en un
rango donde un precio puede estar. Detectar un 150,00 que en realidad era
151,20 no es trabajo de esta capa ni de ninguna otra de esta app.
"""

from __future__ import annotations

from app import datos


class PayloadInvalido(Exception):
    """Lo que llegó del proveedor no se puede usar. El motivo va en el mensaje."""


# --- Validadores por tipo de dato ----------------------------------------
#
# Cada uno devuelve el payload (posiblemente saneado) o lanza PayloadInvalido.
# Sanear y rechazar son cosas distintas y la línea está en si lo que falta es
# el dato principal: una barra suelta corrupta se tira y se sigue; un precio
# corrupto en una cotización no deja nada que servir.


def _quote(payload: dict) -> dict:
    precio = datos.precio(payload.get("price"))
    if precio is None:
        raise PayloadInvalido(
            f"cotización sin precio utilizable (llegó {payload.get('price')!r}): "
            "ni None, ni NaN, ni cero, ni negativo sirven como precio"
        )
    saneado = {**payload, "price": precio}

    # Los acompañantes se sanean pero no tumban la respuesta: sin `change` se
    # puede vivir, sin `price` no.
    for campo in ("change", "change_pct", "prev_close"):
        if campo in saneado:
            saneado[campo] = datos.numero(saneado[campo])

    moneda = saneado.get("currency")
    if isinstance(moneda, str) and moneda.strip():
        saneado["currency"] = moneda.strip().upper()
    elif moneda is not None:
        saneado["currency"] = None
    return saneado


def _barras(payload: dict) -> dict:
    barras = payload.get("bars")
    if not isinstance(barras, list) or not barras:
        raise PayloadInvalido("histórico sin barras")

    limpias, tiradas = [], 0
    for b in barras:
        if not isinstance(b, dict):
            tiradas += 1
            continue
        cierre = datos.precio(b.get("close"))
        if cierre is None or not b.get("ts"):
            tiradas += 1
            continue
        fila = {**b, "close": cierre}
        for campo in ("open", "high", "low"):
            if campo in fila:
                fila[campo] = datos.precio(fila[campo])
        if "volume" in fila:
            # El volumen SÍ puede ser cero: un día sin negociación es un hecho.
            v = datos.numero(fila["volume"])
            fila["volume"] = v if v is not None and v >= 0 else None
        limpias.append(fila)

    if not limpias:
        raise PayloadInvalido(
            f"histórico con {len(barras)} barra(s), ninguna utilizable"
        )

    salida = {**payload, "bars": limpias}
    if tiradas:
        # Se dice cuántas se cayeron. Un histórico al que le faltan barras sin
        # avisar se lee como «esta acción no cotizó esos días».
        salida["barras_descartadas"] = tiradas
    return salida


def _fundamentales(payload: dict) -> dict:
    """Aquí casi todo puede faltar legítimamente, así que solo se sanea.

    Una empresa sin dividendo no tiene `dividend_yield`, y eso es un hecho, no
    una carencia. Lo que sí se hace es no dejar pasar NaN disfrazado de número:
    un NaN en `pe_ttm` atraviesa un filtro del screener sin que nada lo señale.
    """
    metricas = payload.get("metrics")
    if not isinstance(metricas, dict):
        return payload
    return {**payload, "metrics": {k: datos.numero(v) for k, v in metricas.items()}}


def _macro(payload: dict) -> dict:
    puntos = payload.get("points")
    if not isinstance(puntos, list):
        raise PayloadInvalido("serie macro sin puntos")
    # Los huecos de FRED (`.`) son normales y se dejan pasar como None: quien
    # consume la serie ya sabe saltárselos. Lo que se limpia es el NaN.
    return {
        **payload,
        "points": [
            {**p, "value": datos.numero(p.get("value"))}
            for p in puntos
            if isinstance(p, dict)
        ],
    }


# Partidas que por definición no pueden ser negativas. El capex entra aquí
# porque EDGAR lo da como PAGO positivo: con el signo cambiado, `cfo − capex`
# sumaría en vez de restar e inflaría el flujo libre y la valoración.
NO_NEGATIVAS = frozenset({
    "revenue", "total_assets", "total_liabilities", "current_assets",
    "current_liabilities", "cash", "long_term_debt", "short_term_debt",
    "capex", "interest_expense", "depreciation_amortization",
})
# Y las que tienen que ser estrictamente positivas.
POSITIVAS = frozenset({"shares_outstanding"})
_NO_NUMERICAS = frozenset({"fiscal_year", "end_date", "filed", "filed_at", "form", "accession_no"})


def _financieros(payload: dict) -> dict:
    """Estados financieros anuales: se sanean partida a partida.

    Lo que no puede ser verdad —un NaN, un signo imposible, cero acciones— se
    deja en None y se cuenta. No se corrige el signo: un capex negativo puede
    ser un error de signo o una etiqueta XBRL que significa otra cosa, y
    adivinar entre las dos es inventar.
    """
    periodos = payload.get("periods")
    if not isinstance(periodos, list) or not periodos:
        raise PayloadInvalido("estados financieros sin periodos")

    limpios, descartadas = [], 0
    for periodo in periodos:
        if not isinstance(periodo, dict) or not periodo.get("fiscal_year"):
            continue
        fila = {}
        for clave, valor in periodo.items():
            if clave in _NO_NUMERICAS or valor is None or isinstance(valor, str) and clave.endswith(("_date", "_at")):
                fila[clave] = valor
                continue
            numero = datos.numero(valor)
            if numero is not None and clave in NO_NEGATIVAS and numero < 0:
                numero = None
            if numero is not None and clave in POSITIVAS and numero <= 0:
                numero = None
            if numero is None:
                descartadas += 1
            fila[clave] = numero
        limpios.append(fila)

    if not limpios:
        raise PayloadInvalido("estados financieros sin ningún ejercicio identificable")
    salida = {**payload, "periods": limpios}
    if descartadas:
        # Se dice cuántas partidas se tiraron: un balance al que le falta la
        # deuda porque venía rota no puede parecer uno de una empresa sin deuda.
        salida["partidas_descartadas"] = descartadas
    return salida


VALIDADORES = {
    "financials": _financieros,
    "quote": _quote,
    "price_history": _barras,
    "price_history_long": _barras,
    "fundamentals": _fundamentales,
    "macro": _macro,
}


def validar(data_type: str, payload: dict) -> dict:
    """El payload saneado, o `PayloadInvalido` si no hay nada que salvar.

    Un tipo sin validador pasa tal cual: noticias, filings o perfiles no
    alimentan ningún cálculo de riesgo, y validar por validar añade un sitio
    donde equivocarse sin añadir seguridad.
    """
    if not isinstance(payload, dict):
        raise PayloadInvalido(f"el proveedor devolvió {type(payload).__name__}, no un dict")
    validador = VALIDADORES.get(data_type)
    return validador(payload) if validador else payload
