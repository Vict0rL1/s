"""Tests del sesgo de anticipación: la parte que más fácil se cuela.

Un backtest con look-ahead da tasas de acierto espectaculares que se evaporan
en vivo. Estos tests existen para que ese sesgo no vuelva a entrar sin que
alguien lo note.
"""

from __future__ import annotations

from datetime import date

from app.analysis.backtest import point_in_time_period
from app.providers.edgar import _annual_entries


def hecho(val, filed, form="10-K", end="2021-12-31", start="2021-01-01"):
    return {"val": val, "filed": filed, "form": form, "fp": "FY", "end": end, "start": start}


def test_se_conserva_la_cifra_ORIGINAL_no_la_reexpresada():
    """Puntuar 2021 con una cifra corregida en 2023 usa información que nadie
    tenía entonces. Filtrar por fecha de filing no basta si el VALOR ya es el
    reexpresado."""
    entries = _annual_entries(
        [
            hecho(100.0, "2022-02-15"),   # como se publicó
            hecho(85.0, "2023-02-20"),    # reexpresada un año después
        ],
        is_flow=True,
    )
    assert entries["2021"]["val"] == 100.0
    assert entries["2021"]["filed"] == "2022-02-15"


def test_el_orden_de_llegada_no_cambia_el_resultado():
    """La reexpresión puede venir antes en la lista; lo que manda es la fecha."""
    a = _annual_entries([hecho(85.0, "2023-02-20"), hecho(100.0, "2022-02-15")], True)
    b = _annual_entries([hecho(100.0, "2022-02-15"), hecho(85.0, "2023-02-20")], True)
    assert a["2021"]["val"] == b["2021"]["val"] == 100.0


# --- Cuándo se pudo conocer un ejercicio ------------------------------------


def test_se_usa_la_fecha_real_de_publicacion_del_dato():
    """EDGAR la entrega por hecho: es exacta y evita suponer un retardo."""
    periodos = [{"end_date": "2021-12-31", "filed_at": "2022-02-15", "revenue": 100}]
    assert point_in_time_period(periodos, [], date(2022, 2, 14)) is None
    assert point_in_time_period(periodos, [], date(2022, 2, 16)) is not None


def test_sin_fecha_del_dato_se_cae_al_filing_y_luego_a_90_dias():
    """Se degrada, nunca se adelanta."""
    periodos = [{"end_date": "2021-12-31", "revenue": 100}]
    filings = [{"type": "10-K", "filed_at": "2022-03-01"}]
    assert point_in_time_period(periodos, filings, date(2022, 2, 20)) is None
    assert point_in_time_period(periodos, filings, date(2022, 3, 2)) is not None

    # Sin filings conocidos, el retardo conservador de 90 días.
    assert point_in_time_period(periodos, [], date(2022, 2, 1)) is None
    assert point_in_time_period(periodos, [], date(2022, 4, 15)) is not None


def test_nunca_se_adelanta_la_disponibilidad():
    """El cierre del ejercicio NO es la fecha en que se conoce: entre uno y
    otro hay meses, y usarlos es el error clásico."""
    periodos = [{"end_date": "2021-12-31", "revenue": 100}]
    assert point_in_time_period(periodos, [], date(2022, 1, 2)) is None
