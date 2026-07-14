import { formatMonthLabel } from '../lib/format'

interface Props {
  monthKey: string
  onChange: (monthKey: string) => void
}

function shiftMonth(monthKey: string, delta: number) {
  const [year, month] = monthKey.split('-').map(Number)
  const date = new Date(year, month - 1 + delta, 1)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

export function MonthSelector({ monthKey, onChange }: Props) {
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={() => onChange(shiftMonth(monthKey, -1))}
        className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-slate-300 hover:bg-slate-700"
        aria-label="Previous month"
      >
        &larr;
      </button>
      <span className="min-w-[10rem] text-center font-medium text-slate-100">
        {formatMonthLabel(monthKey)}
      </span>
      <button
        type="button"
        onClick={() => onChange(shiftMonth(monthKey, 1))}
        className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-slate-300 hover:bg-slate-700"
        aria-label="Next month"
      >
        &rarr;
      </button>
    </div>
  )
}
