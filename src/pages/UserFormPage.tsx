import { ArrowLeft, KeyRound, UserCheck, UserX } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { TempPasswordDialog, UserStateBadge } from '@/components/TempPasswordDialog'
import { ErrorBox, LoadingRows, PageHeader, selectClass } from '@/components/ui-bits'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { errorMessage, formatDateTime, ROLE_HELP, ROLE_LABEL } from '@/lib/format'
import type { UserDraft } from '@/lib/types'
import { useAsync } from '@/lib/useAsync'
import { draftFromUser, emptyUserDraft, ROLE_ORDER, toggle, userDraftProblem, userState } from '@/lib/users'

export function UserFormPage() {
  const { id } = useParams()
  const isNew = !id
  const navigate = useNavigate()
  const { session } = useAuth()
  const isSelf = id === session?.user.id

  const lookups = useAsync(async () => {
    const [departments, users] = await Promise.all([api.departments(), isNew ? Promise.resolve([]) : api.users()])
    const user = isNew ? null : users.find((u) => u.id === id) ?? null
    if (!isNew && !user) throw new Error("This person doesn't exist.")
    return { departments, user }
  }, [id])

  const [draft, setDraft] = useState<UserDraft>(emptyUserDraft)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [tempPassword, setTempPassword] = useState<{ name: string; email: string; password: string; isNew: boolean } | null>(null)
  const [createdId, setCreatedId] = useState<string | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const [deactivating, setDeactivating] = useState(false)
  const [reason, setReason] = useState('')

  useEffect(() => {
    setDraft(lookups.data?.user ? draftFromUser(lookups.data.user) : emptyUserDraft())
    setError(null); setSaved(false)
  }, [lookups.data])

  if (lookups.error) {
    return (
      <div className="space-y-4">
        <ErrorBox message={lookups.error} />
        <Link to="/users" className="text-sm underline">Back to users</Link>
      </div>
    )
  }
  if (!lookups.data) return <LoadingRows />
  const { departments, user } = lookups.data

  const set = <K extends keyof UserDraft>(key: K, value: UserDraft[K]) => { setDraft((d) => ({ ...d, [key]: value })); setSaved(false) }

  async function save(e: FormEvent) {
    e.preventDefault()
    const problem = userDraftProblem(draft, isNew)
    if (problem) { setError(problem); return }
    setBusy(true); setError(null)
    try {
      if (isNew) {
        const r = await api.createUser(draft)
        setCreatedId(r.id)
        setTempPassword({ name: draft.full_name.trim(), email: draft.email.trim().toLowerCase(), password: r.temporary_password, isNew: true })
      } else {
        await api.updateUser(id!, draft)
        await lookups.reload()
        setSaved(true)
      }
    } catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }

  async function resetPassword() {
    setConfirmReset(false); setBusy(true); setError(null)
    try {
      const password = await api.resetPassword(id!)
      setTempPassword({ name: user!.full_name, email: user!.email ?? '', password, isNew: false })
      await lookups.reload()
    } catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }

  async function setActive(active: boolean) {
    setBusy(true); setError(null)
    try {
      await api.setUserActive(id!, active, active ? null : reason.trim())
      setDeactivating(false); setReason('')
      await lookups.reload()
    } catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }

  const isApprover = draft.roles.includes('approver')

  return (
    <div className="space-y-6">
      <Link to="/users" className="text-muted-foreground inline-flex items-center gap-1 text-sm hover:underline">
        <ArrowLeft className="size-4" /> Users
      </Link>
      <PageHeader title={isNew ? 'Add a person' : user!.full_name}
        subtitle={isNew ? 'They get a temporary password to pass on, and choose their own when they first sign in.' : user!.email} />

      <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
        <form onSubmit={save} className="space-y-6" noValidate>
          <section className="bg-card space-y-4 rounded-lg border p-4">
            <h2 className="font-semibold">Details</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="full_name">Full name</Label>
                <Input id="full_name" value={draft.full_name} onChange={(e) => set('full_name', e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="email">Work email</Label>
                <Input id="email" type="email" value={draft.email} disabled={!isNew}
                  onChange={(e) => set('email', e.target.value)} />
                {!isNew && <p className="text-muted-foreground text-xs">Email can't be changed. Add a new person instead.</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="job_title">Job title</Label>
                <Input id="job_title" value={draft.job_title} onChange={(e) => set('job_title', e.target.value)} placeholder="Optional" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="department">Department</Label>
                <select id="department" className={selectClass} value={draft.department_id ?? ''}
                  onChange={(e) => set('department_id', e.target.value || null)}>
                  <option value="">Not set</option>
                  {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
                <p className="text-muted-foreground text-xs">Where they work. It doesn't decide what they can approve.</p>
              </div>
            </div>
          </section>

          <fieldset className="bg-card space-y-3 rounded-lg border p-4">
            <legend className="sr-only">Roles</legend>
            <div>
              <h2 className="font-semibold">Roles</h2>
              <p className="text-muted-foreground text-xs">A person can have several.</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {ROLE_ORDER.map((r) => {
                const locked = isSelf && r === 'admin'
                return (
                  <label key={r} className="has-[:checked]:border-brand-charcoal has-[:checked]:bg-muted/40 flex cursor-pointer gap-3 rounded-md border p-3 dark:has-[:checked]:border-white">
                    <input type="checkbox" className="mt-1 size-4 accent-[#20242c]" checked={draft.roles.includes(r)} disabled={locked}
                      onChange={() => set('roles', toggle(draft.roles, r))} />
                    <span>
                      <span className="block text-sm font-medium">{ROLE_LABEL[r]}</span>
                      <span className="text-muted-foreground block text-xs">
                        {locked ? "You can't remove your own Admin role." : ROLE_HELP[r]}
                      </span>
                    </span>
                  </label>
                )
              })}
            </div>
          </fieldset>

          {isApprover && (
            <fieldset className="bg-card space-y-3 rounded-lg border p-4">
              <legend className="sr-only">Approves for</legend>
              <div>
                <h2 className="font-semibold">Approves for</h2>
                <p className="text-muted-foreground text-xs">
                  Agents in these departments go to this person for approval, and they can see them.
                </p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {departments.map((d) => (
                  <label key={d.id} className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm">
                    <input type="checkbox" className="size-4 accent-[#20242c]" checked={draft.scope_department_ids.includes(d.id)}
                      onChange={() => set('scope_department_ids', toggle(draft.scope_department_ids, d.id))} />
                    {d.name}
                  </label>
                ))}
              </div>
              <div className="flex gap-3 text-xs">
                <button type="button" className="underline" onClick={() => set('scope_department_ids', departments.map((d) => d.id))}>Select all</button>
                <button type="button" className="underline" onClick={() => set('scope_department_ids', [])}>Clear</button>
              </div>
            </fieldset>
          )}

          <ErrorBox message={error} />
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={busy}>{busy ? 'Saving…' : isNew ? 'Add person' : 'Save changes'}</Button>
            {saved && <span className="text-sm text-emerald-700 dark:text-emerald-400" role="status">Saved.</span>}
            {!isNew && !user!.is_active && <span className="text-muted-foreground text-xs">This person is deactivated, so these roles have no effect until they are reactivated.</span>}
          </div>
        </form>

        {!isNew && user && (
          <aside className="bg-card h-fit space-y-4 rounded-lg border p-4 text-sm">
            <h2 className="font-semibold">Account</h2>
            <dl className="space-y-2">
              <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Status</dt><dd><UserStateBadge state={userState(user)} /></dd></div>
              <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Last sign-in</dt><dd>{user.last_sign_in_at ? formatDateTime(user.last_sign_in_at) : 'Never'}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Added</dt><dd>{formatDateTime(user.created_at)}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Owns agents</dt><dd>{user.owned_agents}</dd></div>
            </dl>
            {user.is_active ? (
              <div className="space-y-2 border-t pt-4">
                <Button variant="outline" className="w-full" disabled={busy} onClick={() => setConfirmReset(true)}>
                  <KeyRound /> Reset password
                </Button>
                {!isSelf && (
                  <Button variant="outline" className="w-full text-red-700 dark:text-red-400" disabled={busy} onClick={() => setDeactivating(true)}>
                    <UserX /> Deactivate
                  </Button>
                )}
              </div>
            ) : (
              <div className="border-t pt-4">
                <Button variant="outline" className="w-full" disabled={busy} onClick={() => setActive(true)}>
                  <UserCheck /> Reactivate
                </Button>
              </div>
            )}
          </aside>
        )}
      </div>

      <Dialog open={confirmReset} onOpenChange={setConfirmReset}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset {user?.full_name}'s password?</DialogTitle>
            <DialogDescription>
              Their current password stops working straight away. You'll get a temporary one to send them, and they choose a new
              one when they sign in.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmReset(false)}>Cancel</Button>
            <Button onClick={resetPassword}>Reset password</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deactivating} onOpenChange={(o) => { setDeactivating(o); if (!o) setReason('') }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deactivate {user?.full_name}?</DialogTitle>
            <DialogDescription>
              They are signed out everywhere and can't sign in again. Their history stays in the audit trail.
              {user && user.owned_agents > 0 && ` The ${user.owned_agents} agent${user.owned_agents === 1 ? '' : 's'} they own will be flagged as having no owner until someone takes them over.`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="reason">Reason (recorded in the audit trail)</Label>
            <Textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: Left the bank on 30 Sep" />
          </div>
          <ErrorBox message={error} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeactivating(false)}>Cancel</Button>
            <Button variant="destructive" disabled={busy || !reason.trim()} onClick={() => setActive(false)}>Deactivate</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <TempPasswordDialog person={tempPassword} onClose={() => {
        setTempPassword(null)
        if (createdId) { navigate(`/users/${createdId}`, { replace: true }); setCreatedId(null) }
      }} />
    </div>
  )
}
