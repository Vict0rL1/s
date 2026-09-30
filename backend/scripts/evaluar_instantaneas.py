"""Mide cómo salieron las decisiones congeladas. Para `cron`, una vez al día.

    python scripts/evaluar_instantaneas.py

Para cada instantánea aún abierta, compara su precio con los cierres
POSTERIORES y añade una fila de resultado: stop, objetivo, horizonte cumplido,
o sigue abierta. Nunca modifica una instantánea ni un resultado anterior — la
base lo impide de todas formas.

Coste: un histórico por símbolo con instantánea abierta, cacheado 7 días. Con
`--solo-cache` no descarga nada.

    30 22 * * 1-5  cd /ruta/al/repo/backend && \\
        /usr/bin/python3 scripts/evaluar_instantaneas.py >> ~/.instantaneas.log 2>&1
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date, datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select  # noqa: E402

from app import snapshots as sn  # noqa: E402
from app.db.engine import SessionLocal, init_db  # noqa: E402
from app.db.models import DecisionOutcome, DecisionSnapshot  # noqa: E402
from app.deps import get_service  # noqa: E402
from app.providers.base import DataNotFoundError  # noqa: E402
from app.providers.router import AllProvidersFailedError  # noqa: E402
from app.registro import configurar as configurar_registro  # noqa: E402
from app.registro import log  # noqa: E402


def _cierres(service, symbol: str, solo_cache: bool) -> list[tuple[date, float]] | None:
    try:
        if solo_cache:
            payload = service.cache.get("price_history_long", {"symbol": symbol})
        else:
            payload = service.get("price_history_long", symbol=symbol)
    except (DataNotFoundError, AllProvidersFailedError) as exc:
        log("dato").warning("sin histórico para %s: %s", symbol, exc)
        return None
    if not payload:
        return None
    salida = []
    for b in payload.get("bars") or []:
        try:
            salida.append((date.fromisoformat(str(b["ts"])[:10]), b["close"]))
        except (KeyError, TypeError, ValueError):
            continue
    return salida


def evaluar(solo_cache: bool = False, ahora: datetime | None = None) -> dict:
    configurar_registro()
    init_db()
    service = get_service()
    ahora = ahora or datetime.now(timezone.utc)
    cuenta = {"evaluadas": 0, "sin_datos": 0, "cerradas_ahora": 0, "ya_cerradas": 0}

    with SessionLocal() as session:
        cerradas = set(
            session.execute(
                select(DecisionOutcome.snapshot_id).where(DecisionOutcome.estado.in_(sn.CERRADOS))
            ).scalars()
        )
        pendientes = [
            s for s in session.execute(select(DecisionSnapshot)).scalars() if s.id not in cerradas
        ]
        cuenta["ya_cerradas"] = len(cerradas)
        historicos: dict[str, list | None] = {}
        for snap in pendientes:
            if snap.symbol not in historicos:
                historicos[snap.symbol] = _cierres(service, snap.symbol, solo_cache)
            r = sn.evaluar_resultado(snap, historicos[snap.symbol] or [], ahora.date())
            if sn.registrar_resultado(session, snap, r, ahora) is not None:
                cuenta["evaluadas"] += 1
                cuenta["sin_datos"] += r["estado"] == "sin_datos"
                cuenta["cerradas_ahora"] += r["estado"] in sn.CERRADOS
        session.commit()
    return cuenta


def main() -> int:
    p = argparse.ArgumentParser(description="Mide cómo salieron las decisiones congeladas.")
    p.add_argument("--solo-cache", action="store_true", help="no descarga históricos")
    args = p.parse_args()
    cuenta = evaluar(solo_cache=args.solo_cache)
    print(json.dumps({"cuando": datetime.now(timezone.utc).isoformat(), **cuenta}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
