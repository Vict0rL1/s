"""Proveedor SEC EDGAR (https://www.sec.gov/search-filings/edgar-application-programming-interfaces).

Gratis, oficial y sin API key — por eso es la fuente PRIORITARIA de estados
financieros: descargar un companyfacts una vez al día (TTL 24 h) alimenta
ratios, DCF, Altman Z y Piotroski F sin gastar créditos de ningún otro API.

La SEC exige identificarse vía User-Agent (EDGAR_USER_AGENT en .env) y pide
mantenerse por debajo de 10 req/s; el rate limiter de la app lo garantiza.
"""

from __future__ import annotations

import time

import httpx

from app.providers.base import (
    DataNotFoundError,
    DataProvider,
    ProviderError,
    iso_utc,
)

TICKER_MAP_URL = "https://www.sec.gov/files/company_tickers.json"
FACTS_URL = "https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json"
SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik:010d}.json"

# Etiquetas us-gaap por campo, en orden de preferencia: las empresas no usan
# todas las mismas etiquetas XBRL, así que se prueba cada alternativa.
_FLOW_TAGS: dict[str, list[str]] = {
    "revenue": [
        "RevenueFromContractWithCustomerExcludingAssessedTax",
        "Revenues",
        "SalesRevenueNet",
        "RevenueFromContractWithCustomerIncludingAssessedTax",
    ],
    "gross_profit": ["GrossProfit"],
    "operating_income": ["OperatingIncomeLoss"],
    "net_income": ["NetIncomeLoss"],
    "interest_expense": ["InterestExpense", "InterestExpenseDebt"],
    "depreciation_amortization": [
        "DepreciationDepletionAndAmortization",
        "DepreciationAmortizationAndAccretionNet",
        "DepreciationAndAmortization",
    ],
    "cfo": [
        "NetCashProvidedByUsedInOperatingActivities",
        "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
    ],
    "capex": [
        "PaymentsToAcquirePropertyPlantAndEquipment",
        "PaymentsToAcquireProductiveAssets",
    ],
}

_BALANCE_TAGS: dict[str, list[str]] = {
    "total_assets": ["Assets"],
    "total_liabilities": ["Liabilities"],
    "equity": [
        "StockholdersEquity",
        "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
    ],
    "current_assets": ["AssetsCurrent"],
    "current_liabilities": ["LiabilitiesCurrent"],
    "cash": [
        "CashAndCashEquivalentsAtCarryingValue",
        "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
    ],
    "retained_earnings": ["RetainedEarningsAccumulatedDeficit"],
    "long_term_debt": ["LongTermDebtNoncurrent", "LongTermDebt"],
    "short_term_debt": ["LongTermDebtCurrent", "DebtCurrent"],
}

_INSIDER_FORMS = {"3", "4", "5"}
_COMPANY_FORMS = {"10-K", "10-Q", "8-K", "20-F", "DEF 14A", "S-1"}

# Mapa ticker→CIK en memoria de proceso (el archivo pesa ~1 MB; no tiene
# sentido bajarlo por símbolo). Se refresca cada 24 h.
_cik_cache: dict = {"fetched_at": 0.0, "map": {}}
_CIK_TTL = 24 * 3600


def _annual_entries(units: list[dict], is_flow: bool) -> dict[str, dict]:
    """Filtra los datos anuales (10-K/20-F, fp=FY) y deduplica por año fiscal."""
    out: dict[str, dict] = {}
    for entry in units:
        form = entry.get("form", "")
        if not ("10-K" in form or "20-F" in form) or entry.get("fp") != "FY":
            continue
        end = entry.get("end")
        if not end:
            continue
        if is_flow:
            start = entry.get("start")
            if not start:
                continue
            # Solo duraciones ~anuales: descarta trimestres acumulados.
            try:
                days = (
                    time.mktime(time.strptime(end, "%Y-%m-%d"))
                    - time.mktime(time.strptime(start, "%Y-%m-%d"))
                ) / 86400
            except ValueError:
                continue
            if not 300 <= days <= 400:
                continue
        # El mismo año puede aparecer en varios filings (reexpresado):
        # la iteración en orden deja el más reciente.
        out[end[:4]] = entry
    return out


