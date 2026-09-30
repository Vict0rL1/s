"""Migraciones al arrancar: la base se pone al día sola, o la app no arranca.

Sustituye a `Base.metadata.create_all()`, que creaba tablas pero nunca añadía
columnas a las que ya existían: con una base antigua, el código nuevo leía
columnas que no estaban y fallaba lejos del sitio donde estaba el problema.

La política es **fallar al arrancar antes que arrancar con un esquema que no
coincide con el código**. Un error de migración aquí para la app con un mensaje
claro; seguir adelante produciría errores sueltos en cualquier pantalla, sin
relación visible con la causa.
"""

from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory

from app.registro import log

BACKEND_DIR = Path(__file__).resolve().parent.parent.parent


def _config() -> Config:
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "migrations"))
    # El registro lo configura la app; que Alembic no lo pise con el suyo.
    cfg.attributes["sin_logging"] = True
    return cfg


def version_actual(engine) -> str | None:
    with engine.connect() as conexion:
        return MigrationContext.configure(conexion).get_current_revision()


def version_objetivo() -> str:
    return ScriptDirectory.from_config(_config()).get_current_head()


def migrar(engine) -> dict:
    """Lleva la base a la última versión. Lanza si no puede: ver el docstring."""
    antes = version_actual(engine)
    objetivo = version_objetivo()
    if antes == objetivo:
        return {"antes": antes, "despues": antes, "migrada": False}
    cfg = _config()
    with engine.begin() as conexion:
        cfg.attributes["connection"] = conexion
        command.upgrade(cfg, "head")
    despues = version_actual(engine)
    log("db").info("base migrada de %s a %s", antes or "(sin versión)", despues)
    return {"antes": antes, "despues": despues, "migrada": True}
