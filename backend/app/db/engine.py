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
    # Import por efecto: registra los modelos en Base.metadata antes de crear.
    from app.db import models  # noqa: F401

    Base.metadata.create_all(engine)


def get_session():
    session: Session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
