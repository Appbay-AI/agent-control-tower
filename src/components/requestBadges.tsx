import { REQUEST_STATUS_LABEL, URGENCY_LABEL } from '@/lib/requests'
import type { ActionRequestStatus, ActionUrgency } from '@/lib/types'
import { cn } from '@/lib/utils'

const pill = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap'

export function RequestStatusBadge({ status }: { status: ActionRequestStatus }) {
  const style: Record<ActionRequestStatus, string> = {
    pending: 'bg-brand-yellow/30 text-brand-charcoal dark:text-brand-yellow',
    approved: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200',
    rejected: 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200',
    refused: 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200',
    expired: 'bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
    cancelled: 'bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
  }
  return <span className={cn(pill, style[status])}>{REQUEST_STATUS_LABEL[status]}</span>
}

export function UrgencyBadge({ urgency }: { urgency: ActionUrgency }) {
  const style: Record<ActionUrgency, string> = {
    low: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
    normal: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
    high: 'bg-orange-100 text-orange-800 dark:bg-orange-900/50 dark:text-orange-200',
    critical: 'bg-red-600 text-white',
  }
  return <span className={cn(pill, style[urgency])}>{URGENCY_LABEL[urgency]} urgency</span>
}
