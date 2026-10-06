import { Activity, ClipboardCheck, LogOut, Users } from 'lucide-react'
import { NavLink, Outlet } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/lib/auth'
import { ROLE_LABEL } from '@/lib/format'
import { supabaseEnvironment } from '@/lib/supabase'
import { cn } from '@/lib/utils'

export function Layout() {
  const { profile, roles, hasRole, signOut } = useAuth()
  const links = [
    { to: '/agents', label: 'Agents', icon: Users, show: true },
    { to: '/approvals', label: 'Approvals', icon: ClipboardCheck, show: hasRole('approver', 'admin') },
  ].filter((l) => l.show)

  return (
    <div className="min-h-screen pb-16 sm:pb-0">
      <header className="bg-brand-charcoal sticky top-0 z-20 text-white">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
          <NavLink to="/agents" className="flex items-center gap-2.5">
            <span className="bg-brand-yellow text-brand-charcoal flex size-8 items-center justify-center rounded-lg">
              <Activity className="size-4" aria-hidden />
            </span>
            <span className="leading-tight font-semibold">Agent Control Tower</span>
          </NavLink>
          <nav className="ml-4 hidden gap-1 sm:flex">
            {links.map(({ to, label }) => (
              <NavLink key={to} to={to}
                className={({ isActive }) => cn('rounded-md px-3 py-1.5 text-sm text-white/80 hover:bg-white/10 hover:text-white',
                  isActive && 'bg-white/15 text-white')}>
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden rounded border border-white/30 px-1.5 py-0.5 text-[10px] tracking-wide uppercase md:inline">
              {supabaseEnvironment}
            </span>
            <div className="hidden text-right text-xs leading-tight md:block">
              <div className="font-medium">{profile?.full_name}</div>
              <div className="text-white/60">{roles.map((r) => ROLE_LABEL[r]).join(' · ') || 'No role yet'}</div>
            </div>
            <Button size="sm" variant="ghost" className="text-white hover:bg-white/10 hover:text-white" onClick={signOut}>
              <LogOut className="size-4" /> <span className="sr-only sm:not-sr-only">Sign out</span>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>

      {/* Phone navigation */}
      <nav className="bg-background fixed inset-x-0 bottom-0 z-20 flex border-t sm:hidden">
        {links.map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to}
            className={({ isActive }) => cn('flex flex-1 flex-col items-center gap-0.5 py-2 text-xs text-muted-foreground',
              isActive && 'text-foreground font-medium')}>
            <Icon className="size-5" aria-hidden /> {label}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
