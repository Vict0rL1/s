"""Interfaz de la capa de interpretación por LLM.

Principios que esta capa impone por diseño:
- El LLM NUNCA se llama automáticamente: solo cuando el usuario lo pide
  (botón explícito). Eso minimiza el gasto en el API de Anthropic.
- Toda salida se registra en la tabla llm_outputs y viaja marcada como
  generada por IA — jamás se mezcla con lo calculado a partir de datos.
- El proveedor es intercambiable (Anthropic hoy; otro mañana) sin tocar
  los endpoints.
"""

from __future__ import annotations

from abc import ABC, abstractmethod


class LLMUnavailableError(Exception):
    """El proveedor no está configurado o rechazó la petición."""


class LLMProvider(ABC):
    name: str = "base"

    @abstractmethod
    def interpret(self, system: str, prompt: str) -> dict:
        """-> {content: str (markdown), model: str}"""
        ...

    def extract(self, system: str, prompt: str, schema: type) -> dict:
        """Extracción con forma FIJA -> {data: dict, model: str, usage: dict}.

        `schema` es un modelo Pydantic. La diferencia con `interpret` no es de
        formato sino de propósito: `interpret` produce prosa para leer, esto
        produce campos para comparar en el tiempo. Un análisis de resultados solo
        sirve si el de este trimestre tiene exactamente la misma forma que el del
        anterior, y eso no se consigue pidiendo JSON por favor en el prompt.
        """
        raise LLMUnavailableError(f"{self.name} no ofrece extracción estructurada")

    def contar_tokens(self, system: str, prompt: str) -> int | None:
        """Tokens de entrada ANTES de llamar, para poder enseñar el coste.

        Devuelve None si el proveedor no sabe contar: quien llama debe distinguir
        «no se pudo estimar» de «sale gratis».
        """
        return None
