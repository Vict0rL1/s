import { EXPENSE_CATEGORIES, type Budgets, type Transaction } from '../types'
import { formatCurrency } from '../lib/format'

interface Props {
  transactions: Transaction[]
  budgets: Budgets
  onChange: (category: string, amount: number) => void
}

export function CategoryBudgets({ transactions, budgets, onChange }: Props) {
  const spentByCategory = transactions
    .filter((t) => t.type === 'expense')
    .reduce<Record<string, number>>((acc, t) => {
      acc[t.category] = (acc[t.category] ?? 0) + t.amount
      return acc
    }, {})

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {EXPENSE_CATEGORIES.map((category) => {
        const spent = spentByCategory[category] ?? 0
        const budget = budgets[category] ?? 0
        const pct = budget > 0 ? Math.min((spent / budget) * 100, 100) : 0
        const overBudget = budget > 0 && spent > budget

        let barColor = 'bg-emerald-500'
        if (budget > 0) {
          if (overBudget) barColor = 'bg-rose-500'
          else if (spent / budget > 0.75) barColor = 'bg-amber-500'
        }

        return (
          <div
            key={category}
            className="rounded-2xl border border-slate-800 bg-slate-900 p-5"
          >
            <div className="flex items-center justify-between">
              <span className="font-medium text-slate-100">{category}</span>
              <label className="flex items-center gap-1 text-xs text-slate-400">
                Budget
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={budget || ''}
                  onChange={(e) => onChange(category, Number(e.target.value) || 0)}
                  placeholder="0"
                  className="w-20 rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-right text-slate-100 outline-none focus:border-indigo-500"
                />
              </label>
            </div>

            <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-800">
              <div
                className={`h-full rounded-full transition-all ${barColor}`}
                style={{ width: `${pct}%` }}
              />
            </div>

            <div className="mt-2 flex items-center justify-between text-sm">
              <span className={overBudget ? 'font-medium text-rose-400' : 'text-slate-400'}>
                {formatCurrency(spent)} spent
              </span>
              <span className="text-slate-500">
                {budget > 0 ? `of ${formatCurrency(budget)}` : 'no budget set'}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
