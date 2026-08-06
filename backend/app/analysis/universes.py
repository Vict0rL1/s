"""Universos curados para el escaneo automático de señales.

Por qué listas fijas y no "todo el mercado": puntuar 5.000 empresas exige
miles de llamadas a APIs de pago. Estas listas cubren los nombres líquidos y
bien cubiertos por EDGAR, que es donde el modelo tiene datos fiables.

Por qué hay universos **sectoriales**: comparar el P/E de un banco con el de
una tecnológica penaliza injustamente a la segunda. Escanear dentro de un
sector hace la comparación mucho más limpia — es la forma recomendada de
usar esto.
"""

from __future__ import annotations

UNIVERSES: dict[str, dict] = {
    "megacaps": {
        "name": "Mega caps de EE. UU.",
        "description": (
            "Las mayores cotizadas estadounidenses. Universo diverso: útil para "
            "una primera pasada, pero mezcla sectores con múltiplos muy distintos."
        ),
        "symbols": [
            "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA", "BRK.B",
            "JPM", "V", "UNH", "XOM", "JNJ", "WMT", "MA", "PG", "HD", "CVX",
            "ABBV", "KO", "PEP", "COST", "MRK", "BAC", "AVGO", "LLY", "TMO",
            "MCD", "CSCO", "ORCL",
        ],
    },
    "tecnologia": {
        "name": "Tecnología",
        "description": (
            "Comparación entre pares tecnológicos. Los múltiplos altos son la "
            "norma aquí, así que el factor valor discrimina mejor que en un "
            "universo mixto."
        ),
        "symbols": [
            "AAPL", "MSFT", "GOOGL", "NVDA", "META", "AVGO", "ORCL", "CSCO",
            "CRM", "ADBE", "AMD", "INTC", "QCOM", "TXN", "IBM", "NOW", "INTU",
            "AMAT", "MU", "ADI",
        ],
    },
    "salud": {
        "name": "Salud y farmacéuticas",
        "description": (
            "Sector defensivo con márgenes altos y ciclos de I+D largos. El "
            "factor calidad suele ser el más discriminante."
        ),
        "symbols": [
            "UNH", "JNJ", "LLY", "ABBV", "MRK", "TMO", "ABT", "PFE", "DHR",
            "AMGN", "BMY", "CVS", "MDT", "GILD", "ISRG", "ELV", "ZTS", "SYK",
        ],
    },
    "financiero": {
        "name": "Financiero",
        "description": (
            "Bancos y aseguradoras. Aviso: el Altman Z-score no aplica a este "
            "sector, y los múltiplos de libro (P/B) pesan más que en el resto."
        ),
        "symbols": [
            "JPM", "BAC", "WFC", "GS", "MS", "SCHW", "BLK", "AXP", "C", "USB",
            "PNC", "TFC", "BK", "CB", "MMC", "PGR", "AIG", "MET",
        ],
    },
    "consumo": {
        "name": "Consumo",
        "description": (
            "Consumo básico y discrecional. Negocios maduros donde el flujo de "
            "caja y el dividendo suelen importar más que el crecimiento."
        ),
        "symbols": [
            "WMT", "PG", "KO", "PEP", "COST", "MCD", "HD", "NKE", "SBUX",
            "TGT", "LOW", "CL", "MDLZ", "MO", "KMB", "GIS", "SYY", "DG",
        ],
    },
    "energia_industriales": {
        "name": "Energía e industriales",
        "description": (
            "Sectores cíclicos y de capital intensivo. El momentum tiende a ser "
            "el factor más informativo porque siguen ciclos largos."
        ),
        "symbols": [
            "XOM", "CVX", "COP", "SLB", "EOG", "PSX", "MPC", "VLO", "CAT",
            "HON", "UNP", "GE", "BA", "LMT", "RTX", "DE", "MMM", "UPS",
        ],
    },
    "dividendos": {
        "name": "Pagadoras de dividendo consolidadas",
        "description": (
            "Empresas con historial largo de dividendo. Ojo: un dividendo alto "
            "puede ser señal de un negocio en declive, no de una ganga — mira "
            "el factor calidad antes que el yield."
        ),
        "symbols": [
            "JNJ", "PG", "KO", "PEP", "MMM", "CL", "MO", "XOM", "CVX", "MCD",
            "WMT", "ABBV", "MRK", "IBM", "VZ", "T", "KMB", "GIS", "SYY", "ED",
        ],
    },
}


# Universos que alimentan la lista diaria. Son los sectoriales y solo ellos:
# se puntúa dentro de cada sector y luego se mezclan los resultados, que es la
# única forma honesta de producir una lista única sin comparar bancos con
# tecnológicas. "megacaps" y "dividendos" quedan fuera a propósito porque se
# solapan con los demás y duplicarían empresas en la lista.
DAILY_SECTOR_KEYS = [
    "tecnologia",
    "salud",
    "financiero",
    "consumo",
    "energia_industriales",
]


def get_universe(key: str) -> dict:
    if key not in UNIVERSES:
        raise KeyError(key)
    return UNIVERSES[key]


def list_universes() -> list[dict]:
    return [
        {
            "key": key,
            "name": data["name"],
            "description": data["description"],
            "size": len(data["symbols"]),
            "symbols": data["symbols"],
        }
        for key, data in UNIVERSES.items()
    ]
