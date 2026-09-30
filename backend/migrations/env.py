"""Entorno de Alembic para la app.

La URL de la base NO está en `alembic.ini`: sale de `settings.database_path`,
la misma que usa la app, para que sea imposible migrar una base y usar otra.
Quien necesite migrar una base concreta (los tests, o una copia antes de
tocar la de verdad) la pasa con `-x url=sqlite:///ruta` o con
`config.attributes["connection"]`.

`render_as_batch=True` es obligatorio con SQLite: no sabe hacer `ALTER TABLE`
para restricciones, y Alembic lo resuelve recreando la tabla y copiando los
datos. Sin esa opción, añadir un CHECK a `positions` fallaría.
"""

from __future__ import annotations

from logging.config import fileConfig

from alembic import context
from sqlalchemy import create_engine

from app.config import settings
from app.db import models  # noqa: F401  (registra las tablas en Base.metadata)
from app.db.engine import Base

config = context.config
if config.config_file_name is not None and not config.attributes.get("sin_logging"):
    fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = Base.metadata


def _url() -> str:
    x = context.get_x_argument(as_dictionary=True)
    return x.get("url") or f"sqlite:///{settings.database_path}"


def run_migrations_offline() -> None:
    context.configure(
        url=_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        render_as_batch=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    conexion = config.attributes.get("connection")
    if conexion is not None:
        _migrar(conexion)
        return
    engine = create_engine(_url())
    with engine.connect() as conexion:
        _migrar(conexion)
    engine.dispose()


def _migrar(conexion) -> None:
    context.configure(
        connection=conexion,
        target_metadata=target_metadata,
        render_as_batch=True,
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
