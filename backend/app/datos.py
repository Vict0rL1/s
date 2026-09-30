"""Qué sabemos y qué no. El estado del dato como propiedad del sistema.

Hasta ahora «no lo sé» se representaba con `None`, y `None` significaba cuatro
cosas distintas a la vez:

    - el dato no existe (una empresa sin dividendo no tiene rentabilidad
      por dividendo, y eso es un hecho, no una carencia)
    - no se pudo consultar (la API falló, el límite se agotó)
    - se consultó hace mucho y puede estar obsoleto
    - se consultó y lo que vino está corrupto

Las cuatro se pintaban igual en pantalla, «—», y —esto es lo grave— aguas
abajo se sustituían por el valor neutro más cercano: 0, `False`, `PASS`. El
problema es que en un sistema de inversión **el valor neutro casi nunca es
neutro**. Deuda desconocida tratada como deuda cero infla la valoración un
95 %. Volatilidad desconocida excluida del cálculo baja el riesgo aparente un
42 %. En los dos casos, tener MENOS información produce una recomendación MÁS
agresiva, que es exactamente al revés de como debe comportarse.

## La regla

**La ignorancia encoge la posición, no la agranda.** Si un dato obligatorio
para una decisión no está, la decisión es `indeterminada` y dice qué falta. No
se calcula un tamaño sobre un supuesto que nadie declaró.

## Por qué así y no con un tipo envolvente en todas partes

Este módulo NO pretende que toda la app pase a manejar `Dato`. Eso sería una
refactorización enorme para un beneficio que se consigue en dos sitios: la
frontera de entrada (donde el dato llega del proveedor) y los puntos donde se
decide (donde la ausencia tiene consecuencias). En medio, `None` sigue valiendo.

Lo que sí es de uso general son los saneadores: `numero()` y `precio()`. Son
la respuesta a que `NaN` sea *truthy* y a que `float("inf")` pase cualquier
comparación. Un `if not precio` no protege de ninguno de los dos.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from enum import Enum
from typing import Any


class Estado(str, Enum):
    """Los cuatro estados. `str` para que serialicen solos a JSON."""

    VALIDO = "valido"
    # No se sabe. Incluye «no existe» y «no se pudo consultar»: para quien
    # decide son lo mismo —no hay número— y el motivo distingue el caso.
    DESCONOCIDO = "desconocido"
    # Hay número, pero viejo. Es utilizable diciendo su edad; un precio de hace
    # diez minutos sirve para casi todo, y esconderlo obligaría a apagar la
    # pantalla entera por una API caída.
    VIEJO = "viejo"
    # Se intentó, vino algo, y ese algo no vale: NaN, negativo donde no puede
    # serlo, texto donde iba un número. Se separa de DESCONOCIDO porque exige
    # una acción distinta: DESCONOCIDO se reintenta, ERROR se investiga.
    ERROR = "error"


@dataclass(frozen=True)
class Dato:
    """Un valor con su procedencia y su estado. Inmutable a propósito.

    Cumple el principio «toda cifra lleva fuente y fecha» haciéndolo difícil de
    incumplir: para construir un `Dato` válido hay que decir de dónde salió.
    """

    valor: Any
    estado: Estado = Estado.VALIDO
    motivo: str | None = None
    fuente: str | None = None
    fecha: str | None = None

    # --- Constructores, que se leen mejor que el constructor por defecto ---

    @classmethod
    def valido(cls, valor: Any, fuente: str | None = None, fecha: str | None = None) -> Dato:
        return cls(valor, Estado.VALIDO, None, fuente, fecha)

    @classmethod
    def desconocido(cls, motivo: str, fuente: str | None = None) -> Dato:
        return cls(None, Estado.DESCONOCIDO, motivo, fuente, None)

    @classmethod
    def viejo(
        cls, valor: Any, motivo: str, fuente: str | None = None, fecha: str | None = None
    ) -> Dato:
        return cls(valor, Estado.VIEJO, motivo, fuente, fecha)

    @classmethod
    def error(cls, motivo: str, fuente: str | None = None) -> Dato:
        return cls(None, Estado.ERROR, motivo, fuente, None)

    # --- Consultas ---

    @property
    def hay_valor(self) -> bool:
        """¿Hay un número con el que operar? VIEJO cuenta: viejo no es ausente."""
        return self.estado in (Estado.VALIDO, Estado.VIEJO) and self.valor is not None

    @property
    def es_fiable(self) -> bool:
        """Solo VALIDO. Para decisiones que no deben tomarse con dato viejo."""
        return self.estado is Estado.VALIDO and self.valor is not None

    def o(self, defecto: Any, porque: str) -> Any:
        """El valor, o un defecto que hay que JUSTIFICAR por escrito.

        El segundo argumento es obligatorio a propósito. Todos los fallos de
        esta familia empezaron con un `or 0` que nadie escribió conscientemente;
        tener que redactar el motivo obliga a mirar si el defecto es de verdad
        neutro. Casi nunca lo es.
        """
        if not porque:
            raise ValueError("Un valor por defecto sin motivo escrito no se acepta.")
        return self.valor if self.hay_valor else defecto

    def a_json(self) -> dict:
        return {
            "valor": self.valor,
            "estado": self.estado.value,
            "motivo": self.motivo,
            "fuente": self.fuente,
            "fecha": self.fecha,
        }


# --- Saneadores. Aquí es donde se paran NaN e infinito. --------------------


def numero(valor: Any) -> float | None:
    """Un `float` finito, o `None`. Nunca `NaN` ni `±inf`.

    `NaN` es el caso peligroso porque es *truthy* —`if not nan` es `False`, o
    sea que pasa cualquier guarda escrita así— y porque toda comparación con él
    devuelve `False`, lo que hace que los `elif` encadenados caigan en la rama
    final sin que nada lo señale. Un `NaN` no se propaga a gritos: se propaga en
    silencio y sale por el otro lado convertido en una recomendación.
    """
    if valor is None or isinstance(valor, bool):
        # `bool` se descarta a propósito: `True` es 1.0 en Python y un `True`
        # colado donde iba un precio daría un dólar sin que nadie se entere.
        return None
    try:
        f = float(valor)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def precio(valor: Any) -> float | None:
    """Un precio utilizable: finito y estrictamente positivo.

    Cero y negativo se rechazan porque ningún instrumento cotiza ahí. Si llega
    uno, el dato está corrupto — y un precio corrupto que pasa es una compra
    dimensionada sobre basura.
    """
    f = numero(valor)
    return f if f is not None and f > 0 else None


def porcentaje(valor: Any, maximo: float = 1000.0) -> float | None:
    """Un porcentaje finito y no negativo dentro de un tope de cordura.

    El tope existe para volatilidades y crecimientos: un 40.000 % anual no es un
    dato, es un error de unidades o de parseo.
    """
    f = numero(valor)
    if f is None or f < 0 or f > maximo:
        return None
    return f


def todos_finitos(*valores: Any) -> bool:
    """¿Se puede operar con todos? Una guarda para fórmulas de varios términos."""
    return all(numero(v) is not None for v in valores)


# --- Lo que falta, contado y con nombre ------------------------------------


def faltantes(requeridos: dict[str, Any]) -> list[str]:
    """Los nombres de los datos obligatorios que no son números utilizables.

    Devuelve NOMBRES, no un booleano, porque «no se pudo decidir» sin decir qué
    faltaba es tan inútil como decidir mal: no se puede arreglar lo que no se
    sabe que falta.
    """
    return sorted(k for k, v in requeridos.items() if numero(v) is None)


def indeterminado(faltan: list[str], contexto: str = "") -> dict:
    """La forma canónica de «no se puede decidir», lista para viajar a la UI.

    Existe para que todos los módulos digan esto igual. Un estado de «no sé»
    que cada sitio redacta a su manera acaba siendo invisible en la pantalla.
    """
    lista = ", ".join(faltan) if faltan else "datos obligatorios"
    return {
        "indeterminado": True,
        "faltan": faltan,
        "motivo": (
            f"No se puede decidir{f' {contexto}' if contexto else ''}: falta {lista}. "
            "Esto NO es una recomendación neutra ni un «no pasa nada» — es que el "
            "sistema no tiene con qué evaluarlo."
        ),
    }
