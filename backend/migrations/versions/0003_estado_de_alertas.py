"""Estado de cada alerta: última evaluación, último resultado, último error.

Revision ID: 0003
Revises: 0002
Create Date: 2026-09-29

Antes solo se guardaba `triggered_at`. Con eso, una alerta que no había saltado
y una que llevaba tres días sin poder comprobarse eran indistinguibles en la
base: las dos tenían `triggered_at` vacío. Estas columnas son las que permiten
decir «no ha saltado, comprobada hace 12 minutos» frente a «no se ha podido
comprobar desde el martes».

Todas son NULL-ables o con valor por defecto: las alertas existentes quedan
«nunca evaluadas por el sistema nuevo», que es exactamente lo que son.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: Union[str, Sequence[str], None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


COLUMNAS = (
    sa.Column("last_evaluated_at", sa.DateTime(timezone=True), nullable=True),
    sa.Column("last_result", sa.String(length=24), nullable=True),
    sa.Column("last_error", sa.Text(), nullable=True),
    sa.Column("consecutive_errors", sa.Integer(), nullable=False, server_default="0"),
    sa.Column("error_notified_at", sa.DateTime(timezone=True), nullable=True),
)


def upgrade() -> None:
    # Idempotente, como 0001: solo añade lo que falta. Una base creada con
    # `create_all()` sobre modelos recientes ya puede tenerlas.
    existentes = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("alerts")}
    faltan = [c for c in COLUMNAS if c.name not in existentes]
    if not faltan:
        return
    with op.batch_alter_table("alerts") as batch:
        for columna in faltan:
            batch.add_column(columna)


def downgrade() -> None:
    with op.batch_alter_table("alerts") as batch:
        batch.drop_column("error_notified_at")
        batch.drop_column("consecutive_errors")
        batch.drop_column("last_error")
        batch.drop_column("last_result")
        batch.drop_column("last_evaluated_at")
