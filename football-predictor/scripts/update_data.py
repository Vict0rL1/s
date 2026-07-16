#!/usr/bin/env python3
"""Descarga/refresca los datos históricos y reconstruye la base SQLite.

Uso (desde football-predictor/):
    python scripts/update_data.py                  # todas las ligas
    python scripts/update_data.py --league liga-mx # una sola liga
    python scripts/update_data.py --force          # re-descarga todo (ignora caché)
    python scripts/update_data.py --check-names    # detecta posibles nombres inconsistentes

Las temporadas cerradas se sirven de la caché en data/raw/; solo las
temporadas 'vivas' vuelven a descargarse. Correr esto una vez a la semana
durante la temporada es suficiente.
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend import config, db, ingest  # noqa: E402


def print_report(report: ingest.LeagueReport) -> None:
    league = config.get_league(report.league_id)
    print(f"\n{league['flag']}  {league['name']} ({report.league_id})")
    if not report.seasons:
        print("   (sin datos)")
    else:
        print(f"   {'temporada':<10} {'partidos':>8} {'jugados':>8} {'equipos':>8}  {'desde':<12}{'hasta':<12} fuente")
        for s in report.seasons:
            print(f"   {s['season']:<10} {s['partidos']:>8} {s['jugados']:>8} {s['equipos']:>8}  "
                  f"{s['desde']:<12}{s['hasta']:<12} {s['fuentes']}")
    for w in report.warnings:
        print(f"   ⚠ {w}")


def check_names(league_id: str | None) -> None:
    """Lista equipos que solo aparecen en algunas temporadas: ayuda a detectar
    renombres de la fuente (se corrigen con 'aliases' en config/leagues.json).
    Nota: equipos ascendidos/descendidos aparecen aquí y son normales."""
    conn = db.connect()
    for lg in config.leagues():
        if league_id and lg["id"] != league_id:
            continue
        rows = conn.execute(
            """
            SELECT name, COUNT(DISTINCT season) AS n, MIN(season) AS desde, MAX(season) AS hasta
            FROM (SELECT home_team AS name, season FROM matches WHERE league_id = :id
                  UNION ALL
                  SELECT away_team, season FROM matches WHERE league_id = :id)
            GROUP BY name ORDER BY n, name
            """,
            {"id": lg["id"]},
        ).fetchall()
        total_seasons = conn.execute(
            "SELECT COUNT(DISTINCT season) FROM matches WHERE league_id = ?", (lg["id"],)
        ).fetchone()[0]
        partial = [r for r in rows if r["n"] < total_seasons]
        print(f"\n{lg['name']}: {len(rows)} equipos, {total_seasons} temporadas. "
              f"Presentes solo en algunas temporadas ({len(partial)}):")
        for r in partial:
            print(f"   {r['name']:<28} {r['n']} temporada(s)  [{r['desde']} → {r['hasta']}]")
    conn.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--league", help="actualizar solo esta liga (id del config)")
    parser.add_argument("--force", action="store_true", help="re-descargar aunque exista caché")
    parser.add_argument("--check-names", action="store_true", help="solo reportar nombres inconsistentes")
    args = parser.parse_args()

    if args.check_names:
        check_names(args.league)
        return

    print("Actualizando datos (fuentes abiertas de GitHub, sin API key)...")
    reports = ingest.update_all(league_id=args.league, force=args.force)
    for report in reports:
        print_report(report)

    conn = db.connect()
    total, played = conn.execute("SELECT COUNT(*), SUM(home_goals IS NOT NULL) FROM matches").fetchone()
    conn.close()
    print(f"\nTotal: {total} partidos en la base ({played} jugados). DB: {config.DB_PATH}")


if __name__ == "__main__":
    main()
