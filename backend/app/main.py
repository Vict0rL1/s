from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.db.engine import init_db
from app.routers import (
    etfs,
    market,
    meta,
    news,
    portfolio,
    screener,
    signals,
    stocks,
    theses,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(
    title="Análisis Bursátil",
    description=(
        "API local de investigación de acciones y ETFs. No da señales de "
        "compra ni predicciones: toda cifra lleva fuente y fecha."
    ),
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(stocks.router)
app.include_router(market.router)
app.include_router(news.router)
app.include_router(etfs.router)
app.include_router(screener.router)
app.include_router(portfolio.router)
app.include_router(portfolio.watchlist_router)
app.include_router(theses.router)
app.include_router(signals.router)
app.include_router(meta.router)