def parse_companyfacts(facts_json: dict) -> list[dict]:
    """Convierte el companyfacts de EDGAR en periodos anuales normalizados.

    Función pura (testeable con fixtures sin red). Devuelve una lista
    cronológica de dicts con end_date y los campos disponibles; un campo que
    la empresa no reporta queda como None, nunca se inventa.
    """
    gaap = (facts_json.get("facts") or {}).get("us-gaap") or {}
    dei = (facts_json.get("facts") or {}).get("dei") or {}

    per_year: dict[str, dict] = {}

    def collect(field: str, tags: list[str], unit_names: tuple[str, ...], is_flow: bool):
        for tag in tags:
            units_by_name = (gaap.get(tag) or {}).get("units") or {}
            units = next(
                (units_by_name[u] for u in unit_names if u in units_by_name), None
            )
            if not units:
                continue
            annual = _annual_entries(units, is_flow)
            if not annual:
                continue
            for year, entry in annual.items():
                period = per_year.setdefault(year, {"end_date": entry["end"]})
                if field not in period:
                    period[field] = entry.get("val")
                    if entry["end"] > period["end_date"]:
                        period["end_date"] = entry["end"]
            return  # primera etiqueta con datos anuales gana

    for field, tags in _FLOW_TAGS.items():
        collect(field, tags, ("USD",), is_flow=True)
    for field, tags in _BALANCE_TAGS.items():
        collect(field, tags, ("USD",), is_flow=False)
    collect("eps_diluted", ["EarningsPerShareDiluted"], ("USD/shares",), is_flow=True)

    # Acciones en circulación (dei, dato instantáneo por año).
    shares_units = (
        (dei.get("EntityCommonStockSharesOutstanding") or {}).get("units") or {}
    ).get("shares") or []
    for entry in shares_units:
        year = (entry.get("end") or "")[:4]
        if year in per_year and "shares_outstanding" not in per_year[year]:
            per_year[year]["shares_outstanding"] = entry.get("val")

    periods = [
        {"fiscal_year": year, **fields}
        for year, fields in sorted(per_year.items())
        if fields.get("revenue") is not None or fields.get("total_assets") is not None
    ]
    return periods[-8:]  # últimos 8 ejercicios: suficiente para CAGR 5A y F-score


class EdgarProvider(DataProvider):
    name = "edgar"
    capabilities = frozenset({"financials", "filings"})

    def __init__(self, user_agent: str, timeout: float = 30.0):
        self.user_agent = user_agent
        self.timeout = timeout

    def _get(self, url: str) -> dict:
        try:
            resp = httpx.get(
                url, headers={"User-Agent": self.user_agent}, timeout=self.timeout
            )
        except httpx.HTTPError as exc:
            raise ProviderError(f"edgar: error de red: {exc}") from exc
        if resp.status_code == 404:
            raise DataNotFoundError("edgar: recurso no encontrado")
        if resp.status_code == 403:
            raise ProviderError(
                "edgar: acceso rechazado — revisa que EDGAR_USER_AGENT tenga "
                "tu nombre y email reales (requisito de la SEC)"
            )
        if resp.status_code != 200:
            raise ProviderError(f"edgar: HTTP {resp.status_code}")
        return resp.json()

    def _cik_for(self, symbol: str) -> int:
        now = time.time()
        if not _cik_cache["map"] or now - _cik_cache["fetched_at"] > _CIK_TTL:
            data = self._get(TICKER_MAP_URL)
            _cik_cache["map"] = {
                row["ticker"].upper(): int(row["cik_str"]) for row in data.values()
            }
            _cik_cache["fetched_at"] = now
        cik = _cik_cache["map"].get(symbol.upper())
        if cik is None:
            raise DataNotFoundError(
                f"edgar: {symbol} no está registrado en la SEC (¿empresa no-EE. UU. o ETF?)"
            )
        return cik

    def get_financials(self, symbol: str) -> dict:
        cik = self._cik_for(symbol)
        facts = self._get(FACTS_URL.format(cik=cik))
        periods = parse_companyfacts(facts)
        if not periods:
            raise DataNotFoundError(f"edgar: sin estados financieros anuales para {symbol}")
        return {
            "symbol": symbol.upper(),
            "cik": cik,
            "entity": facts.get("entityName"),
            "periods": periods,
            "as_of": iso_utc(),
        }

    def get_filings(self, symbol: str) -> dict:
        cik = self._cik_for(symbol)
        data = self._get(SUBMISSIONS_URL.format(cik=cik))
        recent = (data.get("filings") or {}).get("recent") or {}
        forms = recent.get("form") or []
        dates = recent.get("filingDate") or []
        accessions = recent.get("accessionNumber") or []
        docs = recent.get("primaryDocument") or []

        filings, insider = [], []
        for form, date, accn, doc in zip(forms, dates, accessions, docs):
            entry = {
                "type": form,
                "filed_at": date,
                "accession_no": accn,
                "url": (
                    f"https://www.sec.gov/Archives/edgar/data/{cik}/"
                    f"{accn.replace('-', '')}/{doc}"
                ),
            }
            if form in _INSIDER_FORMS and len(insider) < 40:
                insider.append(entry)
            elif form in _COMPANY_FORMS and len(filings) < 40:
                filings.append(entry)
        return {
            "symbol": symbol.upper(),
            "cik": cik,
            "filings": filings,
            "insider_filings": insider,
            "as_of": iso_utc(),
        }
