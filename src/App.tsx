import { useEffect, useState } from 'react'
import { Activity, FileCheck2, LayoutDashboard, OctagonX, ShieldCheck, Users } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { checkDatabase, type HealthStatus } from '@/lib/health'
import { supabaseEnvironment } from '@/lib/supabase'

const modules = [
  { name: 'Agent registry', phase: 'Phase 1', icon: Users, text: 'Every agent with an owner, a purpose and a risk tier.' },
  { name: 'Approvals', phase: 'Phase 2', icon: ShieldCheck, text: 'Actions above threshold wait for a named human.' },
  { name: 'Kill switch & incidents', phase: 'Phase 3', icon: OctagonX, text: 'Suspend any agent and open an incident in one action.' },
  { name: 'Evidence pack', phase: 'Phase 4', icon: FileCheck2, text: 'One click, PDF and Excel proof of oversight.' },
  { name: 'Dashboards', phase: 'Phase 4', icon: LayoutDashboard, text: 'Executive, risk, operational and audit views.' },
]

function DatabaseBadge({ status }: { status: HealthStatus | null }) {
  if (!status) return <Badge variant="secondary">Checking database…</Badge>
  if (status.state === 'ok') return <Badge className="bg-emerald-600 text-white">Database connected</Badge>
  if (status.state === 'not-configured') return <Badge variant="secondary">Database not configured</Badge>
  return <Badge variant="destructive" title={status.message}>Database error</Badge>
}

export default function App() {
  const [status, setStatus] = useState<HealthStatus | null>(null)

  useEffect(() => {
    checkDatabase().then(setStatus)
  }, [])

  return (
    <div className="min-h-screen">
      <header className="bg-brand-charcoal text-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-4">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg bg-brand-yellow text-brand-charcoal">
              <Activity className="size-5" aria-hidden />
            </div>
            <div>
              <h1 className="text-lg leading-tight font-semibold">Agent Control Tower</h1>
              <p className="text-xs text-white/70">Governance for AI agents</p>
            </div>
          </div>
          <Badge variant="outline" className="border-white/30 text-white uppercase">
            {supabaseEnvironment}
          </Badge>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 px-4 py-8">
        <section className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-2xl font-semibold">Setup complete</h2>
            <p className="text-muted-foreground">The foundation is live. Features arrive phase by phase.</p>
          </div>
          <DatabaseBadge status={status} />
        </section>

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {modules.map(({ name, phase, icon: Icon, text }) => (
            <Card key={name}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <Icon className="size-5" aria-hidden />
                  <Badge variant="secondary">{phase}</Badge>
                </div>
                <CardTitle>{name}</CardTitle>
                <CardDescription>{text}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </section>
      </main>
    </div>
  )
}
