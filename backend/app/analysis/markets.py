"""Mercados que alimentan la lista diaria, cargados desde datos versionados.

Por qué archivos de datos y no listas en el código: son ~550 empresas con su
sector, generadas por `scripts/refresh_universes.py` desde fuentes citables.
Mantenerlas a mano garantizaría erratas silenciosas, y un sector equivocado no
es cosmético: distorsiona el z-score de todos sus comparables.

La agrupación **es por sector**, siempre. Comparar el P/E de un banco con el de
una tecnológica premia a la segunda sin motivo, así que cada empresa compite
contra las de su propio sector dentro de su propio mercado.
"""

from __future__ import annotations

import csv
import json
from functools import lru_cache
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

MARKETS: dict[str, dict] = {
    "us_sp500": {
        "name": "EE. UU. — S&P 500",
        "file": "universe_us_sp500.csv",
        "description": (
            "Los componentes del índice, por sector GICS. Todas reportan a la "
            "SEC, así que EDGAR cubre sus fundamentales gratis."
        ),
    },
    "nasdaq": {
        "name": "NASDAQ — grandes cotizadas",
        "file": "universe_nasdaq.csv",
        "description": (
            "Las mayores cotizadas del NASDAQ, por sector. No es el índice "
            "Nasdaq-100 (no hay fuente pública automatizable de su composición). "
            "Se solapa con el S&P 500 a propósito: son vistas distintas."
        ),
    },
    "canada": {
        "name": "Canadá — cotizadas en EE. UU.",
        "file": "universe_canada.csv",
        "description": (
            "Grandes canadienses cotizadas en NYSE/NASDAQ. Se usan sus tickers "
            "estadounidenses: presentan ante la SEC (formulario 40-F), así que "
            "tienen los mismos datos que una estadounidense."
        ),
    },
}

DEFAULT_MARKET = "us_sp500"

# Un sector necesita al menos 3 empresas puntuadas para que su z-score
# signifique algo. Por debajo, el sector entero se descarta.
MIN_SECTOR_SIZE = 3


@lru_cache(maxsize=8)
def load_market(key: str) -> dict:
    """Carga un mercado y lo agrupa por sector. Cacheado: el archivo no cambia."""
    if key not in MARKETS:
        raise KeyError(key)
    meta = MARKETS[key]

    companies: list[dict] = []
    with (DATA_DIR / meta["file"]).open(encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            if row["symbol"] and row["sector"]:
                companies.append(
                    {
                        "symbol": row["symbol"],
                        "name": row["name"],
                        "sector": row["sector"],
                    }
                )

    sectors: dict[str, list[dict]] = {}
    for company in companies:
        sectors.setdefault(company["sector"], []).append(company)

    return {
        "key": key,
        "name": meta["name"],
        "description": meta["description"],
        "companies": companies,
        "sectors": dict(sorted(sectors.items())),
    }


@lru_cache(maxsize=1)
def universes_meta() -> dict:
    """Procedencia y fecha de los datos, para poder mostrarla en la UI."""
    path = DATA_DIR / "universes_meta.json"
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def list_markets() -> list[dict]:
    out = []
    for key in MARKETS:
        market = load_market(key)
        out.append(
            {
                "key": key,
                "name": market["name"],
                "description": market["description"],
                "companies": len(market["companies"]),
                "sectors": len(market["sectors"]),
            }
        )
    return out
