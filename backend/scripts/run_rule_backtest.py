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
from app.analysis.baselines import comparar  # noqa: E402
from app.analysis.experiments import (  # noqa: E402
    HoldoutBloqueado,
    abrir_holdout,
    corregir_multiples,
    historial,
    partir_periodo,
    pvalor_desde_bootstrap,
    registrar,
    sharpe_deflactado,
)
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
        "--hipotesis",
        default="Las reglas de compra/venta baten a comprar y mantener tras costes.",
        help="qué se está probando; queda escrito en el registro",
    )
    p.add_argument(
        "--abrir-holdout",
        metavar="CONFIRMACION",
        help=(
            'evalúa sobre el tramo reservado. Exige la frase exacta '
            '"SI, QUEMAR EL HOLDOUT" — solo la primera vez es fuera de muestra'
        ),
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

    # El último tramo queda reservado y ningún experimento lo toca. Se abre
    # con una frase exacta y la apertura queda registrada para siempre: no se
    # puede impedir por código que alguien mire, pero sí que mire sin dejar
    # huella y sin saber que ha quemado el conjunto.
    with SessionLocal() as s_hist:
        previo = historial(s_hist)

    particion = partir_periodo(fechas)
    usando_holdout = False
    if args.abrir_holdout is not None:
        try:
            apertura = abrir_holdout(args.abrir_holdout, previo["veces_holdout_abierto"])
        except HoldoutBloqueado as exc:
            print(f"\n{exc}")
            return 1
        fechas_uso = particion["holdout"] or fechas
        usando_holdout = True
        print(f"\n*** HOLDOUT ABIERTO ***\n{apertura['aviso']}")
    else:
        fechas_uso = particion["desarrollo"]
        if particion["suficiente"]:
            print(f"\n{particion['nota']}")

    fechas = fechas_uso
    print(f"\nSimulando desde {inicio} hasta {fin} ({len(fechas)} fechas de entrada)…")
    con_divisa = not args.sin_divisa
    comun = dict(con_divisa=con_divisa, solo_momentum=solo_momentum, clase=clase)
    resultado = run_rule_backtest(universo, fechas, **comun)
    sin_filtro = run_rule_backtest(universo, fechas, exigir_tendencia=False, **comun)

    _imprimir(resultado, sin_filtro, sin_datos, con_divisa)

    # La pregunta que ordena todo lo demás: ¿bate esto a lo simple? Se compara
    # con el MISMO motor, las mismas fechas y los mismos costes.
    if resultado["n_operaciones"] > 0:
        from app.analysis.rule_backtest import costes_por_lado

        # El top del momentum se escala al universo: con "top 10" sobre 8
        # empresas, el baseline 3 selecciona a todas y deja de ser un baseline
        # distinto del 2 — dos filas idénticas no comparan nada.
        top = max(3, min(10, len(universo) // 4))
        bases = comparar(
            universo,
            fechas,
            resultado["operaciones"],
            costes_por_lado(con_divisa),
            top_momentum=top,
        )
        _imprimir_baselines(bases)
        _imprimir_rigor(bases, previo, usando_holdout)

        # Se registra SIEMPRE, salga bien o mal: si las pruebas fallidas no se
        # anotan, el recuento sale corto y el Sharpe deflactado se infla.
        if not args.no_guardar:
            with SessionLocal() as s_reg:
                registrar(
                    s_reg,
                    hipotesis=args.hipotesis,
                    estrategia=f"reglas/{clase}",
                    parametros={
                        "anos": args.anos,
                        "n_universo": len(universo),
                        "con_divisa": con_divisa,
                        "solo_momentum": solo_momentum,
                        "top_momentum": top,
                    },
                    desde=fechas[0].isoformat(),
                    hasta=fechas[-1].isoformat(),
                    universo=list(universo),
                    resultado=bases["tabla"]["estrategia"],
                    sharpe=_sharpe_por_periodo(bases),
                    uso_holdout=usando_holdout,
                )

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


def _sharpe_por_periodo(bases: dict) -> float | None:
    """Sharpe mensual sin anualizar: es la unidad que usa el DSR."""
    import math

    fila = bases["tabla"]["estrategia"]
    if fila.get("sharpe") is None:
        return None
    return round(fila["sharpe"] / math.sqrt(12), 4)


def _imprimir_rigor(bases: dict, previo: dict, usando_holdout: bool) -> None:
    """Cuántas veces has mirado, y qué queda en pie después de descontarlo."""
    linea = "═" * 78
    print(f"\n{linea}\nRIGOR: ¿CUÁNTAS VECES HAS MIRADO?\n{linea}")

    n_pruebas = previo["n_pruebas"] + 1
    print(f"  Pruebas registradas (incluida esta): {n_pruebas}")
    if previo["veces_holdout_abierto"]:
        print(f"  Holdout abierto antes: {previo['veces_holdout_abierto']} vez/veces")

    # Sharpe deflactado sobre los retornos de la estrategia.
    retornos = bases.get("_retornos_estrategia") or []
    if retornos:
        dsr = sharpe_deflactado(
            retornos, n_pruebas=n_pruebas, sharpes_probados=previo["sharpes"] or None
        )
        if dsr.get("suficiente"):
            print(f"\n  Sharpe observado (mensual)  {dsr['sharpe_observado']:+.4f}")
            print(f"  Umbral por haber mirado     {dsr['sharpe_umbral']:+.4f}")
            print(f"  Sharpe deflactado (DSR)     {dsr['dsr']:.3f}"
                  f"   {'HALLAZGO' if dsr['es_hallazgo'] else 'NO llega a hallazgo'}")
            print(f"\n  {dsr['nota']}")

    # Corrección por comparaciones múltiples sobre los tres baselines.
    pvalores = {}
    for clave, c in bases["comparaciones"].items():
        if c.get("suficiente") and c.get("prob_supera") is not None:
            p = 2 * min(c["prob_supera"], 1 - c["prob_supera"])
            pvalores[clave] = round(min(1.0, p), 4)
    if pvalores:
        corr = corregir_multiples(pvalores)
        print(f"\n  Comparaciones múltiples ({corr['n']} baselines, alfa {corr['alfa']}):")
        for clave, p in pvalores.items():
            print(
                f"    {clave:22} p={p:.4f}"
                f"   Bonferroni {'pasa' if corr['bonferroni'][clave] else 'NO'}"
                f"   Benjamini-Hochberg {'pasa' if corr['benjamini_hochberg'][clave] else 'NO'}"
            )
        print(f"\n  {corr['nota']}")

    if not usando_holdout:
        print(
            "\n  El tramo final sigue reservado y sin mirar. Cuando creas que has "
            "terminado de ajustar, ábrelo UNA vez con --abrir-holdout: ese será "
            "el único resultado realmente fuera de muestra que vas a tener."
        )


def _imprimir_baselines(b: dict) -> None:
    """La tabla comparativa y el veredicto, sin adornos."""
    linea = "═" * 78
    print(f"\n{linea}\nCONTRA LOS BASELINES\n{linea}")
    print(f"  {'':22} {'Retorno':>9} {'Volat.':>8} {'Sharpe':>7} {'Máx.caída':>10} {'Rotación':>9}")
    etiquetas = {
        "estrategia": "TU ESTRATEGIA",
        "comprar_y_mantener": "1· Comprar y mantener",
        "equiponderada": "2· Equiponderada",
        "momentum_12m": "3· Momentum 12 meses",
    }
    for clave, etiqueta in etiquetas.items():
        f = b["tabla"].get(clave) or {}
        num = lambda v, s="": "—" if v is None else f"{v:{s}}"  # noqa: E731
        print(
            f"  {etiqueta:22} {num(f.get('cagr_pct'), '+8.2f'):>9}"
            f" {num(f.get('vol_pct'), '7.1f'):>8}"
            f" {num(f.get('sharpe'), '6.2f'):>7}"
            f" {num(f.get('max_drawdown_pct'), '9.1f'):>10}"
            f" {num(f.get('rotacion_media'), '8.2f'):>9}"
        )

    print("\n  Diferencia anual frente a cada baseline (bootstrap por bloques):")
    for clave, c in b["comparaciones"].items():
        if not c.get("suficiente"):
            print(f"    {etiquetas[clave]:22} muestra insuficiente para un intervalo")
            continue
        marca = "SÍ" if c["distinguible_del_azar"] else "no"
        print(
            f"    {etiquetas[clave]:22} {c['diferencia_anual_pct']:+7.2f} %"
            f"   IC95 [{c['ic95'][0]:+.2f}, {c['ic95'][1]:+.2f}]"
            f"   ¿fuera del azar? {marca}"
        )

    print(f"\n{linea}\nVEREDICTO FRENTE A LO SIMPLE\n{linea}")
    print(f"  {b['veredicto']}")
    print(f"\n  {b['metodologia']}")


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
