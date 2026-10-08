import { Activity } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { ErrorBox, PageHeader } from '@/components/ui-bits'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { errorMessage } from '@/lib/format'
import { supabase } from '@/lib/supabase'

export const MIN_PASSWORD_LENGTH = 12

/** Returns a plain-English problem with the new password, or null when it is fine. */
export function passwordProblem(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`
  if (/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/.test(password)) return 'Choose your own password, not the temporary one.'
  if (password !== confirm) return 'The two passwords do not match.'
  return null
}

function friendly(message: string): string {
  if (/different from the old/i.test(message)) return 'Choose a password different from your current one.'
  if (/weak|pwned|known/i.test(message)) return 'That password is too easy to guess. Try a longer phrase.'
  return message
}

/**
 * forced: shown instead of the app right after signing in with a temporary password.
 * Otherwise: the "Change password" page in the menu.
 */
export function ChangePasswordPage({ forced = false }: { forced?: boolean }) {
  const { profile, refresh, signOut } = useAuth()
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const problem = passwordProblem(password, confirm)
    if (problem) { setError(problem); return }
    setBusy(true); setError(null)
    try {
      const { error: authError } = await supabase!.auth.updateUser({ password })
      if (authError) throw new Error(friendly(authError.message))
      await api.passwordChanged()
      setPassword(''); setConfirm('')
      if (forced) {
        await refresh()
        navigate('/agents', { replace: true })
      } else {
        setDone(true)
      }
    } catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }

  const form = (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="new-password">New password</Label>
        <Input id="new-password" type="password" autoComplete="new-password" required value={password}
          onChange={(e) => { setPassword(e.target.value); setDone(false) }} />
        <p className="text-muted-foreground text-xs">At least {MIN_PASSWORD_LENGTH} characters. A short phrase is easiest to remember.</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="confirm-password">Type it again</Label>
        <Input id="confirm-password" type="password" autoComplete="new-password" required value={confirm}
          onChange={(e) => setConfirm(e.target.value)} />
      </div>
      <ErrorBox message={error} />
      {done && <p className="text-sm text-emerald-700 dark:text-emerald-400" role="status">Password changed.</p>}
      <Button type="submit" className="w-full sm:w-auto" disabled={busy}>{busy ? 'Saving…' : 'Save new password'}</Button>
    </form>
  )

  if (!forced) {
    return (
      <div className="max-w-md space-y-6">
        <PageHeader title="Change password" subtitle="You will stay signed in on this device." />
        {form}
      </div>
    )
  }

  return (
    <div className="bg-brand-charcoal flex min-h-screen items-center justify-center px-4">
      <div className="bg-card w-full max-w-sm rounded-xl p-6 shadow-xl">
        <div className="mb-5 flex items-center gap-3">
          <span className="bg-brand-yellow text-brand-charcoal flex size-10 items-center justify-center rounded-lg">
            <Activity className="size-5" aria-hidden />
          </span>
          <div>
            <h1 className="text-lg leading-tight font-semibold">Choose your password</h1>
            <p className="text-muted-foreground text-xs">Welcome{profile?.full_name ? `, ${profile.full_name}` : ''}. Replace the temporary password before you continue.</p>
          </div>
        </div>
        {form}
        <button type="button" className="text-muted-foreground mt-4 w-full text-center text-xs underline" onClick={signOut}>
          Sign out
        </button>
      </div>
    </div>
  )
}
