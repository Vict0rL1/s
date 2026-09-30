"""Instantáneas de decisión: congelar, reconstruir, medir después.

Esto es lo que hace posible el forward testing. Un backtest dice cómo le habría
ido a unas reglas sobre datos pasados; no dice cómo le va al sistema que
realmente estás usando, con sus datos incompletos, sus proveedores caídos y
sus límites que a veces no se pueden comprobar. Para eso hace falta anotar lo
que el sistema dijo EN EL MOMENTO y compararlo después con lo que pasó.

Tres reglas que no se negocian:

1. **Lo que se congela es lo que el motor vio**, entero: la señal con sus
   factores, el precio con su fuente, fecha y estado, las razones, lo que
   faltaba, el tamaño y qué límites de riesgo se pudieron aplicar. No un
   resumen: un resumen decide de antemano qué será relevante después.

2. **Una instantánea no se toca jamás.** Si se pudiera reescribir con lo que
   pasó después, el registro dejaría de medir lo que el sistema sabía. La base
   lo impide con triggers y el ORM con eventos; aquí, además, cada instantánea
   lleva una huella SHA-256 de su contenido para detectar cualquier cambio.

3. **El resultado va aparte y solo se añade.** `DecisionOutcome` recibe filas
   nuevas; nunca se recalibra una decisión antigua con resultados futuros.

La primera instantánea del día por símbolo y origen gana. Si la lista se
recalcula por la tarde con más empresas puntuadas, lo que ya se congeló por la
mañana no cambia — la mañana es lo que se vio por la mañana.
"""

from __future__ import annotations

import hashlib
import json
import math
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import datos
from app.analysis import decision as motor
from app.analysis import risk_budget, sizing
from app.db.models import DecisionOutcome, DecisionSnapshot
from app.registro import log

# Horizonte de evaluación, en días naturales. Las reglas no fijan un plazo; el
# forward testing necesita uno para cerrar la cuenta de cada decisión, y medio
# año es el orden de magnitud en que un stop de 8-25 % o un objetivo del doble
# suelen resolverse. Es una convención de medida, y se congela con cada
# instantánea para que cambiarla luego no reescriba lo ya medido.
HORIZONTE_DIAS = 182

ACCIONES_CONGELADAS = {"comprar", "vender", "reducir", "evitar"}


# --- Versión de las reglas ------------------------------------------------


def parametros_de_reglas() -> dict:
    """Todos los números que deciden una acción o un tamaño, con nombre."""
    return {
        "decision": {
            "riesgo_por_operacion": motor.RIESGO_POR_OPERACION,
            "topes_stop": {k: list(v) for k, v in motor.TOPES_STOP.items()},
            "stop_volatilidades": motor.STOP_VOLATILIDADES,
            "ratio_objetivo": motor.RATIO_OBJETIVO,
            "banda_entrada_pct": motor.BANDA_ENTRADA_PCT,
            "banda_tendencia_entrar_pct": motor.BANDA_TENDENCIA_ENTRAR_PCT,
            "banda_tendencia_salir_pct": motor.BANDA_TENDENCIA_SALIR_PCT,
        },
        "sizing": {
            "max_por_posicion_pct": sizing.MAX_POR_POSICION_PCT,
            "max_por_sector_pct": sizing.MAX_POR_SECTOR_PCT,
            "max_por_cluster_pct": sizing.MAX_POR_CLUSTER_PCT,
            "umbral_correlacion": sizing.UMBRAL_CORRELACION,
            "objetivo_vol_anual_pct": sizing.OBJETIVO_VOL_ANUAL_PCT,
            "vol_supuesta_pct": sizing.VOL_SUPUESTA_PCT,
            "correlacion_supuesta": sizing.CORRELACION_SUPUESTA,
        },
        "riesgo": {
            "heat_maximo_pct": risk_budget.HEAT_MAXIMO_PCT,
            "heat_grupo_maximo_pct": risk_budget.HEAT_GRUPO_MAXIMO_PCT,
        },
        "horizonte_dias": HORIZONTE_DIAS,
    }


