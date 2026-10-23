import { BellOff, BellRing, Download, Share } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { errorMessage } from '@/lib/format'
import {
  alertSupport, browserFacts, canInstall, currentSubscription, install, isIos, onInstallChange, turnOffAlerts, turnOnAlerts,
} from '@/lib/push'

type State = 'checking' | 'ios-add-to-home' | 'unsupported' | 'blocked' | 'off' | 'on'

/** Task 2.6: turn phone alerts on or off for this device, send a test, and install the app. */
export function AlertsCard() {
  const [state, setState] = useState<State>('checking')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [installable, setInstallable] = useState(canInstall())

  useEffect(() => onInstallChange(() => setInstallable(canInstall())), [])
  useEffect(() => {
    let cancelled = false
    const support = alertSupport(browserFacts())
    if (support !== 'ok') { setState(support); return }
    currentSubscription().then((s) => { if (!cancelled) setState(s ? 'on' : 'off') }, () => { if (!cancelled) setState('off') })
    return () => { cancelled = true }
  }, [])

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setMessage(null)
    try {
      await fn()
    } catch (e) {
      setMessage({ ok: false, text: errorMessage(e) })
      if (browserFacts().permission === 'denied') setState('blocked')
    } finally {
      setBusy(false)
    }
  }

  const facts = browserFacts()
  const installButton = installable && !facts.standalone && (
    <Button size="sm" variant="outline" onClick={() => run(async () => { await install() })}>
      <Download className="size-4" /> Install the app
    </Button>
  )

  if (state === 'checking') return null

  return (
    <section data-testid="alerts-card" className="bg-card flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm">
      {state === 'on' ? <BellRing className="size-5 shrink-0 text-emerald-600" aria-hidden /> : <BellOff className="text-muted-foreground size-5 shrink-0" aria-hidden />}
      <div className="min-w-0 flex-1">
        {state === 'on' && <p data-testid="alerts-state"><span className="font-medium">Alerts are on for this device.</span> You'll get one when a task waits for you, even with the app closed.</p>}
        {state === 'off' && <p data-testid="alerts-state"><span className="font-medium">Get an alert on this device</span> when an agent action waits for you.</p>}
        {state === 'blocked' && <p data-testid="alerts-state">Alerts are blocked for this site. To allow them, change the notification setting for this site in your browser or phone settings, then reload.</p>}
        {state === 'unsupported' && <p data-testid="alerts-state">This browser can't show alerts. Use Chrome, Edge, Firefox or Safari, or install the app.</p>}
        {state === 'ios-add-to-home' && (
          <p data-testid="alerts-state">
            To get alerts on {isIos(facts) && /iPad/.test(facts.userAgent) ? 'iPad' : 'iPhone'}, add this app to your Home Screen first:
            tap <Share className="inline size-4 align-text-bottom" aria-label="Share" /> Share, then <span className="font-medium">Add to Home Screen</span>,
            and open it from there (iOS 16.4 or later).
          </p>
        )}
        {message && <p role="status" className={message.ok ? 'mt-1 text-emerald-700 dark:text-emerald-400' : 'text-destructive mt-1'}>{message.text}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        {installButton}
        {state === 'off' && (
          <Button size="sm" disabled={busy} onClick={() => run(async () => {
            await turnOnAlerts()
            setState('on')
            setMessage({ ok: true, text: 'Alerts are on. Send a test to check.' })
          })}>
            <BellRing className="size-4" /> Turn on alerts
          </Button>
        )}
        {state === 'on' && (
          <>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => run(async () => {
              // Re-save this device first, in case it was removed (for example after new server keys).
              await turnOnAlerts()
              await api.pushSendTest()
              setMessage({ ok: true, text: 'Test alert sent. It should arrive in a few seconds.' })
            })}>Send a test alert</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(async () => {
              await turnOffAlerts()
              setState('off')
              setMessage({ ok: true, text: 'Alerts are off for this device.' })
            })}>Turn off</Button>
          </>
        )}
      </div>
    </section>
  )
}
