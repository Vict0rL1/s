from __future__ import annotations

from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings


class Base(DeclarativeBase):
    pass


def _make_engine(database_path: str | None = None):
    path = Path(database_path or settings.database_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    return create_engine(
        f"sqlite:///{path}",
        connect_args={"check_same_thread": False},
    )


engine = _make_engine()
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def init_db() -> None:
    """Pone la base al día con Alembic. Si no puede, la app no arranca.

    Antes era `Base.metadata.create_all(engine)`, que crea tablas pero nunca
    añade columnas a las que ya existen: con una base de una versión anterior,
    el código leía columnas que no estaban y fallaba lejos de la causa.
    """
    from app.db import models  # noqa: F401  (registra los modelos)
    from app.db.migraciones import migrar

    migrar(engine)


def get_session():
    session: Session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