def version_de_reglas() -> str:
    """12 caracteres que cambian si cambia CUALQUIER parámetro de las reglas.

    Sirve para no comparar peras con manzanas: dos instantáneas con versiones
    distintas se tomaron con reglas distintas, y sus resultados no se agregan
    como si fueran el mismo sistema.
    """
    return _huella(parametros_de_reglas())[:12]


# --- Congelar --------------------------------------------------------------


def _limpio(valor):
    """JSON válido: NaN e infinitos a None. Un NaN en el registro no es un dato."""
    if isinstance(valor, float) and not math.isfinite(valor):
        return None
    if isinstance(valor, dict):
        return {str(k): _limpio(v) for k, v in valor.items()}
    if isinstance(valor, (list, tuple)):
        return [_limpio(v) for v in valor]
    if isinstance(valor, (date, datetime)):
        return valor.isoformat()
    return valor


def _huella(contenido: dict) -> str:
    canonico = json.dumps(contenido, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonico.encode()).hexdigest()


def congelar(
    session: Session,
    senal: dict,
    *,
    origen: str,
    ahora: datetime,
    sizing_ctx: dict | None = None,
    peso_final_pct: float | None = None,
    mercado: dict | None = None,
) -> DecisionSnapshot | None:
    """Congela UNA decisión. Devuelve None si ya había una hoy (la primera gana).

    No hace commit: quien llama decide cuándo, para congelar una lista entera
    de una vez o no congelar nada.
    """
    decision = senal.get("decision") or {}
    accion = decision.get("action")
    symbol = senal.get("symbol")
    if not symbol or accion not in ACCIONES_CONGELADAS:
        return None

    fecha = ahora.astimezone(timezone.utc).date().isoformat()
    ya = session.execute(
        select(DecisionSnapshot.id).where(
            DecisionSnapshot.symbol == symbol,
            DecisionSnapshot.fecha == fecha,
            DecisionSnapshot.origen == origen,
        )
    ).first()
    if ya:
        return None

    precio = senal.get("price") or {}
    niveles = decision.get("levels") or {}
    contexto = _limpio(
        {
            "senal": senal,
            "sizing": sizing_ctx,
            "mercado": mercado,
            "reglas": parametros_de_reglas(),
        }
    )
    snap = DecisionSnapshot(
        creado_en=ahora,
        fecha=fecha,
        origen=origen,
        symbol=symbol,
        accion=accion,
        score=datos.numero(senal.get("score")),
        precio=datos.precio(precio.get("last")),
        # Los universos de la lista diaria cotizan todos en dólares: lo fija
        # `test_todos_los_universos_de_la_lista_diaria_cotizan_en_dolares`. Si la
        # señal trae su propia moneda, manda la señal.
        moneda=precio.get("currency") or "USD",
        stop=datos.precio(niveles.get("stop")),
        objetivo=datos.precio(niveles.get("objetivo")),
        peso_bruto_pct=datos.numero(niveles.get("peso_bruto_pct")),
        peso_final_pct=datos.numero(peso_final_pct),
        horizonte_dias=HORIZONTE_DIAS,
        reglas_version=version_de_reglas(),
        contexto=contexto,
        huella=_huella(contexto),
    )
    session.add(snap)
    return snap


