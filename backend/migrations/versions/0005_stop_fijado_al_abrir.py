"""El stop de cada posición se fija al abrirla.

Revision ID: 0005
Revises: 0004
Create Date: 2026-09-30

El stop se recalculaba cada día con la volatilidad de hoy. En una caída, la
volatilidad se dispara y el stop se aleja solo —hasta el tope del 25 %—, así
que un precio que ya había perforado el stop del día de compra seguía «por
encima del stop» y el motor decía reducir en vez de vender. El control de
riesgo tenía un camino que lo evitaba: su propio recálculo.

Las posiciones existentes quedan con `stop` NULL: no se sabe qué volatilidad
había el día que se abrieron, y reconstruirla con la de hoy sería repetir el
fallo. Para ellas el stop se sigue recalculando, y la app lo dice.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: Union[str, Sequence[str], None] = "0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    if "stop" in {c["name"] for c in sa.inspect(op.get_bind()).get_columns("positions")}:
        return
    with op.batch_alter_table("positions") as batch:
        batch.add_column(sa.Column("stop", sa.Float(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("positions") as batch:
        batch.drop_column("stop")
