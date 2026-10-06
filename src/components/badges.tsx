import { cn } from '@/lib/utils'
import { REGISTRATION_LABEL, RISK_LABEL, RISK_STYLE, STATUS_LABEL, STATUS_STYLE } from '@/lib/format'
import type { AgentStatus, RegistrationStatus, RiskTier } from '@/lib/types'

const pill = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap'

export function StatusBadge({ status }: { status: AgentStatus }) {
  return <span className={cn(pill, STATUS_STYLE[status])}>{STATUS_LABEL[status]}</span>
}

export function RiskBadge({ tier }: { tier: RiskTier }) {
  return <span className={cn(pill, RISK_STYLE[tier])}>{RISK_LABEL[tier]}</span>
}

export function RegistrationBadge({ status }: { status: RegistrationStatus }) {
  const style: Record<RegistrationStatus, string> = {
    pending: 'bg-brand-yellow/30 text-brand-charcoal dark:text-brand-yellow',
    approved: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200',
    rejected: 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200',
    sent_back: 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200',
  }
  return <span className={cn(pill, style[status])}>{REGISTRATION_LABEL[status]}</span>
}

export function WarningBadge({ children }: { children: React.ReactNode }) {
  return <span className={cn(pill, 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200')}>{children}</span>
}
