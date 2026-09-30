"""Registro por categorías: que un fallo diga de qué tipo es.

La Fase 12 del RC1 pedía poder distinguir, en los logs, nueve clases de fallo
que hasta ahora eran indistinguibles — o, más a menudo, invisibles: la app casi
no escribía logs, y los pocos que había mezclaban un proveedor caído con un
error de cálculo bajo el mismo nombre de módulo.

La solución es deliberadamente aburrida: un logger por categoría, con nombre
fijo bajo `app.`. Así se puede filtrar (`grep app.proveedor`), subir el nivel de
una sola categoría, o mandarla a otro sitio, sin inventar un framework.

    app.proveedor   la API respondió mal, tardó o se agotó el límite
    app.validacion  llegó algo que no se puede usar (NaN, negativo, vacío)
    app.dato        el dato no existe, o es viejo y se sirvió marcado
    app.calculo     una fórmula no pudo evaluarse (división por cero, etc.)
    app.db          lectura o escritura en la base de datos
    app.cache       rescate de dato viejo, limpieza, entradas corruptas
    app.alertas     evaluación de alertas y notificaciones
    app.llm         llamadas al modelo de lenguaje
    app.riesgo      un control de riesgo que no pudo aplicarse

La última no estaba en la lista de la fase, pero es la que más importa: un
límite de riesgo que no se ejecutó tiene que dejar rastro también fuera de la
pantalla, porque la pantalla no la está mirando nadie a las tres de la mañana.
"""

from __future__ import annotations

import logging
import os

CATEGORIAS = (
    "proveedor",
    "validacion",
    "dato",
    "calculo",
    "db",
    "cache",
    "alertas",
    "llm",
    "riesgo",
)

FORMATO = "%(asctime)s %(levelname)-7s %(name)-15s %(message)s"


def log(categoria: str) -> logging.Logger:
    """El logger de una categoría. Una categoría desconocida es un error de código."""
    if categoria not in CATEGORIAS:
        raise ValueError(f"Categoría de registro desconocida: {categoria!r}")
    return logging.getLogger(f"app.{categoria}")


def configurar(nivel: str | None = None) -> None:
    """Configura el registro raíz de la app. Idempotente.

    El nivel sale de `APP_LOG_LEVEL` (INFO por defecto). No toca el registro de
    otras librerías: yfinance, en particular, escribe mucho y no es nuestro.
    """
    nivel = (nivel or os.environ.get("APP_LOG_LEVEL") or "INFO").upper()
    raiz = logging.getLogger("app")
    raiz.setLevel(nivel)
    if not any(getattr(h, "_app_registro", False) for h in raiz.handlers):
        manejador = logging.StreamHandler()
        manejador.setFormatter(logging.Formatter(FORMATO))
        manejador._app_registro = True  # type: ignore[attr-defined]
        raiz.addHandler(manejador)
        raiz.propagate = False
