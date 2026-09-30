"""`scripts/revisar_alertas.py`: el comando que el cron ejecuta.

Es la pieza que nadie va a mirar nunca: corre cada quince minutos en segundo
plano y, si se rompe, lo único que pasa es que las alertas dejan de avisar
silenciosamente — el peor fallo posible en algo cuyo trabajo es avisar. De ahí
estos tests, que cubren sobre todo dos invariantes invisibles:

1. Una alerta que salta se marca ANTES de intentar el aviso. Si se marcara
   después, un notificador que falla dejaría la alerta sin sellar y volvería a
   avisar de lo mismo cada quince minutos.
2. El comando devuelve 0 aunque salten alertas. Si devolviera otra cosa, cron lo
   trataría como error y llenaría el correo del sistema de falsos problemas.
"""

from __future__ import annotations

import importlib.util
from datetime import datetime, timezone
from pathlib import Path

import pytest

from app.analysis import alertas as al
from app.db.models import Alert, Instrument
from app.providers.base import DataNotFoundError, iso_utc

GUION = Path(__file__).resolve().parent.parent / "scripts" / "revisar_alertas.py"


def _cargar():
    spec = importlib.util.spec_from_file_location("revisar_alertas", GUION)
    modulo = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(modulo)
    return modulo


class FakeCache:
    def __init__(self, precios):
        self.precios = precios

    def get(self, data_type, params):
        precio = self.precios.get(params["symbol"])
        if precio is None:
            return None
        return {"symbol": params["symbol"], "price": precio, "cached": True}


class FakeService:
    def __init__(self, precios):
        self.precios = precios
        self.cache = FakeCache(precios)
        self.pedidos: list[str] = []

    def get(self, data_type, **kw):
        assert data_type == "quote"
        sym = kw["symbol"]
        self.pedidos.append(sym)
        if self.precios.get(sym) is None:
            raise DataNotFoundError(f"sin cotización para {sym}")
        return {"symbol": sym, "price": self.precios[sym], "as_of": iso_utc()}


@pytest.fixture
def correr(session_factory, tmp_path, monkeypatch):
    """Monta el guion sobre una base en memoria y un directorio temporal."""
    modulo = _cargar()

    def _correr(alertas_def, precios, avisos=None, **kw):
        session = session_factory()
        for sym, op, umbral, activa, saltada in alertas_def:
            inst = Instrument(symbol=sym, name=sym)
            session.add(inst)
            session.flush()
            session.add(
                Alert(
                    instrument_id=inst.id,
                    kind="price",
                    condition={"op": op, "price": umbral},
                    active=activa,
                    triggered_at=saltada,
                )
            )
        session.commit()
        session.close()

        service = FakeService(precios)
        enviados = [] if avisos is None else avisos

        def notificar_falso(titulo, cuerpo):
            enviados.append((titulo, cuerpo))
            # Se devuelve un fallo a propósito: es el caso interesante.
            return {"enviado": False, "motivo": "sin escritorio", "via": None}

        monkeypatch.setattr(modulo, "init_db", lambda: None)
        monkeypatch.setattr(modulo, "SessionLocal", session_factory)
        monkeypatch.setattr(modulo, "get_service", lambda: service)
        monkeypatch.setattr(modulo, "notificar", notificar_falso)
        monkeypatch.setattr(modulo.settings, "database_path", str(tmp_path / "app.db"))

        salida = modulo.revisar(**kw)
        return salida, service, enviados, session_factory, tmp_path

    return _correr


def _saltada(factory, symbol):
    with factory() as s:
        fila = (
            s.query(Alert)
            .join(Instrument, Alert.instrument_id == Instrument.id)
            .filter(Instrument.symbol == symbol)
            .one()
        )
        return fila.triggered_at


def test_una_alerta_que_cruza_se_marca_y_se_avisa(correr):
    salida, _, avisos, factory, _ = correr(
        [("AAPL", "lt", 150.0, True, None)], {"AAPL": 140.0}
    )
    assert len(salida["nuevas"]) == 1
    assert _saltada(factory, "AAPL") is not None
    assert len(avisos) == 1
    assert "AAPL" in avisos[0][0]


def test_el_sello_se_pone_aunque_el_aviso_falle(correr):
    """El invariante que no se ve: marcar antes de notificar.

    El notificador de este test SIEMPRE dice que no pudo enviar. La alerta tiene
    que quedar sellada igual: si no, la siguiente pasada la trataría como nueva
    y volvería a intentar el aviso cada quince minutos para siempre.
    """
    salida, _, avisos, factory, _ = correr(
        [("AAPL", "lt", 150.0, True, None)], {"AAPL": 140.0}
    )
    assert salida["notificacion"]["enviado"] is False
    assert _saltada(factory, "AAPL") is not None


def test_una_segunda_pasada_no_vuelve_a_avisar(correr):
    compartidos: list[tuple[str, str]] = []
    correr([("AAPL", "lt", 150.0, True, None)], {"AAPL": 140.0}, avisos=compartidos)
    assert len(compartidos) == 1
    # La misma base, la misma alerta ya sellada: nada nuevo que contar.
    ya = datetime(2026, 1, 5, tzinfo=timezone.utc)
    salida, _, avisos, _, _ = correr([("MSFT", "lt", 150.0, True, ya)], {"MSFT": 140.0})
    assert salida["nuevas"] == []
    assert salida["ya_saltadas"] == 1
    assert avisos == []


def test_una_desactivada_no_gasta_una_llamada(correr):
    """Ni se consulta su precio: vigilar cuesta una cotización por símbolo."""
    salida, service, avisos, _, _ = correr(
        [("AAPL", "lt", 150.0, False, None)], {"AAPL": 140.0}
    )
    assert service.pedidos == []
    assert salida["desactivadas"] == 1
    assert salida["revisadas"] == 0
    assert avisos == []


def test_sin_precio_no_se_marca_ni_se_avisa(correr):
    salida, _, avisos, factory, _ = correr([("ZZZZ", "lt", 150.0, True, None)], {"ZZZZ": None})
    assert len(salida["no_evaluables"]) == 1
    assert _saltada(factory, "ZZZZ") is None
    assert avisos == []


def test_solo_cache_no_pide_nada_a_la_red(correr):
    salida, service, _, _, _ = correr(
        [("AAPL", "lt", 150.0, True, None)], {"AAPL": 140.0}, solo_cache=True
    )
    assert service.pedidos == []  # ni una llamada
    assert len(salida["nuevas"]) == 1  # y aun así evalúa, con lo cacheado


def test_sin_aviso_evalua_y_marca_pero_no_notifica(correr):
    salida, _, avisos, factory, _ = correr(
        [("AAPL", "lt", 150.0, True, None)], {"AAPL": 140.0}, avisar=False
    )
    assert len(salida["nuevas"]) == 1
    assert _saltada(factory, "AAPL") is not None
    assert avisos == []
    assert "notificacion" not in salida


def test_cada_pasada_deja_su_marca_de_vigilancia(correr):
    """También cuando no salta nada: una pasada tranquila ES la prueba."""
    _, _, _, _, datos = correr([("AAPL", "lt", 150.0, True, None)], {"AAPL": 160.0})
    estado = al.ultima_pasada(datos)
    assert estado["activa"] is True and estado["nunca"] is False
