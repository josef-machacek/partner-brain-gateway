// ---------------------------------------------------------------------------
// Supabase client — Partner OS persistence layer
// Config: SUPABASE_URL + SUPABASE_ANON_KEY in .keys.json or env
// ---------------------------------------------------------------------------

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))

function loadSupabaseConfig(): { url: string; anonKey: string } | null {
  // Try env first
  const url     = process.env['SUPABASE_URL']
  const anonKey = process.env['SUPABASE_ANON_KEY']
  if (url && anonKey) return { url, anonKey }

  // Try .keys.json
  try {
    const path = resolve(__dir, '../.keys.json')
    const keys = JSON.parse(readFileSync(path, 'utf8')) as {
      supabaseUrl?: string
      supabaseAnonKey?: string
    }
    if (keys.supabaseUrl && keys.supabaseAnonKey) {
      return { url: keys.supabaseUrl, anonKey: keys.supabaseAnonKey }
    }
  } catch { /* no file */ }

  return null
}

let _client: SupabaseClient | null = null

export function getSupabase(): SupabaseClient | null {
  if (_client) return _client
  const cfg = loadSupabaseConfig()
  if (!cfg) return null
  _client = createClient(cfg.url, cfg.anonKey)
  return _client
}

export function isSupabaseConfigured(): boolean {
  return !!loadSupabaseConfig()
}
