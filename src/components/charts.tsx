// Shared pieces of the dashboards' charts (tasks 6.3, 6.4): axis styling, a titled panel with its figures as a table
// (so no chart relies on colour alone), and the hover tooltip.
import type { ReactNode } from 'react'

export const AXIS = { stroke: 'var(--viz-axis)', tick: { fill: 'var(--viz-muted)', fontSize: 12 }, tickLine: false } as const

export function Panel({ title, sub, table, children }: { title: string; sub: string; table: (string | number)[][]; children: ReactNode }) {
  const [head, ...rows] = table
  return (
    <section className="bg-card rounded-lg border p-4" aria-label={title}>
      <h2 className="font-semibold">{title}</h2>
      <p className="text-muted-foreground mb-3 text-xs">{sub}</p>
      {children}
      <details className="mt-2 text-xs">
        <summary className="text-muted-foreground cursor-pointer">Figures as a table</summary>
        <table className="mt-2 w-full tabular-nums">
          <thead><tr>{head.map((h) => <th key={h} className="py-1 text-left font-medium">{h}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i} className="border-t">{r.map((c, j) => <td key={j} className="py-1">{c}</td>)}</tr>)}</tbody>
        </table>
      </details>
    </section>
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function Tip({ active, payload, render }: { active?: boolean; payload?: { payload: any }[]; render: (p: any) => string }) {
  if (!active || !payload?.length) return null
  const p = payload[0].payload
  return (
    <div className="bg-popover text-popover-foreground rounded-md border px-2.5 py-1.5 text-xs shadow-sm">
      <div className="font-medium">{p.label ?? p.k}</div>
      <div>{render(p)}</div>
    </div>
  )
}
