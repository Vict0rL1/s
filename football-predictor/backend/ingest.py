"""Orquestación de la ingesta: descarga → caché cruda local → SQLite.

Flujo por liga:
  1. Para cada (fuente, temporada) del config se descarga el archivo crudo a
     data/raw/<liga>/ — o se reutiliza la caché si la temporada ya cerró.
     Una temporada que la fuente aún no publica (404) solo genera un aviso.
  2. Se parsea todo con el adapter correspondiente, se aplican los alias de
     nombres del config y se reconstruye la liga completa en SQLite.

Guardar lo crudo localmente cumple dos objetivos: no depender de descargas
repetidas y poder reconstruir la base entera sin red (salvo temporadas vivas).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from . import config, db
from .sources import ADAPTERS, MatchRow, needs_refresh


@dataclass
class LeagueReport:
    league_id: str
    seasons: list = field(default_factory=list)   # dicts por temporada
    warnings: list = field(default_factory=list)


def _raw_path(league_id: str, adapter, source_cfg: dict, season: str):
    """Ruta de la caché cruda, p. ej. data/raw/liga-mx/footballcsv.mx.1.2023-24.csv"""
    code = source_cfg["code"].replace("/", "_")
    folder = config.RAW_DIR / league_id
    folder.mkdir(parents=True, exist_ok=True)
    return folder / f"{adapter.name}.{code}.{season}.{adapter.extension}"


def _ensure_raw(league_id: str, adapter, source_cfg: dict, season: str,
                force: bool, report: LeagueReport) -> str | None:
    """Devuelve el contenido crudo de una temporada (de red o caché), o None."""
    from .sources import fetch_text  # import local para facilitar monkeypatch en tests

    path = _raw_path(league_id, adapter, source_cfg, season)
    must_download = force or not path.exists() or needs_refresh(season)

    if must_download:
        url = adapter.url(source_cfg, season)
        try:
            text = fetch_text(url)
        except RuntimeError as exc:
            if path.exists():
                report.warnings.append(f"{season}: fallo de red, uso caché local ({exc})")
                return path.read_text(encoding="utf-8")
            report.warnings.append(f"{season}: no descargada y sin caché ({exc})")
            return None
        if text is None:  # 404: la fuente aún no publica esa temporada
            if path.exists():
                return path.read_text(encoding="utf-8")
            report.warnings.append(f"{season}: aún no publicada por {adapter.name} (404)")
            return None
        path.write_text(text, encoding="utf-8")
        return text

    return path.read_text(encoding="utf-8")


def update_league(league_cfg: dict, force: bool = False) -> LeagueReport:
    report = LeagueReport(league_id=league_cfg["id"])
    aliases: dict = league_cfg.get("aliases", {})
    all_rows: list[MatchRow] = []

    for source_cfg in league_cfg["sources"]:
        adapter = ADAPTERS[source_cfg["adapter"]]
        for season in source_cfg["seasons"]:
            text = _ensure_raw(league_cfg["id"], adapter, source_cfg, season, force, report)
            if text is None:
                continue
            try:
                rows = adapter.parse(text, season)
            except Exception as exc:
                report.warnings.append(f"{season}: error al parsear ({exc})")
                continue
            # Normalización de nombres: los alias del config unifican equipos
            # que la fuente nombra distinto en temporadas distintas.
            for r in rows:
                r.home = aliases.get(r.home, r.home)
                r.away = aliases.get(r.away, r.away)
            all_rows.extend(rows)

    conn = db.connect()
    try:
        db.replace_league(conn, league_cfg, all_rows)
        for row in db.league_seasons_summary(conn, league_cfg["id"]):
            report.seasons.append(dict(row))
    finally:
        conn.close()
    return report


def update_all(league_id: str | None = None, force: bool = False) -> list[LeagueReport]:
    reports = []
    for league_cfg in config.leagues():
        if league_id and league_cfg["id"] != league_id:
            continue
        reports.append(update_league(league_cfg, force=force))
    return reports
