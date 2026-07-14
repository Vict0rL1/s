import { useState } from 'react'
import type { FormEvent } from 'react'
import {
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  type Transaction,
  type TransactionType,
} from '../types'
import { todayISO } from '../lib/format'

interface Props {
  onAdd: (transaction: Omit<Transaction, 'id'>) => void
}

export function TransactionForm({ onAdd }: Props) {
  const [type, setType] = useState<TransactionType>('expense')
  const [amount, setAmount] = useState('')
  const [category, setCategory] = useState<string>(EXPENSE_CATEGORIES[0])
  const [description, setDescription] = useState('')
  const [date, setDate] = useState(todayISO())

  const categories = type === 'expense' ? EXPENSE_CATEGORIES : INCOME_CATEGORIES

  function handleTypeChange(nextType: TransactionType) {
    setType(nextType)
    setCategory(nextType === 'expense' ? EXPENSE_CATEGORIES[0] : INCOME_CATEGORIES[0])
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    const parsedAmount = Number(amount)
    if (!parsedAmount || parsedAmount <= 0 || !date) return

    onAdd({
      type,
      amount: parsedAmount,
      category,
      description: description.trim(),
      date,
    })

    setAmount('')
    setDescription('')
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="grid grid-cols-1 gap-4 rounded-2xl border border-slate-800 bg-slate-900 p-5 sm:grid-cols-2 lg:grid-cols-6"
    >
      <div className="flex rounded-lg border border-slate-700 p-1 sm:col-span-2 lg:col-span-1">
        <button
          type="button"
          onClick={() => handleTypeChange('expense')}
          className={`flex-1 rounded-md py-1.5 text-sm font-medium transition ${
            type === 'expense'
              ? 'bg-rose-500/20 text-rose-300'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          Expense
        </button>
        <button
          type="button"
          onClick={() => handleTypeChange('income')}
          className={`flex-1 rounded-md py-1.5 text-sm font-medium transition ${
            type === 'income'
              ? 'bg-emerald-500/20 text-emerald-300'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          Income
        </button>
      </div>

      <label className="flex flex-col gap-1 text-sm text-slate-400">
        Amount
        <input
          type="number"
          min="0"
          step="0.01"
          required
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00"
          className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-slate-100 outline-none focus:border-indigo-500"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm text-slate-400">
        Category
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-slate-100 outline-none focus:border-indigo-500"
        >
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm text-slate-400 lg:col-span-2">
        Description
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optional note"
          className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-slate-100 outline-none focus:border-indigo-500"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm text-slate-400">
        Date
        <input
          type="date"
          required
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-slate-100 outline-none focus:border-indigo-500"
        />
      </label>

      <button
        type="submit"
        className="self-end rounded-lg bg-indigo-500 px-4 py-1.5 font-medium text-white transition hover:bg-indigo-400 sm:col-span-2 lg:col-span-6"
      >
        Add transaction
      </button>
    </form>
  )
}
