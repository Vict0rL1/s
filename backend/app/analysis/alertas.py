"""Evaluar alertas sin que nadie esté mirando.

Hasta ahora la evaluación vivía DENTRO del handler de `GET /api/portfolio/alerts`:
el precio se comparaba con el umbral en el momento de pintar la pestaña. Eso
significa que una alerta solo salta cuando ya estás mirando — y si estás
mirando, no necesitas la alerta. El caso que importa es el contrario: el precio
cruza el umbral un martes por la mañana y tú te enteras el jueves.

Aquí está la evaluación sola, sin HTTP, para que la pueda llamar igual el
endpoint que un cron. La app no tiene proceso en marcha y no se lo va a
inventar: lo honesto en una app local es un comando que el sistema operativo
programa, no un demonio fingido dentro de un servidor que puede estar apagado.

## Una alerta salta UNA vez

`triggered_at` se escribe la primera vez que se cumple la condición y no se
vuelve a tocar. Si se notificara en cada pasada, una alerta cumplida un lunes
mandaría un aviso cada quince minutos durante toda la semana, y a los dos días
estarían todas silenciadas — que es la única forma segura de no enterarse de la
siguiente. Para volver a armarla hay que rearmarla a mano, que es una decisión,
no un descuido.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

OPERADORES = {
    "lt": ("por debajo de", lambda precio, umbral: precio < umbral),
    "gt": ("por encima de", lambda precio, umbral: precio > umbral),
}

# Tres razones distintas para no tener veredicto, y no se pueden mezclar:
#
#   desactivada        — la apagaste tú. No hay nada que arreglar ni que avisar.
#   condicion_invalida — la condición guardada no se entiende. Es un fallo.
#   sin_precio         — no se pudo consultar. También es un fallo, pero de red.
#
# Sin esta distinción, cada alerta que desactivas aparece en el log del cron
# como «no se ha podido comprobar», y a la tercera dejas de leer el log — que es
# justo donde aparecerán las que sí están rotas.
DESACTIVADA = "desactivada"
CONDICION_INVALIDA = "condicion_invalida"
SIN_PRECIO = "sin_precio"
# Se intentó y algo se rompió: proveedores caídos tras reintentar, o una
# excepción inesperada. Distinto de SIN_PRECIO porque exige una acción distinta:
# «sin datos» es que el símbolo no cotiza; «error» es que hay que mirar qué pasa.
ERROR = "error"


def evaluar(
    alerta: dict, precio: float | None, ahora: datetime | None = None, error: str | None = None
) -> dict:
    """¿Se cumple esta alerta con este precio? Sin efectos: solo el veredicto.

    Devuelve siempre el motivo, también cuando NO se puede evaluar. Una alerta
    que no se evalúa porque falta el precio no es una alerta que no salta: es
    una alerta rota, y confundirlas es la forma de creerse cubierto sin estarlo.
    """
    ahora = ahora or datetime.now(timezone.utc)
    condicion = alerta.get("condition") or {}
    umbral = condicion.get("price")
    op = condicion.get("op")

    if not alerta.get("active", True):
        return {
            "evaluable": False,
            "cumple": False,
            "estado": DESACTIVADA,
            "motivo": f"{alerta.get('symbol')}: la alerta está desactivada",
        }
    if umbral is None or op not in OPERADORES:
        conocidos = ", ".join(sorted(OPERADORES))
        return {
            "evaluable": False,
            "cumple": False,
            "estado": CONDICION_INVALIDA,
            "motivo": (
                f"{alerta.get('symbol')}: condición no reconocida ({condicion!r}). "
                f"Hace falta un precio y un operador de: {conocidos}."
            ),
        }
    if error:
        return {
            "evaluable": False,
            "cumple": False,
            "estado": ERROR,
            "motivo": (
                f"error al comprobar {alerta.get('symbol')}: {error}. NO es «no "
                "salta»: no se ha podido mirar."
            ),
        }
    if precio is None:
        return {
            "evaluable": False,
            "cumple": False,
            "estado": SIN_PRECIO,
            "motivo": (
                f"sin precio para {alerta.get('symbol')}: no se pudo comprobar. Esto "
                "NO es «no salta», es «no se sabe»."
            ),
        }

    etiqueta, prueba = OPERADORES[op]
    cumple = prueba(precio, umbral)
    return {
        "evaluable": True,
        "cumple": cumple,
        "estado": "ok",
        "precio": precio,
        "umbral": umbral,
        "motivo": (
            f"{alerta.get('symbol')} a {precio:.2f}, {etiqueta} {umbral:.2f}"
            if cumple
            else f"{alerta.get('symbol')} a {precio:.2f}; el umbral es {umbral:.2f}"
        ),
        "comprobado_en": ahora.isoformat(),
    }


def es_nueva(alerta: dict, veredicto: dict) -> bool:
    """¿Hay que avisar? Solo en la TRANSICIÓN a cumplida.

    Sin esto, una alerta cumplida el lunes avisaría en cada pasada del cron
    durante toda la semana. A los dos días estarían todas silenciadas, que es la
    única forma segura de no enterarse de la siguiente.
    """
    return bool(veredicto.get("cumple")) and alerta.get("triggered_at") is None


def resumir(resultados: list[dict]) -> dict:
    """Qué hacer con la pasada: a quién avisar y de qué quejarse.

    Las no evaluables van aparte y CONTADAS. Meterlas con las que no saltan
    dejaría una alerta rota indistinguible de una alerta tranquila, que es
    exactamente lo que hace creerse cubierto sin estarlo.
    """
    nuevas = [r for r in resultados if r["nueva"]]
    ya_estaban = [r for r in resultados if r["veredicto"].get("cumple") and not r["nueva"]]
    apagadas = [r for r in resultados if r["veredicto"].get("estado") == DESACTIVADA]
    rotas = [
        r
        for r in resultados
        if not r["veredicto"].get("evaluable")
        and r["veredicto"].get("estado") != DESACTIVADA
    ]
    sin_datos = [r for r in rotas if r["veredicto"].get("estado") == SIN_PRECIO]
    errores = [r for r in rotas if r["veredicto"].get("estado") == ERROR]
    tranquilas = sum(
        1 for r in resultados
        if r["veredicto"].get("evaluable") and not r["veredicto"].get("cumple")
    )
    return {
        # `total` son todas las que existen; `revisadas`, las que de verdad se
        # han mirado. No es lo mismo y no pueden compartir nombre: el JSON decía
        # «revisadas: 4» mientras la frase decía «3 revisadas» en la misma
        # salida, y una de las dos sobraba.
        "total": len(resultados),
        "revisadas": len(resultados) - len(apagadas),
        "nuevas": nuevas,
        "ya_saltadas": len(ya_estaban),
        "desactivadas": len(apagadas),
        # Los tres grupos que NO son «no salta», separados: sin datos (el símbolo
        # no cotiza), errores (algo se rompió) y el total de no evaluables.
        "no_evaluables": rotas,
        "sin_datos": sin_datos,
        "errores": errores,
        "tranquilas": tranquilas,
        "resumen": _frase(nuevas, len(ya_estaban), rotas, len(apagadas), len(resultados)),
    }


def _frase(nuevas: list[dict], ya: int, rotas: list[dict], apagadas: int, total: int) -> str:
    # «Revisadas» cuenta solo las que se han mirado de verdad: sumar las
    # desactivadas daría un número tranquilizador que no corresponde a ninguna
    # comprobación.
    partes = [f"{total - apagadas} alerta(s) revisadas."]
    if nuevas:
        partes.append(
            f"{len(nuevas)} han saltado ahora: "
            + "; ".join(n["veredicto"]["motivo"] for n in nuevas[:5])
            + "."
        )
    else:
        partes.append("Ninguna nueva.")
    if ya:
        partes.append(f"{ya} ya habían saltado antes y no se vuelven a avisar.")
    if apagadas:
        partes.append(f"{apagadas} están desactivadas y no se miran.")
    if rotas:
        nombres = ", ".join(str(r.get("symbol")) for r in rotas[:5])
        n_error = sum(1 for r in rotas if r["veredicto"].get("estado") == ERROR)
        detalle = f", {n_error} por error" if n_error else ""
        partes.append(
            f"{len(rotas)} NO se han podido comprobar ({nombres}{detalle}): eso no es "
            "que no salten, es que no se sabe."
        )
    return " ".join(partes)


def texto_de_aviso(nuevas: list[dict]) -> tuple[str, str]:
    """Título y cuerpo del aviso, ya listos para el notificador del sistema.

    Corto a propósito: una notificación de escritorio se lee de reojo y se
    trunca. Lo que no cabe está en la app.
    """
    if not nuevas:
        return ("", "")
    if len(nuevas) == 1:
        v = nuevas[0]["veredicto"]
        return (f"Alerta: {nuevas[0]['symbol']}", v["motivo"])
    simbolos = ", ".join(n["symbol"] for n in nuevas[:4])
    extra = "…" if len(nuevas) > 4 else ""
    return (f"{len(nuevas)} alertas han saltado", f"{simbolos}{extra}")


# --- ¿hay algo vigilando de verdad? --------------------------------------
#
# La pestaña de alertas decía «no hay notificaciones: es una app local». Con el
# comando programado eso ya no es cierto, pero tampoco lo contrario: depende de
# si el usuario llegó a programarlo. La app no puede saberlo preguntando — puede
# saberlo mirando si alguien ha pasado por aquí. Cada pasada deja su marca y la
# pestaña dice lo que encuentre, que es la única versión que no miente en
# ninguno de los dos casos.

NOMBRE_DE_ESTADO = "ultima_revision_alertas.json"

# Margen generoso a propósito: un cron cada quince minutos que se salta una
# pasada (portátil suspendido, red caída) no debería pintarse como averiado.
CADUCA_EN = timedelta(hours=6)


def como_utc(cuando: datetime | None) -> datetime | None:
    """Marca como UTC una fecha que viene sin zona.

    SQLite no guarda la zona horaria: un `datetime` que se escribió consciente
    de estar en UTC vuelve a leerse ingenuo. Sin esto, el mismo instante se
    servía con `+00:00` justo al saltar la alerta y sin nada en cada lectura
    posterior — y un navegador interpreta lo segundo como hora LOCAL, así que
    «cumplida a las 14:30» se convertía en otra hora distinta al recargar.

    No se usa `astimezone` a secas porque sobre un ingenuo supone hora local,
    que es precisamente la suposición equivocada aquí.
    """
    if cuando is None:
        return None
    if cuando.tzinfo is None:
        return cuando.replace(tzinfo=timezone.utc)
    return cuando.astimezone(timezone.utc)


def ruta_de_estado(directorio: Path) -> Path:
    return Path(directorio) / NOMBRE_DE_ESTADO


def anotar_pasada(directorio: Path, salida: dict, ahora: datetime | None = None) -> Path:
    """Deja constancia de que el comando ha corrido. Escritura atómica.

    Se guarda poco a propósito: el detalle de cada alerta ya está en la base de
    datos. Esto solo responde «¿alguien está mirando?».
    """
    ahora = ahora or datetime.now(timezone.utc)
    ruta = ruta_de_estado(directorio)
    ruta.parent.mkdir(parents=True, exist_ok=True)
    marca = {
        "cuando": ahora.isoformat(),
        "revisadas": salida.get("revisadas", 0),
        "total": salida.get("total", 0),
        "nuevas": len(salida.get("nuevas") or []),
        "no_evaluables": len(salida.get("no_evaluables") or []),
        "resumen": salida.get("resumen", ""),
    }
    parcial = ruta.with_suffix(".parcial")
    parcial.write_text(json.dumps(marca, ensure_ascii=False), encoding="utf-8")
    os.replace(parcial, ruta)
    return ruta


def ultima_pasada(directorio: Path, ahora: datetime | None = None) -> dict:
    """Qué sabemos de la vigilancia en segundo plano. Nunca lanza.

    Devuelve `activa: False` tanto si nunca ha corrido como si la última pasada
    es vieja, y en el segundo caso lo dice — «corrió hace tres días» no es lo
    mismo que «nunca se configuró», y la solución es distinta.
    """
    ahora = ahora or datetime.now(timezone.utc)
    ruta = ruta_de_estado(directorio)
    try:
        marca = json.loads(ruta.read_text(encoding="utf-8"))
        cuando = datetime.fromisoformat(marca["cuando"])
    except (OSError, ValueError, KeyError, TypeError):
        return {
            "activa": False,
            "nunca": True,
            "nota": (
                "Nadie revisa las alertas en segundo plano: solo se evalúan cuando "
                "abres esta pestaña. Para que te avisen sin abrir la app, programa "
                "«scripts/revisar_alertas.py» en el cron (está en el README)."
            ),
        }

    cuando = como_utc(cuando)
    antiguedad = ahora - cuando
    fresca = antiguedad <= CADUCA_EN
    return {
        "activa": fresca,
        "nunca": False,
        "cuando": cuando.isoformat(),
        "hace": _hace(antiguedad),
        "revisadas": marca.get("revisadas"),
        "nuevas": marca.get("nuevas"),
        "no_evaluables": marca.get("no_evaluables"),
        "nota": (
            f"Última revisión en segundo plano hace {_hace(antiguedad)}."
            if fresca
            else (
                f"La última revisión en segundo plano fue hace {_hace(antiguedad)}. "
                "El comando está configurado pero no ha corrido: puede que la máquina "
                "estuviera apagada, o que el cron haya dejado de funcionar."
            )
        ),
    }


def _hace(delta: timedelta) -> str:
    segundos = int(max(delta.total_seconds(), 0))
    if segundos < 90:
        return "menos de un minuto" if segundos < 60 else "un minuto"
    minutos = segundos // 60
    if minutos < 60:
        return f"{minutos} minutos"
    horas = minutos // 60
    if horas < 48:
        return "una hora" if horas == 1 else f"{horas} horas"
    return f"{horas // 24} días"
