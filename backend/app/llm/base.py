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
