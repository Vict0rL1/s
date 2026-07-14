import { useMemo, useState } from 'react'
import { useLocalStorage } from './hooks/useLocalStorage'
import type { Budgets, Transaction } from './types'
import { currentMonthKey, formatCurrency, monthKeyOf } from './lib/format'
import { MonthSelector } from './components/MonthSelector'
import { SummaryCards } from './components/SummaryCards'
import { TransactionForm } from './components/TransactionForm'
import { TransactionList } from './components/TransactionList'
import { CategoryBudgets } from './components/CategoryBudgets'

type Tab = 'dashboard' | 'transactions' | 'budgets'

const TABS: { id: Tab; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'transactions', label: 'Transactions' },
  { id: 'budgets', label: 'Budgets' },
]

function App() {
  const [transactions, setTransactions] = useLocalStorage<Transaction[]>(
    'budget-app:transactions',
    [],
  )
  const [budgets, setBudgets] = useLocalStorage<Budgets>('budget-app:budgets', {})
  const [monthKey, setMonthKey] = useState(currentMonthKey())
  const [tab, setTab] = useState<Tab>('dashboard')

  const monthTransactions = useMemo(
    () => transactions.filter((t) => monthKeyOf(t.date) === monthKey),
    [transactions, monthKey],
  )

  const income = monthTransactions
    .filter((t) => t.type === 'income')
    .reduce((sum, t) => sum + t.amount, 0)

  const expenses = monthTransactions
    .filter((t) => t.type === 'expense')
    .reduce((sum, t) => sum + t.amount, 0)

  function handleAdd(transaction: Omit<Transaction, 'id'>) {
    const withId: Transaction = { ...transaction, id: crypto.randomUUID() }
    setTransactions((prev) => [...prev, withId])
    setMonthKey(monthKeyOf(transaction.date))
  }

  function handleDelete(id: string) {
    setTransactions((prev) => prev.filter((t) => t.id !== id))
  }

  function handleBudgetChange(category: string, amount: number) {
    setBudgets((prev) => ({ ...prev, [category]: amount }))
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-slate-50">Budget</h1>
            <p className="text-sm text-slate-500">Track income, expenses, and budgets by month.</p>
          </div>
          <MonthSelector monthKey={monthKey} onChange={setMonthKey} />
        </header>

        <nav className="mb-6 flex gap-1 rounded-xl border border-slate-800 bg-slate-900 p-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`flex-1 rounded-lg py-2 text-sm font-medium transition ${
                tab === t.id
                  ? 'bg-indigo-500 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {tab === 'dashboard' && (
          <div className="flex flex-col gap-6">
            <SummaryCards income={income} expenses={expenses} />
            <TransactionForm onAdd={handleAdd} />
            <TransactionList transactions={monthTransactions} onDelete={handleDelete} />
          </div>
        )}

        {tab === 'transactions' && (
          <div className="flex flex-col gap-6">
            <TransactionForm onAdd={handleAdd} />
            <TransactionList transactions={monthTransactions} onDelete={handleDelete} />
          </div>
        )}

        {tab === 'budgets' && (
          <div className="flex flex-col gap-6">
            <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5 text-sm text-slate-400">
              Set a monthly budget per category. Progress bars reflect spending for{' '}
              <span className="text-slate-200">{formatCurrency(expenses)}</span> total
              expenses this month.
            </div>
            <CategoryBudgets
              transactions={monthTransactions}
              budgets={budgets}
              onChange={handleBudgetChange}
            />
          </div>
        )}
      </div>
    </div>
  )
}

export default App
