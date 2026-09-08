import { useEffect, useState } from 'react'
import { api } from '../api/client'
import type { ProviderUsage } from '../api/types'
import { useLlmStatus } from '../lib/llm'

function windowLabel(seconds: number): string {
  if (seconds <= 60) return 'min'
  if (seconds <= 3600) return 'h'
  return 'día'
}

// Contador visible de llamadas restantes por API: con tiers gratuitos,
// saber cuánto queda es parte del flujo de trabajo, no un adorno.
export function ApiUsageBar() {
  const [usage, setUsage] = useState<ProviderUsage[]>([])
  const llm = useLlmStatus()

  useEffect(() => {
    let alive = true
    const load = () => {
      api.usage().then(
        (data) => alive && setUsage(data),
        () => undefined, // el contador nunca debe romper la UI
      )
    }
    load()
    const timer = setInterval(load, 30_000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  if (usage.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1 text-[10px] text-slate-400">
      <span className="w-full uppercase tracking-wider text-slate-300">APIs</span>
      {usage.map((u) => (
        <span
          key={u.provider}
          title={
            u.configured
              ? `${u.used} usadas de ${u.limit} por ${windowLabel(u.window_seconds)}`
              : 'Sin API key configurada (.env)'
          }
          className={`rounded-full px-2 py-0.5 ${
            !u.configured
              ? 'bg-slate-100 text-slate-400 line-through'
              : u.remaining < u.limit * 0.2
                ? 'bg-red-50 text-red-700'
                : 'bg-slate-100 text-slate-600'
          }`}
        >
          {u.provider} {u.remaining}/{u.limit}
        </span>
      ))}
      {llm && (
        <span
          title={
            llm.configured
              ? `Capa de IA activa (${llm.model}). Se factura por tokens: solo corre cuando pulsas un botón de interpretación.`
              : 'Sin ANTHROPIC_API_KEY en .env. La app funciona igual; solo faltan las interpretaciones escritas.'
          }
          className={`rounded-full px-2 py-0.5 ${
            llm.configured
              ? 'bg-violet-50 text-violet-700'
              : 'bg-slate-100 text-slate-400 line-through'
          }`}
        >
          IA {llm.configured ? 'activa' : 'off'}
        </span>
      )}
    </div>
  )
}
