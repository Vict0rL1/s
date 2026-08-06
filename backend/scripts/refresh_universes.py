"""Regenera los universos de mercado a partir de fuentes públicas.

Por qué un script y no una lista escrita a mano: son ~550 empresas con su
sector. Escribirlas de memoria garantizaría erratas silenciosas (un ticker
mal, una empresa que ya salió del índice, un sector equivocado que además
distorsiona los z-scores). Aquí la lista sale de fuentes citables y se puede
volver a generar cuando envejezca.

    python scripts/refresh_universes.py

Fuentes:
- S&P 500: datasets/s-and-p-500-companies (Open Data Commons PDDL), que a su
  vez sigue la lista de Wikipedia. Trae símbolo, nombre y sector GICS.
- Canadá: JerBouma/FinanceDatabase (MIT), filtrado a empresas canadienses
  cotizadas en NYSE/NASDAQ. Se usan sus tickers estadounidenses a propósito:
  esas empresas presentan ante la SEC (formulario 40-F), así que EDGAR las
  cubre igual que a las estadounidenses y no hay que bajar a fuentes peores.
"""

from __future__ import annotations

import bz2
import csv
import io
import json
import re
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "app" / "data"

SP500_URL = (
    "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/"
    "main/data/constituents.csv"
)
FINDB_URL = (
    "https://raw.githubusercontent.com/JerBouma/FinanceDatabase/"
    "main/compression/equities.bz2"
)

# Solo acciones ordinarias: descarta warrants (CVE-WT), preferentes y notas,
# que cotizan con el ticker de la empresa pero no son la acción.
COMMON_STOCK_RE = re.compile(r"^[A-Z]{1,5}(\.[A-Z])?$")
NOT_COMMON_IN_NAME = ("%", " Note", " Notes", " Pfd", " Preferred", " Warrant")

# Defectos de la fuente que los filtros mecánicos no pueden detectar. Cada
# entrada lleva su motivo: esto documenta un error ajeno, no es criterio
# propio sobre qué empresa merece estar.
KNOWN_BAD = {
    # NYSE lista AQN (acción ordinaria) y AQNB por separado; AQNB son las
    # "6.20% Fixed-to-Floating Subordinated Notes Series 2019-A due 2079",
    # es decir deuda. Sus "fundamentales" no son los de una acción.
    "AQNB": "notas subordinadas de Algonquin, no la acción ordinaria (AQN)",
    # Samsara es estadounidense (sede en San Francisco); FinanceDatabase la
    # etiqueta como canadiense.
    "IOT": "empresa estadounidense mal etiquetada como canadiense en la fuente",
}


def fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "analisis-bursatil"})
    with urllib.request.urlopen(request, timeout=180) as response:
        return response.read()


def is_common_stock(symbol: str, name: str) -> bool:
    if not COMMON_STOCK_RE.match(symbol):
        return False
    return not any(token in name for token in NOT_COMMON_IN_NAME)


def build_sp500() -> list[dict]:
    rows = list(csv.DictReader(io.StringIO(fetch(SP500_URL).decode("utf-8"))))
    out = []
    for row in rows:
        symbol, name, sector = row["Symbol"], row["Security"], row["GICS Sector"]
        if not (symbol and name and sector):
            continue
        out.append({"symbol": symbol, "name": name, "sector": sector})
    return sorted(out, key=lambda r: r["symbol"])


def build_canada(exclude: set[str]) -> list[dict]:
    raw = bz2.decompress(fetch(FINDB_URL)).decode("utf-8", "replace")
    rows = list(csv.DictReader(io.StringIO(raw)))
    out = []
    for row in rows:
        if row["country"] != "Canada" or row["exchange"] not in {"NMS", "NYQ"}:
            continue
        if (row["delisted"] or "").strip().lower() in {"true", "1", "yes"}:
            continue
        # Solo grandes: por debajo de esto la cobertura de fundamentales en los
        # tiers gratuitos es tan irregular que el z-score sería ruido.
        if row["market_cap"] not in {"Mega Cap", "Large Cap"}:
            continue
        symbol, name, sector = row["symbol"], row["name"], row["sector"]
        if not (symbol and name and sector) or not is_common_stock(symbol, name):
            continue
        if symbol in KNOWN_BAD:
            continue
        # Una empresa ya presente en el S&P 500 no se duplica: se puntúa una vez,
        # en el mercado donde la comparación con sus pares es más limpia.
        if symbol in exclude:
            continue
        out.append({"symbol": symbol, "name": name.strip(), "sector": sector})
    return sorted(out, key=lambda r: r["symbol"])


def write_csv(path: Path, rows: list[dict]) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["symbol", "name", "sector"])
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    sp500 = build_sp500()
    write_csv(DATA_DIR / "universe_us_sp500.csv", sp500)

    canada = build_canada(exclude={r["symbol"] for r in sp500})
    write_csv(DATA_DIR / "universe_canada.csv", canada)

    meta = {
        "retrieved_at": datetime.now(timezone.utc).date().isoformat(),
        "markets": {
            "us_sp500": {"source": SP500_URL, "companies": len(sp500)},
            "canada": {"source": FINDB_URL, "companies": len(canada)},
        },
    }
    (DATA_DIR / "universes_meta.json").write_text(
        json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"S&P 500: {len(sp500)} empresas")
    print(f"Canadá:  {len(canada)} empresas")


if __name__ == "__main__":
    main()