def congelar_lista_diaria(session: Session, payload: dict, origen: str, ahora: datetime) -> dict:
    """Congela lo accionable de una lista diaria. Nunca lanza.

    Qué se congela: las ideas de la lista corta (con su tamaño final y los
    límites que se pudieron aplicar), lo que la lista corta dice evitar, y cada
    posición tuya para la que el motor dice vender o reducir. Son las
    afirmaciones del sistema que se pueden contrastar después.

    Si la escritura falla, la lista se sirve igual y el fallo queda dicho en la
    respuesta y en el registro: perder un día del forward testing es un
    problema, pero dejar al usuario sin su lista por eso sería peor.
    """
    corta = payload.get("shortlist") or {}
    sz = corta.get("sizing") or {}
    sizing_ctx = {
        k: sz.get(k)
        for k in (
            "controles", "todos_los_limites_aplicados", "recortes", "escala_aplicada",
            "vol_estimada_pct", "objetivo_vol_pct", "clusters", "cartera_actual",
            "aviso_cartera", "invertido_total_pct",
        )
    }
    mercado = {
        "market": payload.get("market"),
        "completo": payload.get("complete"),
        "puntuadas": payload.get("scored"),
        "pedidas": payload.get("requested"),
        "calibrado": payload.get("calibrated"),
        "no_disponibles": len(payload.get("unavailable") or []),
    }

    candidatas = [(s, s.get("peso_final_pct"), sizing_ctx) for s in corta.get("ideas") or []]
    candidatas += [(s, None, None) for s in corta.get("evitar") or []]
    candidatas += [
        (s, None, None)
        for s in payload.get("signals") or []
        if (s.get("decision") or {}).get("owned")
        and (s.get("decision") or {}).get("action") in ("vender", "reducir")
    ]

    guardadas, ya = 0, 0
    try:
        for senal, peso, ctx in candidatas:
            snap = congelar(
                session, senal, origen=origen, ahora=ahora,
                sizing_ctx=ctx, peso_final_pct=peso, mercado=mercado,
            )
            if snap is None:
                ya += 1
            else:
                guardadas += 1
        session.commit()
    except (IntegrityError, ValueError, TypeError) as exc:
        session.rollback()
        log("db").error("no se pudieron congelar las decisiones de %s: %s", origen, exc)
        return {"guardadas": 0, "ya_existian": ya, "error": str(exc)[:300]}
    return {"guardadas": guardadas, "ya_existian": ya, "error": None}


# --- Reconstruir -----------------------------------------------------------


def reconstruir(snap: DecisionSnapshot, resultados: list[DecisionOutcome] | None = None) -> dict:
    """«¿Por qué el sistema dijo esto aquel día?», solo con lo congelado."""
    ctx = snap.contexto or {}
    senal = ctx.get("senal") or {}
    decision = senal.get("decision") or {}
    precio = senal.get("price") or {}
    integra = _huella(ctx) == snap.huella
    return {
        "id": snap.id,
        "fecha": snap.fecha,
        "creado_en": snap.creado_en.isoformat() if snap.creado_en else None,
        "origen": snap.origen,
        "symbol": snap.symbol,
        "accion": snap.accion,
        "score": snap.score,
        "precio": {
            "valor": snap.precio,
            "moneda": snap.moneda,
            "fuente": precio.get("source"),
            "fecha": precio.get("as_of"),
            "estado": precio.get("estado"),
        },
        "razones": decision.get("reasons") or [],
        "disparadores": decision.get("triggers") or [],
        "faltaban": decision.get("faltan") or [],
        "confianza": decision.get("confidence"),
        "niveles": {"stop": snap.stop, "objetivo": snap.objetivo},
        "tamano": {
            "peso_bruto_pct": snap.peso_bruto_pct,
            "peso_final_pct": snap.peso_final_pct,
            "limites": (ctx.get("sizing") or {}).get("controles"),
            "todos_los_limites_aplicados": (ctx.get("sizing") or {}).get("todos_los_limites_aplicados"),
        },
        "mercado": ctx.get("mercado"),
        "reglas_version": snap.reglas_version,
        "horizonte_dias": snap.horizonte_dias,
        "integridad": {
            "huella_coincide": integra,
            "nota": None if integra else (
                "El contenido NO coincide con su huella: esta instantánea se ha "
                "modificado después de congelarse. No es fiable como registro."
            ),
        },
        "resultados": [
            {
                "evaluado_en": r.evaluado_en.isoformat() if r.evaluado_en else None,
                "dias": r.dias,
                "precio": r.precio,
                "retorno_pct": r.retorno_pct,
                "estado": r.estado,
            }
            for r in (resultados or [])
        ],
    }


