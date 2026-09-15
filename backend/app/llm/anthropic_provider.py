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

    def extract(self, system: str, prompt: str, schema: type) -> dict:
        """Extracción validada contra un esquema Pydantic.

        `messages.parse()` con `output_format` obliga al modelo a producir una
        estructura que valida contra el esquema — no es «pedir JSON y cruzar los
        dedos»: la restricción se aplica en la generación, así que no hay JSON
        mal formado que parchear ni campos que aparezcan un trimestre y falten al
        siguiente. Para un análisis que existe para compararse consigo mismo en
        el tiempo, esa garantía es el requisito, no un detalle.

        Se usa streaming porque un 10-Q entero puede tardar minutos: sin él la
        petición choca contra el timeout HTTP del SDK y se pierde el trabajo
        (y el gasto) a mitad.
        """
        try:
            with self.client.beta.messages.stream(
                model=self.model,
                max_tokens=16000,
                # Mismo respaldo que `interpret`, y aquí hace más falta: los
                # factores de riesgo de un 10-K describen incidentes de
                # ciberseguridad, litigios y sanciones, que es contenido benigno
                # con forma de contenido delicado. Sin el respaldo, un trimestre
                # entero se queda sin analizar por el tema del que hablaba.
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
                system=system,
                messages=[{"role": "user", "content": prompt}],
                # Pensar antes de extraer: separar previsión de resultado, o
                # localizar la frase exacta que respalda un dato en cuarenta
                # páginas de MD&A, es justo el trabajo que mejora con ello.
                thinking={"type": "adaptive"},
                output_format=schema,
            ) as stream:
                response = stream.get_final_message()
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

        if response.stop_reason == "refusal":
            raise LLMUnavailableError("El modelo declinó analizar este documento")
        if response.stop_reason == "max_tokens":
            # Con salida estructurada, quedarse sin tokens deja el objeto a
            # medias. Decirlo es mejor que servir un trimestre al que le faltan
            # riesgos sin que nadie sepa que le faltan.
            raise LLMUnavailableError(
                "La extracción se cortó por longitud: el documento produjo más "
                "campos de los que caben en una respuesta"
            )
        parsed = getattr(response, "parsed_output", None)
        if parsed is None:
            raise LLMUnavailableError("El modelo no devolvió una estructura válida")

        usage = response.usage
        return {
            "data": parsed.model_dump(),
            "model": response.model,
            "usage": {
                "entrada": getattr(usage, "input_tokens", None),
                "salida": getattr(usage, "output_tokens", None),
                "cache_lectura": getattr(usage, "cache_read_input_tokens", None),
            },
        }

    def contar_tokens(self, system: str, prompt: str) -> int | None:
        try:
            return self.client.messages.count_tokens(
                model=self.model,
                system=system,
                messages=[{"role": "user", "content": prompt}],
            ).input_tokens
        except anthropic.AnthropicError:
            # Contar es para poder enseñar el coste antes de gastarlo; si falla,
            # no debe impedir el análisis. None significa «no se pudo estimar»,
            # que no es lo mismo que cero.
            return None
