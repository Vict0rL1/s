"""Proveedor LLM sobre el API de Claude (SDK oficial de Anthropic).

- Modelo configurable vía ANTHROPIC_MODEL (por defecto claude-opus-5).
- max_tokens acotado: las interpretaciones son deliberadamente cortas.
- Fallback del lado del servidor activado por defecto: si los clasificadores
  de seguridad del modelo declinan una petición benigna (p. ej. noticias de
  ciberseguridad de una empresa cotizada), el API la re-sirve con el modelo
  de respaldo recomendado en la misma llamada.
"""

from __future__ import annotations

import anthropic

from app.llm.base import LLMProvider, LLMUnavailableError


class AnthropicProvider(LLMProvider):
    name = "anthropic"

    def __init__(self, api_key: str, model: str = "claude-opus-5"):
        self.client = anthropic.Anthropic(api_key=api_key)
        self.model = model

    def interpret(self, system: str, prompt: str) -> dict:
        try:
            response = self.client.beta.messages.create(
                model=self.model,
                max_tokens=2048,  # interpretación corta a propósito: acota el coste
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
                system=system,
                messages=[{"role": "user", "content": prompt}],
            )
        except anthropic.AuthenticationError as exc:
            raise LLMUnavailableError("ANTHROPIC_API_KEY inválida") from exc
        except anthropic.RateLimitError as exc:
            raise LLMUnavailableError(
                "Límite de uso del API de Claude alcanzado; reintenta en unos minutos"
            ) from exc
        except anthropic.APIStatusError as exc:
            raise LLMUnavailableError(f"Error del API de Claude: {exc.status_code}") from exc
        except anthropic.APIConnectionError as exc:
            raise LLMUnavailableError("Sin conexión con el API de Claude") from exc

        # Los clasificadores pueden declinar (HTTP 200 + stop_reason refusal);
        # comprobar SIEMPRE antes de leer content.
        if response.stop_reason == "refusal":
            raise LLMUnavailableError(
                "El modelo declinó interpretar este contenido"
            )
        text = next((b.text for b in response.content if b.type == "text"), "")
        if not text:
            raise LLMUnavailableError("Respuesta vacía del modelo")
        return {"content": text, "model": response.model}
