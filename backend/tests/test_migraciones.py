"""Migraciones: la base se pone al día sin perder ni una fila.

Lo que se prueba aquí no es que Alembic funcione, sino las dos promesas que
hace esta app sobre SUS migraciones:

1. **Una base antigua se repara, no se da por buena.** La app creaba el esquema
   con `create_all()`, que nunca añadía columnas a tablas ya existentes; una base
   de hace meses puede no tener columnas que el código lee. La migración 0001 las
   añade.

2. **Nada se borra para que una migración pase.** Si hay filas que violan una
   restricción nueva, la migración se niega y dice cuáles; no las elimina.

Todas las bases de estos tests son ficheros temporales. Ninguno toca
`backend/data/app.db`.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import IntegrityError

from app.db.engine import Base
from app.db.migraciones import migrar, version_actual, version_objetivo


def _base_antigua(ruta, *, sin_columna=True, posicion_mala=False):
    """Una base como la dejaba `create_all()`: sin versión y con datos dentro."""
    engine = create_engine(f"sqlite:///{ruta}")
    Base.metadata.create_all(engine)
    ahora = datetime.now(timezone.utc).isoformat()
    with engine.begin() as c:
        # Quitar las restricciones y una columna simula una base de una versión
        # anterior: `create_all` no las habría añadido nunca.
        c.execute(text("ALTER TABLE positions RENAME TO positions_nueva"))
        c.execute(text(
            "CREATE TABLE positions (id INTEGER PRIMARY KEY, instrument_id INTEGER, "
            "quantity FLOAT, cost_basis FLOAT, opened_at DATETIME, closed_at DATETIME, "
            "realized_pnl FLOAT)"
        ))
        c.execute(text("DROP TABLE positions_nueva"))
        if sin_columna:
            c.execute(text("ALTER TABLE instruments DROP COLUMN currency"))
        c.execute(text("INSERT INTO instruments (id, symbol, name, type) VALUES (1, 'AAPL', 'Apple', 'stock')"))
        c.execute(text(
            "INSERT INTO positions (id, instrument_id, quantity, cost_basis, opened_at) "
            f"VALUES (1, 1, 10, 150.5, '{ahora}')"
        ))
        if posicion_mala:
            c.execute(text(
                "INSERT INTO positions (id, instrument_id, quantity, cost_basis, opened_at) "
                f"VALUES (2, 1, 0, 100, '{ahora}')"
            ))
        c.execute(text(
            "INSERT INTO theses (id, instrument_id, title, body_md, created_at, updated_at) "
            f"VALUES (1, 1, 'Tesis', 'Por qué', '{ahora}', '{ahora}')"
        ))
        c.execute(text(
            "INSERT INTO alerts (id, instrument_id, kind, condition, active, created_at) "
            f"VALUES (1, 1, 'price', '{{\"op\": \"lt\", \"price\": 140}}', 1, '{ahora}')"
        ))
    return engine


def _filas(engine, tabla):
    with engine.connect() as c:
        return c.execute(text(f"SELECT * FROM {tabla} ORDER BY id")).mappings().all()


def test_una_base_vacia_llega_a_la_ultima_version(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'vacia.db'}")
    r = migrar(engine)
    assert r["migrada"] and r["despues"] == version_objetivo()
    assert "positions" in inspect(engine).get_table_names()


def test_una_base_antigua_con_datos_se_migra_sin_perder_nada(tmp_path):
    engine = _base_antigua(tmp_path / "antigua.db")
    antes = {t: [dict(f) for f in _filas(engine, t)] for t in ("instruments", "positions", "theses", "alerts")}
    assert version_actual(engine) is None

    migrar(engine)

    assert version_actual(engine) == version_objetivo()
    for tabla, filas in antes.items():
        despues = [dict(f) for f in _filas(engine, tabla)]
        assert len(despues) == len(filas), f"{tabla}: se perdieron filas"
        for a, d in zip(filas, despues):
            for k, v in a.items():
                assert d[k] == v, f"{tabla}.{k} cambió de {v!r} a {d[k]!r}"


def test_la_columna_que_faltaba_se_anade(tmp_path):
    """El fallo de `create_all()`: nunca añadía columnas. Aquí se repara."""
    engine = _base_antigua(tmp_path / "antigua.db", sin_columna=True)
    assert "currency" not in {c["name"] for c in inspect(engine).get_columns("instruments")}
    migrar(engine)
    assert "currency" in {c["name"] for c in inspect(engine).get_columns("instruments")}
    # Y la fila que ya estaba conserva sus datos, con la columna nueva vacía.
    fila = _filas(engine, "instruments")[0]
    assert fila["symbol"] == "AAPL" and fila["currency"] is None


def test_tras_migrar_las_restricciones_se_aplican(tmp_path):
    engine = _base_antigua(tmp_path / "antigua.db")
    migrar(engine)
    with pytest.raises(IntegrityError):
        with engine.begin() as c:
            c.execute(text(
                "INSERT INTO positions (instrument_id, quantity, cost_basis, opened_at) "
                "VALUES (1, 0, 10, '2026-01-01')"
            ))


def test_una_fila_que_viola_la_restriccion_para_la_migracion_y_no_se_borra(tmp_path):
    engine = _base_antigua(tmp_path / "mala.db", posicion_mala=True)
    with pytest.raises(RuntimeError) as exc:
        migrar(engine)
    assert "#2" in str(exc.value)
    assert "no las borra" in str(exc.value)
    # La fila sigue ahí: corregirla es decisión del usuario.
    assert len(_filas(engine, "positions")) == 2


def test_migrar_dos_veces_no_hace_nada_la_segunda(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'x.db'}")
    migrar(engine)
    assert migrar(engine)["migrada"] is False


def test_bajar_de_0002_a_0001_conserva_los_datos(tmp_path):
    from alembic import command

    from app.db.migraciones import _config

    engine = _base_antigua(tmp_path / "antigua.db")
    migrar(engine)
    cfg = _config()
    with engine.begin() as c:
        cfg.attributes["connection"] = c
        command.downgrade(cfg, "0001")
    assert version_actual(engine) == "0001"
    assert len(_filas(engine, "positions")) == 1
    assert _filas(engine, "positions")[0]["cost_basis"] == 150.5


def test_la_migracion_inicial_no_se_deshace(tmp_path):
    """Deshacer 0001 sería borrar todas las tablas: se niega."""
    from alembic import command

    from app.db.migraciones import _config

    engine = create_engine(f"sqlite:///{tmp_path / 'x.db'}")
    migrar(engine)
    cfg = _config()
    with pytest.raises(RuntimeError, match="no se deshace"):
        with engine.begin() as c:
            cfg.attributes["connection"] = c
            command.downgrade(cfg, "base")


def test_el_esquema_migrado_coincide_con_los_modelos(tmp_path):
    """Si alguien cambia un modelo sin escribir su migración, esto lo caza."""
    from alembic.autogenerate import compare_metadata
    from alembic.runtime.migration import MigrationContext

    engine = create_engine(f"sqlite:///{tmp_path / 'x.db'}")
    migrar(engine)
    with engine.connect() as c:
        diferencias = compare_metadata(MigrationContext.configure(c), Base.metadata)
    assert diferencias == [], f"modelo y migraciones divergen: {diferencias}"
