import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined

/** Null until the environment is configured, so the app still renders. */
export const supabase: SupabaseClient | null = url && key ? createClient(url, key) : null

export const supabaseEnvironment = import.meta.env.VITE_APP_ENV ?? 'local'
