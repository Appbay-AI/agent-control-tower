import { Activity, BellRing, Bot, ClipboardCheck, ClipboardList, FileCheck2, KeyRound, Lock, LogOut, Route as RouteIcon, Siren, UserCog } from 'lucide-react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/lib/auth'
import { ROLE_LABEL } from '@/lib/format'
import { LiveProvider, useLive } from '@/lib/live'
import { supabaseEnvironment } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import { NotificationBell } from '@/components/NotificationBell'
import { REPORT_PATHS } from '@/pages/ReportsPage'

export function Layout() {
  const { hasRole } = useAuth()
  const onApprovals = useLocation().pathname.startsWith('/approvals')
  return (
    <LiveProvider withApprovals={hasRole('approver', 'admin') || onApprovals}>
      <Shell />
    </LiveProvider>
  )
}

/** Number of things waiting for this person's decision, on the Approvals link (task 2.5). */
function WaitingCount({ className }: { className?: string }) {
  const { waiting } = useLive()
  if (waiting === 0) return null
  return (
    <span data-testid="waiting-count" aria-label={`${waiting} waiting for you`}
      className={cn('bg-brand-yellow text-brand-charcoal inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] leading-5 font-semibold tabular-nums', className)}>
      {waiting > 99 ? '99+' : waiting}
    </span>
  )
}

function Shell() {
  const { profile, roles, hasRole, signOut } = useAuth()
  // Reports stays highlighted on each report's own page.
  const { pathname } = useLocation()
  const active = (to: string, isActive: boolean) => isActive || (to === '/reports' && REPORT_PATHS.includes(pathname))

  const links = [
    { to: '/agents', label: 'Agents', icon: Bot, show: true },
    // Task 6.5: everyone's own work (on phones too, except for admins, whose phone menu is full)
    { to: '/my-work', label: 'My work', icon: ClipboardList, show: true, ...(hasRole('admin') ? { desktopOnly: true } : {}) },
    { to: '/approvals', label: 'Approvals', icon: ClipboardCheck, show: hasRole('approver', 'admin') },
    // Task 4.4
    { to: '/incidents', label: 'Incidents', icon: Siren, show: true },
    // Tasks 6.1-6.7: the oversight reports behind one entry (on phones for executives and auditors; admins' is full)
    { to: '/reports', label: 'Reports', icon: FileCheck2, show: hasRole('admin', 'executive', 'auditor'), ...(hasRole('admin') ? { desktopOnly: true } : {}) },
    { to: '/integrations', label: 'Integrations', icon: KeyRound, show: hasRole('admin') },
    { to: '/routing', label: 'Routing', icon: RouteIcon, show: hasRole('admin') },
    // Task 5.2
    { to: '/alert-routing', label: 'Alerts', icon: BellRing, show: hasRole('admin'), desktopOnly: true },
    { to: '/users', label: 'Users', icon: UserCog, show: hasRole('admin') },
    // Task 2.8's Agent console (the demo stand-in for an agent outside the Control Tower) opens from Integrations.
  ].filter((l) => l.show)

  return (
    <div className="min-h-screen pb-16 sm:pb-0">
      <header className="bg-brand-charcoal sticky top-0 z-20 text-white">
        <div className="flex w-full items-center gap-4 px-4 py-3 lg:px-6">
          <NavLink to="/agents" className="flex shrink-0 items-center gap-2.5">
            <span className="bg-brand-yellow text-brand-charcoal flex size-8 items-center justify-center rounded-lg">
              <Activity className="size-4" aria-hidden />
            </span>
            <span className="leading-tight font-semibold whitespace-nowrap">Agent Control Tower</span>
          </NavLink>
          {/* The menu runs across the full width, end to end, one line per label. */}
          <nav className={cn('ml-4 hidden min-w-0 flex-1 items-center gap-1 sm:flex', links.length > 5 ? 'justify-between' : 'justify-start')}>
            {links.map(({ to, label }) => (
              <NavLink key={to} to={to}
                className={({ isActive }) => cn('rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap text-white/80 hover:bg-white/10 hover:text-white',
                  active(to, isActive) && 'bg-white/15 text-white')}>
                {label}
                {to === '/approvals' && <WaitingCount className="ml-1.5" />}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-3">
            {/* Task 5.4 */}
            <NotificationBell />
            <span className="hidden rounded border border-white/30 px-1.5 py-0.5 text-[10px] tracking-wide uppercase lg:inline">
              {supabaseEnvironment}
            </span>
            {/* The name and roles only where there is room beside the menu (an admin's menu is long). */}
            <div className={cn('hidden text-right text-xs leading-tight', links.length > 7 ? '2xl:block' : 'md:block')}>
              <div className="font-medium">{profile?.full_name}</div>
              <div className="text-white/60">{roles.map((r) => ROLE_LABEL[r]).join(' · ') || 'No role yet'}</div>
            </div>
            <Button asChild size="sm" variant="ghost" className="text-white hover:bg-white/10 hover:text-white">
              <NavLink to="/account/password" title="Change password"><Lock className="size-4" /><span className="sr-only">Change password</span></NavLink>
            </Button>
            <Button size="sm" variant="ghost" className="text-white hover:bg-white/10 hover:text-white" onClick={signOut} title="Sign out">
              <LogOut className="size-4" /> <span className={cn('sr-only whitespace-nowrap', links.length > 7 ? 'xl:not-sr-only' : 'sm:not-sr-only')}>Sign out</span>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>

      {/* Phone navigation */}
      <nav className="bg-background fixed inset-x-0 bottom-0 z-20 flex border-t sm:hidden">
        {links.filter((l) => !('desktopOnly' in l)).map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to}
            className={({ isActive }) => cn('flex flex-1 flex-col items-center gap-0.5 py-2 text-xs text-muted-foreground',
              active(to, isActive) && 'text-foreground font-medium')}>
            <span className="relative">
              <Icon className="size-5" aria-hidden />
              {to === '/approvals' && <WaitingCount className="absolute -top-1.5 left-3.5" />}
            </span>
            {label}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