# --- Medir después ---------------------------------------------------------


def evaluar_resultado(snap: DecisionSnapshot, cierres: list[tuple[date, float]], hoy: date) -> dict:
    """Qué pasó desde la instantánea. Puro: no toca la base.

    Para una compra: el primer cierre que toca el stop o el objetivo cierra la
    cuenta; si no, al llegar al horizonte se cierra con el último cierre; antes,
    está «abierta». Se usan cierres, no mínimos intradía, porque es lo que el
    histórico gratuito trae; se dice en `detalle`.

    Para vender, reducir o evitar: se mide qué hizo el precio después. Una
    caída es un acierto de esas decisiones; por eso el retorno se da tal cual y
    `a_favor` dice en qué dirección cuenta.
    """
    inicio = date.fromisoformat(snap.fecha)
    limite = inicio + timedelta(days=snap.horizonte_dias)
    posteriores = sorted(
        (d, datos.precio(c)) for d, c in cierres if d > inicio and datos.precio(c) is not None
    )
    base = datos.precio(snap.precio)
    detalle = {"base": "cierres diarios, no mínimos ni máximos intradía"}
    if base is None or not posteriores:
        return {"estado": "sin_datos", "precio": None, "retorno_pct": None,
                "dias": (hoy - inicio).days, "detalle": detalle}

    compra = snap.accion == "comprar"
    for d, c in posteriores:
        if d > limite:
            break
        if compra and snap.stop and c <= snap.stop:
            return _cierre("stop", d, c, base, inicio, detalle, compra)
        if compra and snap.objetivo and c >= snap.objetivo:
            return _cierre("objetivo", d, c, base, inicio, detalle, compra)

    dentro = [(d, c) for d, c in posteriores if d <= limite]
    ultimo_d, ultimo_c = dentro[-1] if dentro else posteriores[0]
    estado = "horizonte" if hoy >= limite else "abierta"
    return _cierre(estado, ultimo_d, ultimo_c, base, inicio, detalle, compra)


def _cierre(estado, d, c, base, inicio, detalle, compra) -> dict:
    retorno = (c / base - 1) * 100
    return {
        "estado": estado,
        "precio": c,
        "retorno_pct": round(retorno, 2),
        "dias": (d - inicio).days,
        "detalle": {**detalle, "fecha_precio": d.isoformat(),
                    "a_favor": "subida" if compra else "bajada"},
    }


CERRADOS = {"stop", "objetivo", "horizonte"}


def registrar_resultado(session: Session, snap: DecisionSnapshot, resultado: dict, ahora: datetime) -> DecisionOutcome | None:
    """Añade una fila de resultado. Nunca modifica una anterior.

    No añade nada si la instantánea ya está cerrada (stop, objetivo u
    horizonte), ni más de una fila «abierta» por día.
    """
    previos = session.execute(
        select(DecisionOutcome).where(DecisionOutcome.snapshot_id == snap.id)
        .order_by(DecisionOutcome.evaluado_en)
    ).scalars().all()
    if any(p.estado in CERRADOS for p in previos):
        return None
    hoy = ahora.date()
    if resultado["estado"] in ("abierta", "sin_datos") and any(
        p.evaluado_en and p.evaluado_en.date() == hoy for p in previos
    ):
        return None
    fila = DecisionOutcome(
        snapshot_id=snap.id,
        evaluado_en=ahora,
        dias=resultado["dias"],
        precio=resultado["precio"],
        retorno_pct=resultado["retorno_pct"],
        estado=resultado["estado"],
        detalle=resultado["detalle"],
    )
    session.add(fila)
    return fila
