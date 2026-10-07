import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import type { AppRole, Profile } from '@/lib/types'

interface AuthState {
  session: Session | null
  profile: Profile | null
  roles: AppRole[]
  scopeDepartmentIds: string[]
  loading: boolean
  /** True after a deliberate sign-out, so the next person is not sent to the previous person's page. */
  signedOut: boolean
  hasRole: (...roles: AppRole[]) => boolean
  signIn: (email: string, password: string) => Promise<string | null>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [roles, setRoles] = useState<AppRole[]>([])
  const [scopeDepartmentIds, setScopes] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [signedOut, setSignedOut] = useState(false)

  const loadIdentity = useCallback(async (s: Session | null) => {
    if (!supabase || !s) {
      setProfile(null); setRoles([]); setScopes([]); setLoading(false)
      return
    }
    const uid = s.user.id
    const [p, r, sc] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', uid).maybeSingle(),
      supabase.from('user_roles').select('role').eq('user_id', uid),
      supabase.from('approver_scopes').select('department_id').eq('user_id', uid),
    ])
    setProfile((p.data as Profile) ?? null)
    setRoles(((r.data ?? []) as { role: AppRole }[]).map((x) => x.role))
    setScopes(((sc.data ?? []) as { department_id: string }[]).map((x) => x.department_id))
    setLoading(false)
  }, [])

  useEffect(() => {
    if (!supabase) {
      setLoading(false)
      return
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      loadIdentity(data.session)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s)
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') {
        setLoading(true)
        // Defer: supabase-js forbids awaiting other calls inside this callback.
        setTimeout(() => loadIdentity(s), 0)
      }
    })
    return () => sub.subscription.unsubscribe()
  }, [loadIdentity])

  const value = useMemo<AuthState>(() => ({
    session, profile, roles, scopeDepartmentIds, loading, signedOut,
    hasRole: (...wanted) => wanted.some((r) => roles.includes(r)),
    signIn: async (email, password) => {
      if (!supabase) return 'The app is not connected to a database yet.'
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
      if (!error) setSignedOut(false)
      return error ? (error.message === 'Invalid login credentials' ? 'Email or password is wrong.' : error.message) : null
    },
    signOut: async () => {
      setSignedOut(true)
      await supabase?.auth.signOut()
    },
  }), [session, profile, roles, scopeDepartmentIds, loading, signedOut])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
