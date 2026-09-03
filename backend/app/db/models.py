"""Modelos ORM — esquema completo aprobado en la fase de diseño.

Las tablas de fases futuras (tesis, escenarios, screener, etc.) se definen ya
para que el esquema sea estable desde el inicio; las fases posteriores las
llenan. Toda fila que provenga de una API externa guarda `source` y
`fetched_at`: ninguna cifra circula sin origen ni fecha.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.engine import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# Infraestructura de datos
# ---------------------------------------------------------------------------

class ApiCache(Base):
    """Caché genérico de respuestas de APIs externas, con TTL."""

    __tablename__ = "api_cache"
    __table_args__ = (
        UniqueConstraint("provider", "endpoint", "params_hash", name="uq_cache_key"),
        Index("ix_cache_expires", "expires_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    provider: Mapped[str] = mapped_column(String(32))
    endpoint: Mapped[str] = mapped_column(String(128))
    params_hash: Mapped[str] = mapped_column(String(64))
    payload: Mapped[dict] = mapped_column(JSON)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ApiCallLog(Base):
    """Registro de cada llamada real a una API externa.

    Alimenta el contador visible de llamadas restantes por proveedor y el
    control de rate limit del router de fuentes.
    """

    __tablename__ = "api_call_log"
    __table_args__ = (Index("ix_call_log_provider_time", "provider", "called_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    provider: Mapped[str] = mapped_column(String(32))
    endpoint: Mapped[str] = mapped_column(String(128))
    called_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    status: Mapped[str] = mapped_column(String(16), default="ok")  # ok | error | rate_limited


# ---------------------------------------------------------------------------
# Mercado y fundamentales
# ---------------------------------------------------------------------------

class Instrument(Base):
    __tablename__ = "instruments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    symbol: Mapped[str] = mapped_column(String(16), unique=True, index=True)
    name: Mapped[str | None] = mapped_column(String(128))
    type: Mapped[str] = mapped_column(String(8), default="stock")  # stock | etf
    exchange: Mapped[str | None] = mapped_column(String(32))
    sector: Mapped[str | None] = mapped_column(String(64))
    industry: Mapped[str | None] = mapped_column(String(64))
    currency: Mapped[str | None] = mapped_column(String(8))
    last_refreshed: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PriceBar(Base):
    __tablename__ = "price_bars"
    __table_args__ = (
        UniqueConstraint("instrument_id", "interval", "ts", name="uq_bar"),
        Index("ix_bars_lookup", "instrument_id", "interval", "ts"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    instrument_id: Mapped[int] = mapped_column(ForeignKey("instruments.id"))
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    interval: Mapped[str] = mapped_column(String(8))  # 1day, 1week, 1month, 1h...
    open: Mapped[float] = mapped_column(Float)
    high: Mapped[float] = mapped_column(Float)
    low: Mapped[float] = mapped_column(Float)
    close: Mapped[float] = mapped_column(Float)
    volume: Mapped[float | None] = mapped_column(Float)
    source: Mapped[str] = mapped_column(String(32))
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class FundamentalsSnapshot(Base):
    __tablename__ = "fundamentals_snapshots"
    __table_args__ = (Index("ix_fund_lookup", "instrument_id", "as_of"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    instrument_id: Mapped[int] = mapped_column(ForeignKey("instruments.id"))
    as_of: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    period: Mapped[str] = mapped_column(String(16), default="ttm")  # ttm | annual | quarterly
    data: Mapped[dict] = mapped_column(JSON)
    source: Mapped[str] = mapped_column(String(32))
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Filing(Base):
    __tablename__ = "filings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    instrument_id: Mapped[int] = mapped_column(ForeignKey("instruments.id"), index=True)
    type: Mapped[str] = mapped_column(String(16))  # 10-K, 10-Q, 8-K, 3, 4, 5
    filed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    accession_no: Mapped[str] = mapped_column(String(32), unique=True)
    url: Mapped[str] = mapped_column(String(512))
    summary: Mapped[str | None] = mapped_column(Text)


class InsiderTransaction(Base):
    __tablename__ = "insider_transactions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    instrument_id: Mapped[int] = mapped_column(ForeignKey("instruments.id"), index=True)
    filer: Mapped[str] = mapped_column(String(128))
    role: Mapped[str | None] = mapped_column(String(64))
    type: Mapped[str] = mapped_column(String(8))  # buy | sell
    shares: Mapped[float | None] = mapped_column(Float)
    price: Mapped[float | None] = mapped_column(Float)
    filed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    source: Mapped[str] = mapped_column(String(32), default="edgar")


class NewsItem(Base):
    __tablename__ = "news_items"
    __table_args__ = (Index("ix_news_published", "published_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    headline: Mapped[str] = mapped_column(String(512))
    summary: Mapped[str | None] = mapped_column(Text)
    url: Mapped[str] = mapped_column(String(1024))
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    source: Mapped[str] = mapped_column(String(64))
    sentiment: Mapped[float | None] = mapped_column(Float)  # puntuación de la API, no nuestra
    tickers: Mapped[list | None] = mapped_column(JSON)


class MacroSeries(Base):
    __tablename__ = "macro_series"
    __table_args__ = (UniqueConstraint("series_id", "ts", name="uq_macro_point"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    series_id: Mapped[str] = mapped_column(String(32), index=True)  # id FRED, p.ej. DGS10
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    value: Mapped[float | None] = mapped_column(Float)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class EtfHolding(Base):
    __tablename__ = "etf_holdings"
    __table_args__ = (Index("ix_holdings_etf", "etf_instrument_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    etf_instrument_id: Mapped[int] = mapped_column(ForeignKey("instruments.id"))
    holding_symbol: Mapped[str] = mapped_column(String(16))
    holding_name: Mapped[str | None] = mapped_column(String(128))
    weight: Mapped[float | None] = mapped_column(Float)  # fracción 0-1
    as_of: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    source: Mapped[str] = mapped_column(String(32))


# ---------------------------------------------------------------------------
# Trabajo del usuario: watchlist, portafolio, tesis, registro de aciertos
# ---------------------------------------------------------------------------

class Watchlist(Base):
    __tablename__ = "watchlists"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class WatchlistItem(Base):
    __tablename__ = "watchlist_items"
    __table_args__ = (
        UniqueConstraint("watchlist_id", "instrument_id", name="uq_watchlist_item"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    watchlist_id: Mapped[int] = mapped_column(ForeignKey("watchlists.id"))
    instrument_id: Mapped[int] = mapped_column(ForeignKey("instruments.id"))
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    notes: Mapped[str | None] = mapped_column(Text)


class Position(Base):
    __tablename__ = "positions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    instrument_id: Mapped[int] = mapped_column(ForeignKey("instruments.id"), index=True)
    quantity: Mapped[float] = mapped_column(Float)
    cost_basis: Mapped[float] = mapped_column(Float)  # por acción, en moneda del instrumento
    opened_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    realized_pnl: Mapped[float | None] = mapped_column(Float)


class Alert(Base):
    __tablename__ = "alerts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    instrument_id: Mapped[int] = mapped_column(ForeignKey("instruments.id"), index=True)
    kind: Mapped[str] = mapped_column(String(16))  # price | event
    condition: Mapped[dict] = mapped_column(JSON)  # p.ej. {"op": "lt", "price": 150}
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    triggered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Thesis(Base):
    __tablename__ = "theses"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    instrument_id: Mapped[int] = mapped_column(ForeignKey("instruments.id"), index=True)
    title: Mapped[str] = mapped_column(String(256))
    body_md: Mapped[str] = mapped_column(Text)
    assumptions: Mapped[dict | None] = mapped_column(JSON)
    invalidation_criteria: Mapped[str | None] = mapped_column(Text)  # qué me haría cambiar de opinión
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Scenario(Base):
    """Escenario bajista/base/alcista con supuestos explícitos y editables.

    Guarda el precio al momento de creación: es la base del registro de
    aciertos — sin ese ancla no se puede evaluar cómo envejeció.
    """

    __tablename__ = "scenarios"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    thesis_id: Mapped[int | None] = mapped_column(ForeignKey("theses.id"))
    instrument_id: Mapped[int] = mapped_column(ForeignKey("instruments.id"), index=True)
    kind: Mapped[str] = mapped_column(String(8))  # bear | base | bull
    assumptions: Mapped[dict] = mapped_column(JSON)  # crecimiento, WACC, tasa terminal...
    value_low: Mapped[float | None] = mapped_column(Float)
    value_mid: Mapped[float | None] = mapped_column(Float)
    value_high: Mapped[float | None] = mapped_column(Float)
    price_at_creation: Mapped[float | None] = mapped_column(Float)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ThesisTrigger(Base):
    """Un punto de invalidación que la app PUEDE vigilar sola.

    `Thesis.invalidation_criteria` es texto libre y sirve para pensar, pero nadie
    lo vigila: «si los márgenes se deterioran» no es comprobable. Esto es la
    versión ejecutable — métrica, operador y umbral— para que el sistema pueda
    mirarla cada vez que hay datos nuevos.

    Las dos formas conviven a propósito. El texto captura el matiz que ningún
    umbral recoge; el disparador captura lo que se puede automatizar. Obligar a
    que todo fuera numérico dejaría fuera la mitad de las razones por las que uno
    cambia de opinión.
    """

    __tablename__ = "thesis_triggers"
    __table_args__ = (Index("ix_trigger_thesis", "thesis_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    thesis_id: Mapped[int] = mapped_column(ForeignKey("theses.id"), index=True)
    kind: Mapped[str] = mapped_column(String(16))  # metrica | crecimiento | noticia
    descripcion: Mapped[str] = mapped_column(Text)  # por qué esto invalida la tesis
    # metrica/crecimiento: {"metrica": "operating_margin", "op": "lt", "umbral": 0.18}
    # noticia:            {"palabras": ["recall", "investigación"]}
    config: Mapped[dict] = mapped_column(JSON)
    activo: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    # Cuándo saltó por última vez, para no repetir el mismo aviso cada carga.
    last_fired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Decision(Base):
    """Una decisión tomada, con el razonamiento DE ENTONCES.

    El valor entero de esto está en la última parte. Reconstruir seis meses
    después por qué compraste algo es imposible: la memoria reescribe el pasado
    para que encaje con lo que pasó después, y uno acaba recordando que «siempre
    tuvo dudas» sobre lo que salió mal.

    Por eso se guarda también `contexto`: el precio, los disparadores que estaban
    saltando y la tesis vigente en ese momento. No es lo que recuerdas que sabías
    — es lo que la app te estaba enseñando cuando decidiste.
    """

    __tablename__ = "decisions"
    __table_args__ = (Index("ix_decision_symbol_date", "symbol", "created_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    symbol: Mapped[str] = mapped_column(String(16), index=True)
    thesis_id: Mapped[int | None] = mapped_column(ForeignKey("theses.id"))
    accion: Mapped[str] = mapped_column(String(16))  # comprar|vender|reforzar|reducir|mantener|descartar
    razonamiento: Mapped[str] = mapped_column(Text)  # obligatorio: sin porqué no hay registro
    price_at_decision: Mapped[float | None] = mapped_column(Float)
    quantity: Mapped[float | None] = mapped_column(Float)
    contexto: Mapped[dict | None] = mapped_column(JSON)  # lo que la app enseñaba entonces
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Evaluation(Base):
    """Registro de aciertos: compara periódicamente escenario vs. realidad."""

    __tablename__ = "evaluations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    scenario_id: Mapped[int | None] = mapped_column(ForeignKey("scenarios.id"))
    thesis_id: Mapped[int | None] = mapped_column(ForeignKey("theses.id"))
    evaluated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    price_at_evaluation: Mapped[float | None] = mapped_column(Float)
    outcome_notes: Mapped[str | None] = mapped_column(Text)


class ScreenerPreset(Base):
    __tablename__ = "screener_presets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(64), unique=True)
    logic_md: Mapped[str | None] = mapped_column(Text)  # cada preset documenta su lógica
    filters: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class LlmOutput(Base):
    """Todo lo generado por LLM queda registrado y marcado como IA."""

    __tablename__ = "llm_outputs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    kind: Mapped[str] = mapped_column(String(32))  # news_summary | thesis_note | ...
    instrument_id: Mapped[int | None] = mapped_column(ForeignKey("instruments.id"))
    prompt_hash: Mapped[str | None] = mapped_column(String(64))
    content_md: Mapped[str] = mapped_column(Text)
    model: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class EarningsAnalysis(Base):
    """Un reporte trimestral extraído, con su fuente y su verificación.

    Se guarda por `accession_no` —el identificador que la SEC da a cada filing y
    que no se reutiliza jamás— para que el análisis quede atado al documento
    exacto del que salió. Un análisis de resultados sin su documento es una
    opinión anónima; con él, cualquiera puede ir a comprobarlo.

    `datos` guarda la extracción completa con la MISMA forma cada trimestre: es
    lo que permite comparar en el tiempo en vez de leer prosa distinta cada vez.
    """

    __tablename__ = "earnings_analyses"
    __table_args__ = (
        UniqueConstraint("accession_no", "kind", name="uq_earnings_filing"),
        Index("ix_earnings_symbol_date", "symbol", "filed_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    symbol: Mapped[str] = mapped_column(String(16), index=True)
    kind: Mapped[str] = mapped_column(String(16), default="extraccion")  # extraccion | comparacion
    form_type: Mapped[str] = mapped_column(String(16))  # 10-Q | 10-K | 8-K
    accession_no: Mapped[str] = mapped_column(String(32))
    source_url: Mapped[str] = mapped_column(String(512))
    filed_at: Mapped[str] = mapped_column(String(16))  # ISO date tal como la da EDGAR
    doc_hash: Mapped[str] = mapped_column(String(32))  # versión exacta del texto analizado
    datos: Mapped[dict] = mapped_column(JSON)
    verificacion: Mapped[dict | None] = mapped_column(JSON)
    model: Mapped[str] = mapped_column(String(64))
    usage: Mapped[dict | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Experiment(Base):
    """Cada estrategia probada, con su hipótesis y su resultado.

    Existe para poder contar. El Sharpe deflactado necesita saber cuántas veces
    se miró, y sin registro esa cuenta es una estimación sentimental y siempre a
    la baja: las variantes descartadas se olvidan a los dos días. Un experimento
    que no se escribe no deja de haber ocurrido — solo deja de descontarse.
    """

    __tablename__ = "experiments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    hipotesis: Mapped[str] = mapped_column(Text)
    estrategia: Mapped[str] = mapped_column(String(64), index=True)
    parametros: Mapped[dict] = mapped_column(JSON)
    periodo_desde: Mapped[str] = mapped_column(String(10))
    periodo_hasta: Mapped[str] = mapped_column(String(10))
    universo: Mapped[dict] = mapped_column(JSON)
    resultado: Mapped[dict] = mapped_column(JSON)
    # Sharpe por periodo (no anualizado): es la unidad que usa el DSR.
    sharpe: Mapped[float | None] = mapped_column(Float)
    # Un experimento sobre el holdout se marca para siempre. La cuenta de
    # aperturas es el dato que impide fingir que solo se miró una vez.
    uso_holdout: Mapped[bool] = mapped_column(Boolean, default=False)
    notas: Mapped[str | None] = mapped_column(Text)
