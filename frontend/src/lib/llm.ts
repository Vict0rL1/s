import { useEffect, useState } from 'react'
import { api } from '../api/client'
import type { LlmStatus } from '../api/types'

// El estado de la capa de IA no cambia sin reiniciar el backend: se pide una
// sola vez y se comparte entre todos los componentes que lo consultan.
let pending: Promise<LlmStatus> | null = null

function load(): Promise<LlmStatus> {
  if (pending === null) {
    pending = api.llmStatus().catch((err) => {
      pending = null // un fallo puntual no debe fijar el estado para siempre
      throw err
    })
  }
  return pending
}

/**
 * Estado de la capa de IA, o `null` mientras se resuelve (o si falla).
 *
 * Los botones de interpretación se muestran solo con `configured === true`:
 * sin `ANTHROPIC_API_KEY` el endpoint devuelve 503, así que ofrecerlos sería
 * ofrecer un error.
 */
export function useLlmStatus(): LlmStatus | null {
  const [status, setStatus] = useState<LlmStatus | null>(null)

  useEffect(() => {
    let alive = true
    load().then(
      (s) => alive && setStatus(s),
      () => undefined, // sin estado conocido, la IA se trata como apagada
    )
    return () => {
      alive = false
    }
  }, [])

  return status
}
