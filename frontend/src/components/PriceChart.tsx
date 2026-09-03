import { useEffect, useRef } from 'react'
import {
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  createChart,
  type UTCTimestamp,
} from 'lightweight-charts'
import type { History } from '../api/types'

function toTime(ts: string): UTCTimestamp {
  return Math.floor(new Date(ts.replace(' ', 'T') + 'Z').getTime() / 1000) as UTCTimestamp
}

function overlay(
  bars: History['bars'],
  values: (number | null)[],
): { time: UTCTimestamp; value: number }[] {
  const out: { time: UTCTimestamp; value: number }[] = []
  values.forEach((v, i) => {
    if (v !== null && bars[i]) out.push({ time: toTime(bars[i].ts), value: v })
  })
  return out
}

const SMA_STYLES = [
  { key: 'sma20', color: '#0ea5e9', label: 'SMA 20' },
  { key: 'sma50', color: '#f59e0b', label: 'SMA 50' },
  { key: 'sma200', color: '#8b5cf6', label: 'SMA 200' },
] as const

export function PriceChart({ history }: { history: History }) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: '#64748b' },
      grid: {
        vertLines: { color: '#f1f5f9' },
        horzLines: { color: '#f1f5f9' },
      },
      rightPriceScale: { borderColor: '#e2e8f0' },
      timeScale: { borderColor: '#e2e8f0' },
    })

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: '#059669',
      downColor: '#dc2626',
      wickUpColor: '#059669',
      wickDownColor: '#dc2626',
      borderVisible: false,
    })
    candles.setData(
      history.bars.map((b) => ({
        time: toTime(b.ts),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      })),
    )

    const volume = chart.addSeries(HistogramSeries, {
      priceScaleId: 'volume',
      priceFormat: { type: 'volume' },
      color: '#cbd5e1',
    })
    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    })
    volume.setData(
      history.bars
        .filter((b) => b.volume !== null)
        .map((b) => ({
          time: toTime(b.ts),
          value: b.volume as number,
          color: b.close >= b.open ? '#a7f3d0' : '#fecaca',
        })),
    )

    for (const { key, color } of SMA_STYLES) {
      const data = overlay(history.bars, history.indicators[key])
      if (data.length === 0) continue
      const line = chart.addSeries(LineSeries, {
        color,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      })
      line.setData(data)
    }

    chart.timeScale().fitContent()
    return () => chart.remove()
  }, [history])

  return (
    <div>
      <div ref={containerRef} className="h-[380px] w-full" />
      <div className="mt-2 flex gap-4 text-xs text-slate-500">
        {SMA_STYLES.map(({ key, color, label }) =>
          history.indicators[key].some((v) => v !== null) ? (
            <span key={key} className="flex items-center gap-1">
              <span className="h-0.5 w-4" style={{ backgroundColor: color }} />
              {label}
            </span>
          ) : null,
        )}
      </div>
    </div>
  )
}
