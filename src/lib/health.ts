import { supabase } from '@/lib/supabase'

export type HealthStatus =
  | { state: 'not-configured' }
  | { state: 'ok'; checkedAt: string }
  | { state: 'error'; message: string }

/** Reads the heartbeat row created by the first migration. */
export async function checkDatabase(): Promise<HealthStatus> {
  if (!supabase) return { state: 'not-configured' }
  const { data, error } = await supabase.from('system_heartbeat').select('checked_at').limit(1).maybeSingle()
  if (error) return { state: 'error', message: error.message }
  return { state: 'ok', checkedAt: data?.checked_at ?? new Date().toISOString() }
}
