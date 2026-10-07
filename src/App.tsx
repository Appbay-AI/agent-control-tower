import type { ReactNode } from 'react'
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Layout } from '@/components/Layout'
import { LoadingRows } from '@/components/ui-bits'
import { AuthProvider, useAuth } from '@/lib/auth'
import { supabase } from '@/lib/supabase'
import { AgentDetailPage } from '@/pages/AgentDetailPage'
import { AgentFormPage } from '@/pages/AgentFormPage'
import { AgentsPage } from '@/pages/AgentsPage'
import { ApprovalsPage } from '@/pages/ApprovalsPage'
import { IntegrationsPage } from '@/pages/IntegrationsPage'
import { LoginPage } from '@/pages/LoginPage'

function RequireAuth({ children }: { children: ReactNode }) {
  const { session, loading, signedOut } = useAuth()
  const location = useLocation()
  if (loading) return <div className="mx-auto max-w-6xl p-6"><LoadingRows /></div>
  // Remember the page only for deep links (e.g. a link in an email), never after someone signs out.
  if (!session) return <Navigate to="/login" replace state={signedOut ? null : { from: location.pathname }} />
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
        <Route path="/integrations" element={<IntegrationsPage />} />
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
