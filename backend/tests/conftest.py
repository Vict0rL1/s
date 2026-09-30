from __future__ import annotations

import os
import tempfile

# ANTES de importar nada de `app`. El motor de SQLAlchemy se construye al
# importar `app.db.engine`, con la ruta de `settings.database_path`, y los tests
# que usan `with TestClient(app)` ejecutan el `lifespan` — que hace `init_db()`
# y, desde el RC1, limpia caché y registro de llamadas. Sin esta línea, eso
# ocurría sobre `backend/data/app.db`: correr la suite borraba filas de tu base
# de datos real. Un test no puede tocar datos del usuario, ni para limpiar.
_BASE_DE_TESTS = tempfile.mkdtemp(prefix="app-tests-")
os.environ["DATABASE_PATH"] = os.path.join(_BASE_DE_TESTS, "tests.db")

import pytest  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402

from app.db.engine import Base  # noqa: E402
from app.db import models  # noqa: F401  (registra las tablas)


@pytest.fixture
def session_factory():
    """SQLite en memoria, aislado por test."""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    yield sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    engine.dispose()

