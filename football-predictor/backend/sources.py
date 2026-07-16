"""Adapters de fuentes de datos.

Cada adapter sabe (1) construir la URL de descarga de una temporada y
(2) parsear el archivo crudo a una lista de `MatchRow` normalizadas.
Para añadir una fuente nueva (p. ej. football-data.co.uk o una API) se
implementa otro adapter aquí y se registra en `ADAPTERS`; las ligas lo
referencian desde config/leagues.json sin tocar el resto del código.

Fuentes incluidas (ambas abiertas, sin API key):
  - football_json : github.com/openfootball/football.json  (JSON por temporada)
  - footballcsv   : github.com/footballcsv/<repo>           (CSV por temporada)
"""

from __future__ import annotations

import csv
import io
import json
import re
import time as time_mod
from dataclasses import dataclass
from datetime import date, datetime

import requests

USER_AGENT = {"User-Agent": "football-predictor/1.0 (proyecto educativo)"}
FOOTBALL_JSON_BASE = "https://raw.githubusercontent.com/openfootball/football.json/master"
FOOTBALLCSV_BASE = "https://raw.githubusercontent.com/footballcsv/{repo}/master"


@dataclass
class MatchRow:
    """Un partido normalizado, listo para insertarse en SQLite."""

    season: str
    stage: str
    date: str        # ISO YYYY-MM-DD
    time: str
    home: str
    away: str
    home_goals: int | None   # None = aún no jugado
    away_goals: int | None
    source: str


def season_end_year(season: str) -> int:
    """'2024-25' -> 2025. Sirve para decidir qué temporadas refrescar."""
    start = int(season.split("-")[0])
    return start + 1


def needs_refresh(season: str, today: date | None = None) -> bool:
    """Una temporada se re-descarga si todavía puede recibir partidos nuevos.

    Regla simple: si su año de cierre es el año actual o posterior, se
    considera 'viva' (resultados nuevos, calendario, correcciones). Las
    temporadas ya cerradas se sirven desde la caché local en data/raw/.
    """
    today = today or date.today()
    return season_end_year(season) >= today.year


def fetch_text(url: str) -> str | None:
    """GET con un reintento. Devuelve None si la fuente responde 404
    (temporada aún no publicada) y lanza excepción en otros errores."""
    last_error: Exception | None = None
    for attempt in range(2):
        try:
            resp = requests.get(url, timeout=30, headers=USER_AGENT)
            if resp.status_code == 404:
                return None
            resp.raise_for_status()
            resp.encoding = "utf-8"
            return resp.text
        except requests.RequestException as exc:  # red caída, 5xx, timeout...
            last_error = exc
            time_mod.sleep(2 * (attempt + 1))
    raise RuntimeError(f"No se pudo descargar {url}: {last_error}")


# ---------------------------------------------------------------------------
# Adapter: openfootball/football.json
# ---------------------------------------------------------------------------

class FootballJsonAdapter:
    name = "football_json"
    extension = "json"

    def url(self, source_cfg: dict, season: str) -> str:
        return f"{FOOTBALL_JSON_BASE}/{season}/{source_cfg['code']}.json"

    @staticmethod
    def _final_score(m: dict) -> tuple[int, int] | None:
        """Extrae el marcador final tolerando las dos variantes del dataset:
        `score: {"ft": [h, a], ...}` (normal) y `score: [h, a]` (algunos
        archivos codifican así los 0-0). Sin marcador -> None (no jugado)."""
        score = m.get("score")
        ft = None
        if isinstance(score, dict):
            ft = score.get("ft")
        elif isinstance(score, list):
            ft = score
        if isinstance(ft, list) and len(ft) == 2:
            return int(ft[0]), int(ft[1])
        return None

    def parse(self, text: str, season: str) -> list[MatchRow]:
        data = json.loads(text)
        rows: list[MatchRow] = []
        for m in data.get("matches", []):
            if not isinstance(m, dict):
                continue
            ft = self._final_score(m)
            home_goals, away_goals = ft if ft else (None, None)
            match_date = m.get("date", "")
            home = (m.get("team1") or "").strip()
            away = (m.get("team2") or "").strip()
            if not match_date or not home or not away or home == away:
                continue
            rows.append(MatchRow(
                season=season,
                stage=m.get("round", "") or "",
                date=match_date,
                time=m.get("time", "") or "",
                home=home,
                away=away,
                home_goals=home_goals,
                away_goals=away_goals,
                source=self.name,
            ))
        return rows


# ---------------------------------------------------------------------------
# Adapter: footballcsv (caché de worldfootball en CSV)
# ---------------------------------------------------------------------------

# El campo FT normalmente es '2-1'; en finales puede traer sufijos
# (prórroga/penales), así que extraemos el primer patrón d-d.
SCORE_RE = re.compile(r"(\d+)\s*-\s*(\d+)")

DATE_FORMATS = ("%a %b %d %Y", "%Y-%m-%d", "%d %b %Y", "%b %d %Y")


def parse_csv_date(raw: str) -> str | None:
    raw = (raw or "").strip()
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(raw, fmt).date().isoformat()
        except ValueError:
            continue
    return None


class FootballCsvAdapter:
    name = "footballcsv"
    extension = "csv"

    def url(self, source_cfg: dict, season: str) -> str:
        base = FOOTBALLCSV_BASE.format(repo=source_cfg["repo"])
        return f"{base}/{season}/{source_cfg['code']}.csv"

    def parse(self, text: str, season: str) -> list[MatchRow]:
        reader = csv.DictReader(io.StringIO(text))
        rows: list[MatchRow] = []
        for rec in reader:
            # Los encabezados varían un poco entre temporadas; leemos con tolerancia.
            home = (rec.get("Team 1") or "").strip()
            away = (rec.get("Team 2") or "").strip()
            match_date = parse_csv_date(rec.get("Date", ""))
            if not home or not away or home == away or not match_date:
                continue
            ft = rec.get("FT") or ""
            score = SCORE_RE.search(ft)
            home_goals, away_goals = (int(score.group(1)), int(score.group(2))) if score else (None, None)
            stage = (rec.get("Stage") or "").strip()
            rnd = (rec.get("Round") or "").strip()
            stage_full = f"{stage}, Jornada {rnd}" if stage and rnd else (stage or rnd)
            rows.append(MatchRow(
                season=season,
                stage=stage_full,
                date=match_date,
                time=(rec.get("Time") or "").strip(),
                home=home,
                away=away,
                home_goals=home_goals,
                away_goals=away_goals,
                source=self.name,
            ))
        return rows


ADAPTERS = {
    FootballJsonAdapter.name: FootballJsonAdapter(),
    FootballCsvAdapter.name: FootballCsvAdapter(),
}
