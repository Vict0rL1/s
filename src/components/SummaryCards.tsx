import { formatCurrency } from '../lib/format'

interface Props {
  income: number
  expenses: number
}

export function SummaryCards({ income, expenses }: Props) {
  const balance = income - expenses

  const cards = [
    { label: 'Income', value: income, accent: 'text-emerald-400' },
    { label: 'Expenses', value: expenses, accent: 'text-rose-400' },
    {
      label: 'Balance',
      value: balance,
      accent: balance >= 0 ? 'text-emerald-400' : 'text-rose-400',
    },
  ]

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      {cards.map((card) => (
        <div
          key={card.label}
          className="rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-sm"
        >
          <p className="text-sm font-medium text-slate-400">{card.label}</p>
          <p className={`mt-2 text-2xl font-semibold ${card.accent}`}>
            {formatCurrency(card.value)}
          </p>
        </div>
      ))}
    </div>
  )
}
