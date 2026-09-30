"""Instantáneas de decisión y sus resultados, inmutables.

Revision ID: 0004
Revises: 0003
Create Date: 2026-09-29

Dos tablas para el forward testing:

- `decision_snapshots`: lo que el motor decidió, con todo lo que vio, congelado.
- `decision_outcomes`: cómo salió, medido después, en filas NUEVAS.

La inmutabilidad es la razón de ser de las dos, y aquí se hace cumplir en la
propia base con triggers: ni la app ni un script ni una consola de SQLite
pueden modificar o borrar una instantánea, ni reescribir un resultado ya
medido. Si se pudiera, el registro dejaría de medir lo que el sistema sabía y
pasaría a medir lo que alguien quiso que supiera.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: Union[str, Sequence[str], None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TRIGGERS = (
    """CREATE TRIGGER IF NOT EXISTS snapshot_no_se_modifica
       BEFORE UPDATE ON decision_snapshots
       BEGIN SELECT RAISE(ABORT, 'decision_snapshots es inmutable: lo posterior va en decision_outcomes'); END""",
    """CREATE TRIGGER IF NOT EXISTS snapshot_no_se_borra
       BEFORE DELETE ON decision_snapshots
       BEGIN SELECT RAISE(ABORT, 'decision_snapshots no se borra: es el registro del sistema'); END""",
    """CREATE TRIGGER IF NOT EXISTS outcome_no_se_modifica
       BEFORE UPDATE ON decision_outcomes
       BEGIN SELECT RAISE(ABORT, 'decision_outcomes solo admite filas nuevas'); END""",
)


def _existe(tabla: str) -> bool:
    return sa.inspect(op.get_bind()).has_table(tabla)


def _indice(tabla: str, nombre: str, columnas: list[str], unique: bool = False) -> None:
    if nombre not in {i["name"] for i in sa.inspect(op.get_bind()).get_indexes(tabla)}:
        op.create_index(nombre, tabla, columnas, unique=unique)


def upgrade() -> None:
    if not _existe('decision_snapshots'):
      op.create_table('decision_snapshots',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('creado_en', sa.DateTime(timezone=True), nullable=False),
    sa.Column('fecha', sa.String(length=10), nullable=False),
    sa.Column('origen', sa.String(length=32), nullable=False),
    sa.Column('symbol', sa.String(length=16), nullable=False),
    sa.Column('accion', sa.String(length=16), nullable=False),
    sa.Column('score', sa.Float(), nullable=True),
    sa.Column('precio', sa.Float(), nullable=True),
    sa.Column('moneda', sa.String(length=8), nullable=True),
    sa.Column('stop', sa.Float(), nullable=True),
    sa.Column('objetivo', sa.Float(), nullable=True),
    sa.Column('peso_bruto_pct', sa.Float(), nullable=True),
    sa.Column('peso_final_pct', sa.Float(), nullable=True),
    sa.Column('horizonte_dias', sa.Integer(), nullable=False),
    sa.Column('reglas_version', sa.String(length=16), nullable=False),
    sa.Column('contexto', sa.JSON(), nullable=False),
    sa.Column('huella', sa.String(length=64), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('symbol', 'fecha', 'origen', name='uq_snapshot_simbolo_dia')
    )
    _indice('decision_snapshots', 'ix_decision_snapshots_symbol', ['symbol'], unique=False)
    _indice('decision_snapshots', 'ix_snapshot_fecha', ['fecha'], unique=False)

    if not _existe('decision_outcomes'):
      op.create_table('decision_outcomes',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('snapshot_id', sa.Integer(), nullable=False),
    sa.Column('evaluado_en', sa.DateTime(timezone=True), nullable=False),
    sa.Column('dias', sa.Integer(), nullable=False),
    sa.Column('precio', sa.Float(), nullable=True),
    sa.Column('retorno_pct', sa.Float(), nullable=True),
    sa.Column('estado', sa.String(length=16), nullable=False),
    sa.Column('detalle', sa.JSON(), nullable=True),
    sa.ForeignKeyConstraint(['snapshot_id'], ['decision_snapshots.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    _indice('decision_outcomes', 'ix_outcome_snapshot', ['snapshot_id', 'evaluado_en'], unique=False)

    for sql in TRIGGERS:
        op.execute(sql)



def downgrade() -> None:
    """Solo si no hay nada que perder.

    Bajar de versión borraría el registro de forward testing entero. Si ya hay
    instantáneas, se niega: ese registro no se puede reconstruir después, porque
    reconstruirlo exigiría saber hoy lo que el sistema sabía entonces.
    """
    n = op.get_bind().execute(sa.text("SELECT COUNT(*) FROM decision_snapshots")).scalar()
    if n:
        raise RuntimeError(
            f"Hay {n} instantánea(s) de decisión. Deshacer 0004 las borraría y el "
            "registro de forward testing no se puede reconstruir. No se deshace."
        )
    for trigger in ("outcome_no_se_modifica", "snapshot_no_se_borra", "snapshot_no_se_modifica"):
        op.execute(f"DROP TRIGGER IF EXISTS {trigger}")
    op.drop_index("ix_outcome_snapshot", table_name="decision_outcomes")
    op.drop_table("decision_outcomes")
    op.drop_index("ix_snapshot_fecha", table_name="decision_snapshots")
    op.drop_index("ix_decision_snapshots_symbol", table_name="decision_snapshots")
    op.drop_table("decision_snapshots")
