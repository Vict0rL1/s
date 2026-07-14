export type TransactionType = 'income' | 'expense'

export interface Transaction {
  id: string
  type: TransactionType
  amount: number
  category: string
  description: string
  date: string // ISO yyyy-mm-dd
}

export const EXPENSE_CATEGORIES = [
  'Housing',
  'Food',
  'Transportation',
  'Utilities',
  'Entertainment',
  'Health',
  'Shopping',
  'Savings',
  'Other',
] as const

export const INCOME_CATEGORIES = [
  'Salary',
  'Freelance',
  'Investment',
  'Gift',
  'Other',
] as const

export type Budgets = Record<string, number>
