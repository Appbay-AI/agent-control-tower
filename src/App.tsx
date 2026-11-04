import type { ReactNode } from 'react'
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Layout } from '@/components/Layout'
import { LoadingRows } from '@/components/ui-bits'
import { AuthProvider, useAuth } from '@/lib/auth'
import { supabase } from '@/lib/supabase'
import { AgentDetailPage } from '@/pages/AgentDetailPage'
import { AgentFormPage } from '@/pages/AgentFormPage'
import { AgentConsolePage } from '@/pages/AgentConsolePage'
import { AgentsPage } from '@/pages/AgentsPage'
import { ApprovalsPage } from '@/pages/ApprovalsPage'
import { IntegrationsPage } from '@/pages/IntegrationsPage'
import { IncidentsPage } from '@/pages/IncidentsPage'
import { ChangePasswordPage } from '@/pages/ChangePasswordPage'
import { LoginPage } from '@/pages/LoginPage'
import { RequestPage } from '@/pages/RequestPage'
import { RoutingPage } from '@/pages/RoutingPage'
import { UserFormPage } from '@/pages/UserFormPage'
import { UsersPage } from '@/pages/UsersPage'

function RequireAuth({ children }: { children: ReactNode }) {
  const { session, profile, loading, signedOut } = useAuth()
  const location = useLocation()
  if (loading) return <div className="mx-auto max-w-6xl p-6"><LoadingRows /></div>
  // Remember the page only for deep links (e.g. a link in an email), never after someone signs out.
  if (!session) return <Navigate to="/login" replace state={signedOut ? null : { from: location.pathname }} />
  // Signed in with a temporary password: choose a real one before anything else.
  if (profile?.must_change_password) return <ChangePasswordPage forced />
  return <>{children}</>
}

function RequireAdmin({ children }: { children: ReactNode }) {
  const { hasRole } = useAuth()
  if (!hasRole('admin')) return <div className="py-10 text-center text-sm">Only admins can open this page. <Link className="underline" to="/agents">Go to agents</Link></div>
  return <>{children}</>
}

function NotConfigured() {
  return (
    <div className="mx-auto max-w-lg p-8 text-center">
      <h1 className="text-xl font-semibold">Agent Control Tower</h1>
      <p className="text-muted-foreground mt-2 text-sm">Database not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.</p>
    </div>
  )
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth><Layout /></RequireAuth>}>
        <Route index element={<Navigate to="/agents" replace />} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/agents/new" element={<AgentFormPage />} />
        <Route path="/agents/:id" element={<AgentDetailPage />} />
        <Route path="/agents/:id/edit" element={<AgentFormPage />} />
        <Route path="/approvals" element={<ApprovalsPage />} />
        <Route path="/approvals/requests/:id" element={<RequestPage />} />
        <Route path="/incidents" element={<IncidentsPage />} />
        <Route path="/integrations" element={<IntegrationsPage />} />
        <Route path="/routing" element={<RequireAdmin><RoutingPage /></RequireAdmin>} />
        <Route path="/demo/agent" element={<RequireAdmin><AgentConsolePage /></RequireAdmin>} />
        <Route path="/users" element={<RequireAdmin><UsersPage /></RequireAdmin>} />
        <Route path="/users/new" element={<RequireAdmin><UserFormPage /></RequireAdmin>} />
        <Route path="/users/:id" element={<RequireAdmin><UserFormPage /></RequireAdmin>} />
        <Route path="/account/password" element={<ChangePasswordPage />} />
        <Route path="*" element={<div className="py-10 text-center">Page not found. <Link className="underline" to="/agents">Go to agents</Link></div>} />
      </Route>
    </Routes>
  )
}

export default function App() {
  if (!supabase) return <NotConfigured />
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  )
}
