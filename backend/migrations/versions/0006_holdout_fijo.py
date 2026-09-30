"""Corte fijo del holdout.

Revision ID: 0006
Revises: 0005
Create Date: 2026-09-30

El holdout se definía por ejecución como el último 30 % de la ventana pedida,
así que con ventanas distintas el corte se movía y parte de un holdout acababa
siendo desarrollo en otra ejecución. Esta tabla guarda el corte la primera vez
que se fija; desde entonces no se mueve.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0006"
down_revision: Union[str, Sequence[str], None] = "0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    if sa.inspect(op.get_bind()).has_table("holdout_corte"):
        return
    op.create_table(
        "holdout_corte",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("corte", sa.String(length=10), nullable=False),
        sa.Column("definido_en", sa.DateTime(timezone=True), nullable=False),
        sa.Column("motivo", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    """Solo si nunca se fijó: bajar de versión movería el holdout."""
    n = op.get_bind().execute(sa.text("SELECT COUNT(*) FROM holdout_corte")).scalar()
    if n:
        raise RuntimeError(
            "El corte del holdout ya está fijado. Deshacer 0006 lo borraría y el "
            "siguiente backtest podría fijar otro — que es mover el holdout."
        )
    op.drop_table("holdout_corte")
