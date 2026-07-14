import type { Transaction } from '../types'
import { formatCurrency } from '../lib/format'

interface Props {
  transactions: Transaction[]
  onDelete: (id: string) => void
}

export function TransactionList({ transactions, onDelete }: Props) {
  if (transactions.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-800 p-10 text-center text-slate-500">
        No transactions yet for this month.
      </div>
    )
  }

  const sorted = [...transactions].sort((a, b) => b.date.localeCompare(a.date))

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
      <table className="w-full text-left text-sm">
        <thead className="bg-slate-800/50 text-slate-400">
          <tr>
            <th className="px-4 py-3 font-medium">Date</th>
            <th className="px-4 py-3 font-medium">Description</th>
            <th className="px-4 py-3 font-medium">Category</th>
            <th className="px-4 py-3 text-right font-medium">Amount</th>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800">
          {sorted.map((t) => (
            <tr key={t.id} className="text-slate-200">
              <td className="whitespace-nowrap px-4 py-3 text-slate-400">{t.date}</td>
              <td className="px-4 py-3">{t.description || '—'}</td>
              <td className="px-4 py-3">
                <span className="rounded-full bg-slate-800 px-2.5 py-1 text-xs text-slate-300">
                  {t.category}
                </span>
              </td>
              <td
                className={`whitespace-nowrap px-4 py-3 text-right font-medium ${
                  t.type === 'income' ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                {t.type === 'income' ? '+' : '-'}
                {formatCurrency(t.amount)}
              </td>
              <td className="px-4 py-3 text-right">
                <button
                  type="button"
                  onClick={() => onDelete(t.id)}
                  className="text-slate-500 hover:text-rose-400"
                  aria-label="Delete transaction"
                >
                  &#10005;
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
