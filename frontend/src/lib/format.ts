// Formateo de números en español. Un valor ausente se muestra como "—",
// nunca como 0: la ausencia de dato es información.

const num = new Intl.NumberFormat('es', { maximumFractionDigits: 2 })

export function fmtNumber(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return value.toLocaleString('es', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

export function fmtPct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return `${(value * 100).toLocaleString('es', { maximumFractionDigits: digits })} %`
}

export function fmtChangePct(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toLocaleString('es', { maximumFractionDigits: 2 })} %`
}

export function fmtBig(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  const abs = Math.abs(value)
  if (abs >= 1e12) return `${num.format(value / 1e12)} B` // billón (es) = 1e12
  if (abs >= 1e9) return `${num.format(value / 1e9)} mM`
  if (abs >= 1e6) return `${num.format(value / 1e6)} M`
  return num.format(value)
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' })
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.round(ms / 60000)
  if (min < 1) return 'hace segundos'
  if (min < 60) return `hace ${min} min`
  const hours = Math.round(min / 60)
  if (hours < 48) return `hace ${hours} h`
  return `hace ${Math.round(hours / 24)} días`
}
