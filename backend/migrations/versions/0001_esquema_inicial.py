"""Esquema inicial: el de la app tal como estaba al introducir Alembic.

Revision ID: 0001
Revises:
Create Date: 2026-09-29

Hasta aquí el esquema lo creaba `Base.metadata.create_all()` al arrancar, que
tiene un fallo conocido: **crea tablas, pero nunca añade columnas a una tabla
que ya existe**. Una base creada con una versión antigua de la app se quedaba
sin las columnas nuevas y el código fallaba al leerlas — un cambio de esquema
silencioso, que es justo lo que Alembic existe para evitar.

Por eso esta migración no es un `create_table` a ciegas. Es IDEMPOTENTE:

- tabla que no existe → se crea entera;
- tabla que existe → se le AÑADEN las columnas que le falten (NULL-ables,
  porque sus filas antiguas no tienen valor), y se registra cuáles;
- índice que no existe → se crea.

Nunca borra ni modifica nada que ya esté. Sirve igual para una base vacía, para
una creada ayer con `create_all()` y para una de hace meses. Por eso no se usa
`alembic stamp`: marcar una base antigua como «ya en 0001» sin comprobarla
sería mentirle a Alembic sobre qué columnas tiene.

Las tablas están escritas aquí (autogeneradas y congeladas), no importadas de
`app.db.models`: una migración describe el esquema de SU momento, y si
importara los modelos cambiaría cada vez que cambian ellos.
"""
from typing import Sequence, Union

import logging

import sqlalchemy as sa
from alembic import op

revision: str = "0001"
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

log = logging.getLogger("app.db")


def _crear_o_reparar(nombre: str, *elementos, **kw) -> None:
    insp = sa.inspect(op.get_bind())
    if not insp.has_table(nombre):
        op.create_table(nombre, *elementos, **kw)
        return
    existentes = {c["name"] for c in insp.get_columns(nombre)}
    for el in elementos:
        if isinstance(el, sa.Column) and el.name not in existentes:
            # NULL-able: las filas que ya están no tienen valor para ella, y un
            # NOT NULL sin defecto haría fallar el ALTER. Se registra para que la
            # reparación no sea otro cambio silencioso.
            op.add_column(nombre, sa.Column(el.name, el.type, nullable=True))
            log.warning("migración 0001: añadida la columna %s.%s que faltaba", nombre, el.name)


def _indice(tabla: str, nombre: str, columnas: list[str], unique: bool = False) -> None:
    insp = sa.inspect(op.get_bind())
    if nombre not in {i["name"] for i in insp.get_indexes(tabla)}:
        op.create_index(nombre, tabla, columnas, unique=unique)


