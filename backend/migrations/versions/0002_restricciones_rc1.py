"""Restricciones de integridad del RC1.

Revision ID: 0002
Revises: 0001
Create Date: 2026-09-29

Una posición con cantidad cero o negativa, o con coste negativo, no describe
nada que pueda existir, y cada cálculo que la toca —valor, P&L, peso, riesgo—
produce basura sin avisar. La API ya lo rechazaba; la base no, así que
cualquier otro camino de escritura (un script, una importación) podía colarla.

## Si ya hay filas que las violan, la migración NO las borra

Se niega a seguir y dice cuáles son. Borrar datos del usuario para que una
restricción pase sería exactamente el tipo de «arreglo» silencioso que este
trabajo persigue: la posición desaparecería del libro sin que nadie lo
decidiera. Corregirlas es una decisión tuya.

SQLite no sabe añadir un CHECK con `ALTER TABLE`; `batch_alter_table` recrea la
tabla y copia las filas. Los datos se conservan: hay un test que lo comprueba.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: Union[str, Sequence[str], None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    malas = op.get_bind().execute(
        sa.text("SELECT id, quantity, cost_basis FROM positions "
                "WHERE quantity <= 0 OR cost_basis < 0")
    ).fetchall()
    if malas:
        detalle = ", ".join(f"#{i} (cantidad {q}, coste {c})" for i, q, c in malas[:10])
        raise RuntimeError(
            f"Hay {len(malas)} posición(es) que no pueden existir: {detalle}. La "
            "migración no las borra —sería eliminar datos tuyos sin que lo "
            "decidas—. Corrígelas o bórralas a mano y vuelve a arrancar."
        )
    with op.batch_alter_table("positions") as batch:
        batch.create_check_constraint("ck_positions_cantidad_positiva", "quantity > 0")
        batch.create_check_constraint("ck_positions_coste_no_negativo", "cost_basis >= 0")


def downgrade() -> None:
    with op.batch_alter_table("positions") as batch:
        batch.drop_constraint("ck_positions_coste_no_negativo", type_="check")
        batch.drop_constraint("ck_positions_cantidad_positiva", type_="check")
