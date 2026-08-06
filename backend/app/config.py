"""Configuración central de la aplicación.

Todas las API keys viven en el archivo .env (ver .env.example). Los TTLs de
caché y los límites de cada proveedor se definen aquí para que haya una sola
fuente de verdad que comparten la capa de caché, el router de fuentes y el
endpoint de uso de APIs.
"""

from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = BACKEND_DIR.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(REPO_ROOT / ".env", BACKEND_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    finnhub_api_key: str = ""
    twelvedata_api_key: str = ""
    alphavantage_api_key: str = ""
    fred_api_key: str = ""
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-opus-5"
    edgar_user_agent: str = ""

    database_path: str = str(BACKEND_DIR / "data" / "app.db")

    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]


# TTL de caché en segundos, por tipo de dato. El caché es parte del diseño
# central: los tiers gratuitos no sobreviven sin él. Los TTL largos en datos
# que cambian poco son la principal palanca para minimizar créditos de API.
CACHE_TTL_SECONDS: dict[str, int] = {
    "quote": 60,                 # cotizaciones: ~1 min
    "price_history": 15 * 60,    # velas diarias/semanales: 15 min
    "profile": 24 * 3600,        # perfil de la empresa: 24 h
    "fundamentals": 24 * 3600,   # fundamentales TTM: 24 h
    "financials": 24 * 3600,     # estados financieros EDGAR: 24 h
    "filings": 24 * 3600,        # lista de filings EDGAR: 24 h
    "macro": 24 * 3600,          # FRED: 1 día
    "news": 15 * 60,             # noticias: 15 min
    "earnings_calendar": 12 * 3600,  # calendario de resultados: 12 h
    "peers": 7 * 24 * 3600,      # pares del sector: cambian rarísimo — 7 días
    "etf_data": 7 * 24 * 3600,   # composición de ETFs: 7 días
    "bulk_momentum": 6 * 3600,   # momentum de un universo entero: 6 h
}

# Límites del tier gratuito por proveedor: lista de ventanas
# (máx. llamadas, ventana en segundos) — un proveedor puede tener límite por
# minuto Y por día (p. ej. Twelve Data). Verificados contra la documentación
# vigente; si un proveedor cambia su tier, solo se ajusta aquí.
PROVIDER_RATE_LIMITS: dict[str, tuple[tuple[int, int], ...]] = {
    "finnhub": ((60, 60),),                       # 60 llamadas / minuto
    "twelvedata": ((8, 60), (800, 24 * 3600)),    # 8/min y 800 créditos/día
    "alphavantage": ((25, 24 * 3600),),           # 25/día — no se usa por defecto
    "fred": ((120, 60),),                         # generoso; límite nominal
    "edgar": ((300, 60),),                        # SEC pide <=10 req/s; margen amplio
    "yfinance": ((60, 60),),                      # no oficial: autolimitación prudente
}

settings = Settings()