def upgrade() -> None:
    """Crea lo que falta y repara lo que se quedó atrás. Nunca borra."""
    _crear_o_reparar('api_cache',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('provider', sa.String(length=32), nullable=False),
    sa.Column('endpoint', sa.String(length=128), nullable=False),
    sa.Column('params_hash', sa.String(length=64), nullable=False),
    sa.Column('payload', sa.JSON(), nullable=False),
    sa.Column('fetched_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('provider', 'endpoint', 'params_hash', name='uq_cache_key')
    )
    _indice('api_cache', 'ix_cache_expires', ['expires_at'], unique=False)

    _crear_o_reparar('api_call_log',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('provider', sa.String(length=32), nullable=False),
    sa.Column('endpoint', sa.String(length=128), nullable=False),
    sa.Column('called_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.PrimaryKeyConstraint('id')
    )
    _indice('api_call_log', 'ix_call_log_provider_time', ['provider', 'called_at'], unique=False)

    _crear_o_reparar('earnings_analyses',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('symbol', sa.String(length=16), nullable=False),
    sa.Column('kind', sa.String(length=16), nullable=False),
    sa.Column('form_type', sa.String(length=16), nullable=False),
    sa.Column('accession_no', sa.String(length=32), nullable=False),
    sa.Column('source_url', sa.String(length=512), nullable=False),
    sa.Column('filed_at', sa.String(length=16), nullable=False),
    sa.Column('doc_hash', sa.String(length=32), nullable=False),
    sa.Column('datos', sa.JSON(), nullable=False),
    sa.Column('verificacion', sa.JSON(), nullable=True),
    sa.Column('model', sa.String(length=64), nullable=False),
    sa.Column('usage', sa.JSON(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('accession_no', 'kind', name='uq_earnings_filing')
    )
    _indice('earnings_analyses', 'ix_earnings_analyses_symbol', ['symbol'], unique=False)
    _indice('earnings_analyses', 'ix_earnings_symbol_date', ['symbol', 'filed_at'], unique=False)

    _crear_o_reparar('experiments',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('hipotesis', sa.Text(), nullable=False),
    sa.Column('estrategia', sa.String(length=64), nullable=False),
    sa.Column('parametros', sa.JSON(), nullable=False),
    sa.Column('periodo_desde', sa.String(length=10), nullable=False),
    sa.Column('periodo_hasta', sa.String(length=10), nullable=False),
    sa.Column('universo', sa.JSON(), nullable=False),
    sa.Column('resultado', sa.JSON(), nullable=False),
    sa.Column('sharpe', sa.Float(), nullable=True),
    sa.Column('uso_holdout', sa.Boolean(), nullable=False),
    sa.Column('notas', sa.Text(), nullable=True),
    sa.PrimaryKeyConstraint('id')
    )
    _indice('experiments', 'ix_experiments_estrategia', ['estrategia'], unique=False)

    _crear_o_reparar('instruments',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('symbol', sa.String(length=16), nullable=False),
    sa.Column('name', sa.String(length=128), nullable=True),
    sa.Column('type', sa.String(length=8), nullable=False),
    sa.Column('exchange', sa.String(length=32), nullable=True),
    sa.Column('sector', sa.String(length=64), nullable=True),
    sa.Column('industry', sa.String(length=64), nullable=True),
    sa.Column('currency', sa.String(length=8), nullable=True),
    sa.Column('last_refreshed', sa.DateTime(timezone=True), nullable=True),
    sa.PrimaryKeyConstraint('id')
    )
    _indice('instruments', 'ix_instruments_symbol', ['symbol'], unique=True)

    _crear_o_reparar('macro_series',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('series_id', sa.String(length=32), nullable=False),
    sa.Column('ts', sa.DateTime(timezone=True), nullable=False),
    sa.Column('value', sa.Float(), nullable=True),
    sa.Column('fetched_at', sa.DateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('series_id', 'ts', name='uq_macro_point')
    )
    _indice('macro_series', 'ix_macro_series_series_id', ['series_id'], unique=False)

    _crear_o_reparar('news_items',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('headline', sa.String(length=512), nullable=False),
    sa.Column('summary', sa.Text(), nullable=True),
    sa.Column('url', sa.String(length=1024), nullable=False),
    sa.Column('published_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('source', sa.String(length=64), nullable=False),
    sa.Column('sentiment', sa.Float(), nullable=True),
    sa.Column('tickers', sa.JSON(), nullable=True),
    sa.PrimaryKeyConstraint('id')
    )
    _indice('news_items', 'ix_news_published', ['published_at'], unique=False)

    _crear_o_reparar('options_snapshots',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('symbol', sa.String(length=16), nullable=False),
    sa.Column('fecha', sa.String(length=10), nullable=False),
    sa.Column('creado_en', sa.DateTime(timezone=True), nullable=False),
    sa.Column('spot', sa.Float(), nullable=True),
    sa.Column('iv_30d', sa.Float(), nullable=True),
    sa.Column('rv_30d', sa.Float(), nullable=True),
    sa.Column('prima', sa.Float(), nullable=True),
    sa.Column('skew_25d', sa.Float(), nullable=True),
    sa.Column('volumen_total', sa.Integer(), nullable=True),
    sa.Column('oi_total', sa.Integer(), nullable=True),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('symbol', 'fecha', name='uq_options_snapshot_dia')
    )
    _indice('options_snapshots', 'ix_options_snapshots_symbol', ['symbol'], unique=False)
    _indice('options_snapshots', 'ix_options_symbol_fecha', ['symbol', 'fecha'], unique=False)

    _crear_o_reparar('screener_presets',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('name', sa.String(length=64), nullable=False),
    sa.Column('logic_md', sa.Text(), nullable=True),
    sa.Column('filters', sa.JSON(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('name')
    )
    _crear_o_reparar('watchlists',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('name', sa.String(length=64), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('name')
    )
    _crear_o_reparar('alerts',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('instrument_id', sa.Integer(), nullable=False),
    sa.Column('kind', sa.String(length=16), nullable=False),
    sa.Column('condition', sa.JSON(), nullable=False),
    sa.Column('active', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('triggered_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['instrument_id'], ['instruments.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    _indice('alerts', 'ix_alerts_instrument_id', ['instrument_id'], unique=False)

    _crear_o_reparar('etf_holdings',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('etf_instrument_id', sa.Integer(), nullable=False),
    sa.Column('holding_symbol', sa.String(length=16), nullable=False),
    sa.Column('holding_name', sa.String(length=128), nullable=True),
    sa.Column('weight', sa.Float(), nullable=True),
    sa.Column('as_of', sa.DateTime(timezone=True), nullable=True),
    sa.Column('source', sa.String(length=32), nullable=False),
    sa.ForeignKeyConstraint(['etf_instrument_id'], ['instruments.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    _indice('etf_holdings', 'ix_holdings_etf', ['etf_instrument_id'], unique=False)

    _crear_o_reparar('filings',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('instrument_id', sa.Integer(), nullable=False),
    sa.Column('type', sa.String(length=16), nullable=False),
    sa.Column('filed_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('accession_no', sa.String(length=32), nullable=False),
    sa.Column('url', sa.String(length=512), nullable=False),
    sa.Column('summary', sa.Text(), nullable=True),
    sa.ForeignKeyConstraint(['instrument_id'], ['instruments.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('accession_no')
    )
    _indice('filings', 'ix_filings_instrument_id', ['instrument_id'], unique=False)

    _crear_o_reparar('fundamentals_snapshots',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('instrument_id', sa.Integer(), nullable=False),
    sa.Column('as_of', sa.DateTime(timezone=True), nullable=False),
    sa.Column('period', sa.String(length=16), nullable=False),
    sa.Column('data', sa.JSON(), nullable=False),
    sa.Column('source', sa.String(length=32), nullable=False),
    sa.Column('fetched_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['instrument_id'], ['instruments.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    _indice('fundamentals_snapshots', 'ix_fund_lookup', ['instrument_id', 'as_of'], unique=False)

    _crear_o_reparar('insider_transactions',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('instrument_id', sa.Integer(), nullable=False),
    sa.Column('filer', sa.String(length=128), nullable=False),
    sa.Column('role', sa.String(length=64), nullable=True),
    sa.Column('type', sa.String(length=8), nullable=False),
    sa.Column('shares', sa.Float(), nullable=True),
    sa.Column('price', sa.Float(), nullable=True),
    sa.Column('filed_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('source', sa.String(length=32), nullable=False),
    sa.ForeignKeyConstraint(['instrument_id'], ['instruments.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    _indice('insider_transactions', 'ix_insider_transactions_instrument_id', ['instrument_id'], unique=False)

    _crear_o_reparar('llm_outputs',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('kind', sa.String(length=32), nullable=False),
    sa.Column('instrument_id', sa.Integer(), nullable=True),
    sa.Column('prompt_hash', sa.String(length=64), nullable=True),
    sa.Column('content_md', sa.Text(), nullable=False),
    sa.Column('model', sa.String(length=64), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['instrument_id'], ['instruments.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    _crear_o_reparar('positions',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('instrument_id', sa.Integer(), nullable=False),
    sa.Column('quantity', sa.Float(), nullable=False),
    sa.Column('cost_basis', sa.Float(), nullable=False),
    sa.Column('opened_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('closed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('realized_pnl', sa.Float(), nullable=True),
    sa.ForeignKeyConstraint(['instrument_id'], ['instruments.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    _indice('positions', 'ix_positions_instrument_id', ['instrument_id'], unique=False)

    _crear_o_reparar('price_bars',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('instrument_id', sa.Integer(), nullable=False),
    sa.Column('ts', sa.DateTime(timezone=True), nullable=False),
    sa.Column('interval', sa.String(length=8), nullable=False),
    sa.Column('open', sa.Float(), nullable=False),
    sa.Column('high', sa.Float(), nullable=False),
    sa.Column('low', sa.Float(), nullable=False),
    sa.Column('close', sa.Float(), nullable=False),
    sa.Column('volume', sa.Float(), nullable=True),
    sa.Column('source', sa.String(length=32), nullable=False),
    sa.Column('fetched_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['instrument_id'], ['instruments.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('instrument_id', 'interval', 'ts', name='uq_bar')
    )
    _indice('price_bars', 'ix_bars_lookup', ['instrument_id', 'interval', 'ts'], unique=False)

    _crear_o_reparar('theses',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('instrument_id', sa.Integer(), nullable=False),
    sa.Column('title', sa.String(length=256), nullable=False),
    sa.Column('body_md', sa.Text(), nullable=False),
    sa.Column('assumptions', sa.JSON(), nullable=True),
    sa.Column('invalidation_criteria', sa.Text(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['instrument_id'], ['instruments.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    _indice('theses', 'ix_theses_instrument_id', ['instrument_id'], unique=False)

    _crear_o_reparar('watchlist_items',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('watchlist_id', sa.Integer(), nullable=False),
    sa.Column('instrument_id', sa.Integer(), nullable=False),
    sa.Column('added_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('notes', sa.Text(), nullable=True),
    sa.ForeignKeyConstraint(['instrument_id'], ['instruments.id'], ),
    sa.ForeignKeyConstraint(['watchlist_id'], ['watchlists.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('watchlist_id', 'instrument_id', name='uq_watchlist_item')
    )
    _crear_o_reparar('decisions',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('symbol', sa.String(length=16), nullable=False),
    sa.Column('thesis_id', sa.Integer(), nullable=True),
    sa.Column('accion', sa.String(length=16), nullable=False),
    sa.Column('razonamiento', sa.Text(), nullable=False),
    sa.Column('price_at_decision', sa.Float(), nullable=True),
    sa.Column('quantity', sa.Float(), nullable=True),
    sa.Column('contexto', sa.JSON(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['thesis_id'], ['theses.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    _indice('decisions', 'ix_decision_symbol_date', ['symbol', 'created_at'], unique=False)
    _indice('decisions', 'ix_decisions_symbol', ['symbol'], unique=False)

    _crear_o_reparar('scenarios',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('thesis_id', sa.Integer(), nullable=True),
    sa.Column('instrument_id', sa.Integer(), nullable=False),
    sa.Column('kind', sa.String(length=8), nullable=False),
    sa.Column('assumptions', sa.JSON(), nullable=False),
    sa.Column('value_low', sa.Float(), nullable=True),
    sa.Column('value_mid', sa.Float(), nullable=True),
    sa.Column('value_high', sa.Float(), nullable=True),
    sa.Column('price_at_creation', sa.Float(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['instrument_id'], ['instruments.id'], ),
    sa.ForeignKeyConstraint(['thesis_id'], ['theses.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    _indice('scenarios', 'ix_scenarios_instrument_id', ['instrument_id'], unique=False)

    _crear_o_reparar('thesis_triggers',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('thesis_id', sa.Integer(), nullable=False),
    sa.Column('kind', sa.String(length=16), nullable=False),
    sa.Column('descripcion', sa.Text(), nullable=False),
    sa.Column('config', sa.JSON(), nullable=False),
    sa.Column('activo', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('last_fired_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['thesis_id'], ['theses.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    _indice('thesis_triggers', 'ix_thesis_triggers_thesis_id', ['thesis_id'], unique=False)
    _indice('thesis_triggers', 'ix_trigger_thesis', ['thesis_id'], unique=False)

    _crear_o_reparar('evaluations',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('scenario_id', sa.Integer(), nullable=True),
    sa.Column('thesis_id', sa.Integer(), nullable=True),
    sa.Column('evaluated_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('price_at_evaluation', sa.Float(), nullable=True),
    sa.Column('outcome_notes', sa.Text(), nullable=True),
    sa.ForeignKeyConstraint(['scenario_id'], ['scenarios.id'], ),
    sa.ForeignKeyConstraint(['thesis_id'], ['theses.id'], ),
    sa.PrimaryKeyConstraint('id')
    )


def downgrade() -> None:
    """No se deshace el esquema inicial: sería borrar todos tus datos.

    Un `downgrade` a «antes de 0001» significa eliminar cada tabla, y con ellas
    posiciones, tesis y decisiones. Ninguna operación de mantenimiento debería
    poder hacer eso por un comando mal escrito. Si de verdad se quiere empezar
    de cero, se borra el fichero de la base a mano, sabiendo lo que se hace.
    """
    raise RuntimeError(
        "La migración 0001 no se deshace: eliminaría todas las tablas y tus datos. "
        "Para empezar de cero, borra el fichero de la base a mano."
    )
