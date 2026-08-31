"""Ejecuta el backtest de reglas sobre un universo amplio y guarda el resultado.

Por qué existe además del botón de la interfaz: el endpoint acepta como mucho
15 tickers, que es el tope pensado para el formulario manual. Un backtest con 15
empresas produce pocas operaciones y un intervalo de confianza tan ancho que no
concluye nada. Aquí se puede correr sobre 40, 60 o las que quieras.

Guarda el resultado igual que el endpoint, así que al terminar la vista **Hoy**
deja de decir «sin validar» y pasa a decir si las reglas están **calibradas** o
**refutadas**.

    cd backend
    .venv/bin/python scripts/run_rule_backtest.py                # 40 grandes del S&P 500
    .venv/bin/python scripts/run_rule_backtest.py --n 60 --anos 8
    .venv/bin/python scripts/run_rule_backtest.py --sin-divisa   # sin coste CAD→USD
    .venv/bin/python scripts/run_rule_backtest.py --simbolos AAPL,MSFT,JNJ,KO

Coste de API: los estados financieros salen de EDGAR (gratis) y el histórico de
precios de Twelve Data o yfinance. Todo queda cacheado 24 h, así que repetirlo
el mismo día no vuelve a descargar nada.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.analysis.markets import load_market  # noqa: E402
from app.analysis.rule_backtest import (  # noqa: E402
    rebalance_dates_mensuales,
    run_rule_backtest,
)
from app.db.engine import Base, SessionLocal, engine  # noqa: E402
from app.db.models import LlmOutput  # noqa: E402
from app.deps import get_service  # noqa: E402
from app.providers.base import DataNotFoundError  # noqa: E402
from app.providers.router import AllProvidersFailedError  # noqa: E402


def _safe(service, tipo, **kwargs):
    try:
        return service.get(tipo, **kwargs)
    except (DataNotFoundError, AllProvidersFailedError):
        return None


def _universo_por_defecto(n: int) -> list[str]:
    """Las primeras `n` del S&P 500, repartidas entre sectores.

    Se toman alternando sectores en vez de las primeras alfabéticamente: un
    backtest sobre 40 empresas del mismo sector mide ese sector, no las reglas.
    """
    sectores = load_market("us_sp500")["sectors"]
    listas = [list(v) for v in sectores.values()]
    salida: list[str] = []
    i = 0
    while len(salida) < n and any(i < len(l) for l in listas):
        for lista in listas:
            if i < len(lista) and len(salida) < n:
                salida.append(lista[i]["symbol"])
        i += 1
    return salida


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--n", type=int, default=40, help="cuántas empresas (por defecto 40)")
    p.add_argument("--anos", type=int, default=6, help="años de histórico (por defecto 6)")
    p.add_argument("--simbolos", help="lista propia separada por comas")
    p.add_argument(
        "--cripto",
        action="store_true",
        help="valida el mercado de cripto (solo momentum, sin fundamentales)",
    )
    p.add_argument(
        "--sin-divisa",
        action="store_true",
        help="no cobrar la conversión CAD→USD (p. ej. si usas Norbert's Gambit)",
    )
    p.add_argument(
        "--no-guardar",
        action="store_true",
        help="solo imprimir; no alimentar la vista Hoy con el resultado",
    )
    args = p.parse_args()

    Base.metadata.create_all(engine)
    service = get_service()

    if args.cripto:
        simbolos = [c["symbol"] for c in load_market("cripto")["companies"]]
    elif args.simbolos:
        simbolos = [s.strip().upper() for s in args.simbolos.split(",") if s.strip()]
    else:
        simbolos = _universo_por_defecto(args.n)
    solo_momentum = args.cripto
    clase = "cripto" if args.cripto else "accion"

    print(f"Universo: {len(simbolos)} empresas · {args.anos} años de histórico")
    print("Descargando (EDGAR gratis + histórico de precios). Cacheado 24 h.\n")

    universo: dict[str, dict] = {}
    sin_datos: list[str] = []
    for i, symbol in enumerate(simbolos, start=1):
        # Cripto no tiene estados financieros que pedir: exigirlos dejaría
        # este mercado imposible de validar por construcción.
        financials = None if solo_momentum else _safe(service, "financials", symbol=symbol)
        filings = None if solo_momentum else _safe(service, "filings", symbol=symbol)
        history = _safe(
            service, "price_history", symbol=symbol, interval="1day", outputsize=5000
        )
        if not history or (not solo_momentum and not financials):
            sin_datos.append(symbol)
            print(f"  [{i:3}/{len(simbolos)}] {symbol:6} sin datos suficientes")
            continue
        universo[symbol] = {
            "periods": (financials or {}).get("periods", []),
            "filings": (filings or {}).get("filings", []),
            "bars": history["bars"],
        }
        print(f"  [{i:3}/{len(simbolos)}] {symbol:6} ok")

    if len(universo) < 3:
        print(
            f"\nSolo {len(universo)} empresas con histórico. Hacen falta 3 o más.\n"
            "Revisa que las API keys estén en .env y que quede cuota."
        )
        return 1

    # Se deja un año al final para que las operaciones abiertas al borde del
    # periodo puedan cerrarse; si no, solo contarían las que se resuelven rápido.
    fin = date.today() - timedelta(days=365)
    inicio = fin - timedelta(days=365 * args.anos)
    fechas = rebalance_dates_mensuales(inicio, fin)

    print(f"\nSimulando desde {inicio} hasta {fin} ({len(fechas)} fechas de entrada)…")
    con_divisa = not args.sin_divisa
    comun = dict(con_divisa=con_divisa, solo_momentum=solo_momentum, clase=clase)
    resultado = run_rule_backtest(universo, fechas, **comun)
    sin_filtro = run_rule_backtest(universo, fechas, exigir_tendencia=False, **comun)

    _imprimir(resultado, sin_filtro, sin_datos, con_divisa)

    if resultado["n_operaciones"] > 0 and not args.no_guardar:
        with SessionLocal() as session:
            session.add(
                LlmOutput(
                    kind="rule_backtest",
                    content_md=json.dumps(
                        {k: v for k, v in resultado.items() if k != "operaciones"}
                    ),
                    model=f"reglas/{clase}/{args.anos}a",
                )
            )
            session.commit()
        print("\nGuardado. Recarga la vista «Hoy»: cada idea dirá ahora si sus")
        print("reglas están validadas o refutadas, en vez de «sin validar».")
    return 0


def _imprimir(r: dict, sin_filtro: dict, sin_datos: list[str], con_divisa: bool) -> None:
    linea = "─" * 66
    print(f"\n{linea}\nRESULTADO\n{linea}")
    if r["n_operaciones"] == 0:
        print(r.get("nota", "Ninguna operación cumplió las condiciones."))
        return

    pct = lambda v: "—" if v is None else f"{v:+.2f} %"  # noqa: E731
    print(f"  Operaciones simuladas   {r['n_operaciones']}")
    print(f"  Tasa de acierto         {r['tasa_acierto'] * 100:.0f} %"
          f"  (IC 95 %: {r['tasa_acierto_ic'][0] * 100:.0f}–{r['tasa_acierto_ic'][1] * 100:.0f} %)")
    print(f"  Esperanza por operación {pct(r['esperanza_pct'])}   (neta de costes)")
    print(f"  Comprar a ciegas daba   {pct(r['referencia_pct'])}")
    print(f"  Ventaja de las reglas   {pct(r['ventaja_pct'])}")
    print(f"  Media ganadora          {pct(r['media_ganadora_pct'])}")
    print(f"  Media perdedora         {pct(r['media_perdedora_pct'])}")
    print(f"  Peor racha perdedora    {r['racha_perdedora']} seguidas")
    salidas = r["salidas"]
    print(f"  Cómo terminaron         {salidas['objetivo']} objetivo · "
          f"{salidas['stop']} stop · {salidas['plazo']} plazo")
    print(f"  Coste aplicado          {r['coste_total_por_operacion_pct']} % por operación"
          f"{' (incluye divisa CAD→USD)' if con_divisa else ' (sin divisa)'}")
    if sin_filtro["n_operaciones"] > 0:
        print(f"  Sin filtro de tendencia {sin_filtro['n_operaciones']} operaciones, "
              f"esperanza {pct(sin_filtro.get('esperanza_pct'))}")
    d = r.get("distribucion") or {}
    if d.get("n"):
        print("\n  Distribución del resultado (percentiles reales, no supuestos):")
        print(f"    bajista (p10) {pct(d['p10']):>9}   una de cada diez fue peor")
        print(f"    base   (p50)  {pct(d['mediana']):>9}   la operación corriente")
        print(f"    alcista (p90) {pct(d['p90']):>9}   una de cada diez fue mejor")

    v = r.get("ventanas") or {}
    if v.get("ventanas"):
        print("\n  Por ventanas (¿la ventaja es estable o sale de un tramo?):")
        for w in v["ventanas"]:
            print(f"    {w['desde']} → {w['hasta']}  n={w['n']:<4} "
                  f"esperanza {pct(w['esperanza_pct']):>9}  aciertos {w['tasa_acierto']*100:.0f} %")
        print(f"    {v['nota']}")

    dc = r.get("desglose_costes") or {}
    if dc.get("por_lado"):
        partes = " + ".join(f"{k} {v}" for k, v in dc["por_lado"].items())
        print(f"\n  Costes por lado: {partes} = {dc['total_por_lado_pct']} %")

    if sin_datos:
        print(f"  Sin datos               {len(sin_datos)}: {', '.join(sin_datos[:8])}"
              f"{'…' if len(sin_datos) > 8 else ''}")

    print(f"\n{linea}\nVEREDICTO\n{linea}")
    from app.routers.signals import _rule_verdict

    print(_rule_verdict(r, sin_filtro))
    print(f"\n{r['sesgo_supervivencia']}")


if __name__ == "__main__":
    raise SystemExit(main())
