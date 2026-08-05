import type {
  Fundamentals,
  History,
  HistoryRange,
  Profile,
  ProviderUsage,
  Quote,
} from './types'

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

async function fetchJson<T>(path: string): Promise<T> {
  const resp = await fetch(path)
  if (!resp.ok) {
    let detail = `Error HTTP ${resp.status}`
    try {
      const body = await resp.json()
      if (typeof body.detail === 'string') detail = body.detail
    } catch {
      // cuerpo no-JSON: nos quedamos con el mensaje genérico
    }
    throw new ApiError(resp.status, detail)
  }
  return resp.json() as Promise<T>
}

export const api = {
  quote: (symbol: string) => fetchJson<Quote>(`/api/stocks/${symbol}/quote`),
  profile: (symbol: string) => fetchJson<Profile>(`/api/stocks/${symbol}/profile`),
  fundamentals: (symbol: string) =>
    fetchJson<Fundamentals>(`/api/stocks/${symbol}/fundamentals`),
  history: (symbol: string, range: HistoryRange) =>
    fetchJson<History>(`/api/stocks/${symbol}/history?range=${range}`),
  usage: () => fetchJson<ProviderUsage[]>('/api/meta/usage'),
}
