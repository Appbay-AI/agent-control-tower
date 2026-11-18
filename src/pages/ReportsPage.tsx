// Reports (tasks 6.1, 6.3, 6.4, 6.6, 6.7, 6.8): one menu entry for the oversight reports, so the menu stays on one line.
// Each report keeps its own address.
import { FileCheck2, Flame, GitCompareArrows, History, LayoutDashboard, UserX, type LucideIcon } from 'lucide-react'
import { Link } from 'react-router-dom'
import { PageHeader } from '@/components/ui-bits'

export const REPORTS: { to: string; title: string; about: string; icon: LucideIcon }[] = [
  { to: '/dashboard', title: 'Executive dashboard', icon: LayoutDashboard,
    about: 'Agents by risk and source, no owner, overdue reviews, open incidents, what is waiting and how long approvals take.' },
  { to: '/risk', title: 'Risk dashboard', icon: Flame,
    about: 'Agents by department and risk tier, breaches week by week, and the agents with the most incidents.' },
  { to: '/drift-sync', title: 'Drift and sync', icon: GitCompareArrows,
    about: 'Every change made to an agent outside the Control Tower, and how well each platform is being fetched.' },
  { to: '/data-access', title: 'Data access mismatches', icon: UserX,
    about: 'People who can use an agent that handles data their role is not authorised for.' },
  { to: '/audit', title: 'Audit trail', icon: History,
    about: 'Search every recorded change by words, date, person, agent or record, open any entry, and export what you find.' },
  { to: '/evidence', title: 'Evidence pack', icon: FileCheck2,
    about: 'Everything an auditor needs for a period, as a PDF or an Excel file.' },
]
export const REPORT_PATHS = ['/reports', ...REPORTS.map((r) => r.to)]

export function ReportsPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Reports" subtitle="For admins, executives and auditors: every agent, across all departments." />
      <ul className="grid gap-3 sm:grid-cols-2">
        {REPORTS.map(({ to, title, about, icon: Icon }) => (
          <li key={to}>
            <Link to={to} className="bg-card hover:border-foreground/30 flex h-full gap-3 rounded-lg border p-4 transition-colors">
              <Icon className="text-muted-foreground mt-0.5 size-5 shrink-0" aria-hidden />
              <span><span className="block font-semibold">{title}</span><span className="text-muted-foreground text-sm">{about}</span></span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
