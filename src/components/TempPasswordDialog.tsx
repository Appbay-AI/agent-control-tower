import { Copy } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { signInMessage, type UserState } from '@/lib/users'

const pill = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap'

export function UserStateBadge({ state }: { state: UserState }) {
  if (state === 'deactivated') return <span className={cn(pill, 'bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400')}>Deactivated</span>
  if (state === 'waiting') return <span className={cn(pill, 'bg-brand-yellow/30 text-brand-charcoal dark:text-brand-yellow')}>Yet to sign in</span>
  return <span className={cn(pill, 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200')}>Active</span>
}

/** Shows a temporary password once, with a ready-made message to send the person. */
export function TempPasswordDialog({ person, onClose }: {
  person: { name: string; email: string; password: string; isNew: boolean } | null
  onClose: () => void
}) {
  const [copied, setCopied] = useState<'password' | 'message' | null>(null)
  const appUrl = typeof window === 'undefined' ? '' : window.location.origin

  async function copy(what: 'password' | 'message') {
    if (!person) return
    const text = what === 'password' ? person.password : signInMessage(person.name, person.email, person.password, appUrl)
    await navigator.clipboard.writeText(text)
    setCopied(what)
  }

  return (
    <Dialog open={person !== null} onOpenChange={(o) => { if (!o) { setCopied(null); onClose() } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{person?.isNew ? `${person.name} has been added` : `New temporary password for ${person?.name}`}</DialogTitle>
          <DialogDescription>
            Send these sign-in details to them privately, for example by Teams chat or text message. The password is shown only
            once; they will choose their own the first time they sign in.
          </DialogDescription>
        </DialogHeader>
        <dl className="bg-muted space-y-2 rounded-md p-3 text-sm">
          <div><dt className="text-muted-foreground text-xs">Sign in at</dt><dd className="break-all">{appUrl}</dd></div>
          <div><dt className="text-muted-foreground text-xs">Email</dt><dd className="break-all">{person?.email}</dd></div>
          <div>
            <dt className="text-muted-foreground text-xs">Temporary password</dt>
            <dd className="font-mono text-base tracking-wide" data-testid="temporary-password">{person?.password}</dd>
          </div>
        </dl>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => copy('password')}><Copy /> {copied === 'password' ? 'Copied' : 'Copy password'}</Button>
          <Button variant="outline" onClick={() => copy('message')}><Copy /> {copied === 'message' ? 'Copied' : 'Copy message to send'}</Button>
          <Button onClick={() => { setCopied(null); onClose() }}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
