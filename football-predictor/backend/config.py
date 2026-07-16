"""Rutas del proyecto y carga de la configuración de ligas (config/leagues.json)."""

import json
from functools import lru_cache
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = PROJECT_ROOT / "config" / "leagues.json"
DATA_DIR = PROJECT_ROOT / "data"
RAW_DIR = DATA_DIR / "raw"
DB_PATH = DATA_DIR / "football.db"


@lru_cache(maxsize=1)
def load_config() -> dict:
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)


def leagues() -> list[dict]:
    return load_config()["leagues"]


def model_params() -> dict:
    return load_config()["model"]


def get_league(league_id: str) -> dict | None:
    for lg in leagues():
        if lg["id"] == league_id:
            return lg
    return None
