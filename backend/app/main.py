from __future__ import annotations

from contextlib import asynccontextmanager

import math

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.db.engine import SessionLocal, init_db
from app.mantenimiento import mantener
from app.registro import configurar as configurar_registro
from app.routers import (
    deep_dive,
    earnings,
    etfs,
    market,
    meta,
    news,
    options,
    portfolio,
    screener,
    signals,
    snapshots,
    stocks,
    theses,
    valuation,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    configurar_registro()
    init_db()
    # Limpieza al arrancar. `mantener` no lanza: un fallo aquí no puede
    # impedir que la app arranque.
    mantener(SessionLocal)
    yield


app = FastAPI(
    title="Análisis Bursátil",
    description=(
        "API local de investigación de acciones y ETFs. No da señales de "
        "compra ni predicciones: toda cifra lleva fuente y fecha."
    ),
    lifespan=lifespan,
)



def _sin_no_finitos(valor):
    """Sustituye NaN e infinitos por su texto, para que se puedan serializar."""
    if isinstance(valor, float) and not math.isfinite(valor):
        return str(valor)
    if isinstance(valor, dict):
        return {k: _sin_no_finitos(v) for k, v in valor.items()}
    if isinstance(valor, (list, tuple)):
        return [_sin_no_finitos(v) for v in valor]
    return valor


@app.exception_handler(RequestValidationError)
async def _error_de_validacion(request: Request, exc: RequestValidationError) -> JSONResponse:
    """El 422 de siempre, pero que no revienta con un `Infinity` dentro.

    FastAPI devuelve en el error el valor recibido. Si ese valor era `Infinity`
    —que el `json` de Python acepta al leer pero no al escribir— el propio
    mensaje de error fallaba al serializarse y el cliente recibía un 500: el
    rechazo correcto se convertía en un fallo del servidor.
    """
    return JSONResponse(
        status_code=422,
        content={"detail": jsonable_encoder(_sin_no_finitos(exc.errors()))},
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
app.include_router(deep_dive.router)
app.include_router(earnings.router)
app.include_router(valuation.router)
app.include_router(snapshots.router)
app.include_router(options.router)
app.include_router(meta.router)
