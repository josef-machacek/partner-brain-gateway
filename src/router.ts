// ---------------------------------------------------------------------------
// AI Gateway Router — selects provider per request, handles fallbacks
// ---------------------------------------------------------------------------

import type { GatewayRequest, GatewayResponse, ProviderId, KeyStore } from './types.ts'
import { callClaude }      from './providers/claude.ts'
import { callOpenAI }      from './providers/openai.ts'
import { callGemini }      from './providers/gemini.ts'
import { callPerplexity }  from './providers/perplexity.ts'
import { callOllama, DEFAULT_OLLAMA_URL, DEFAULT_OLLAMA_MODEL } from './providers/ollama.ts'
import { emitProviderAlert } from './alerts.ts'

// ---------------------------------------------------------------------------
// Intent → preferred provider routing table
// ---------------------------------------------------------------------------

// Ollama is always appended as the final fallback — it needs no API key and
// runs locally. This makes every intent work even without any cloud key.
const INTENT_ROUTING: Record<string, ProviderId[]> = {
  // Deep reasoning, long context, nuanced analysis
  company_analysis:  ['claude', 'openai', 'gemini', 'ollama'],
  daily_briefing:    ['claude', 'openai', 'ollama'],
  task_planning:     ['claude', 'openai', 'ollama'],
  fast_summary:      ['openai', 'claude', 'gemini', 'ollama'],
  financial_analysis:['claude', 'openai', 'ollama'],
  owner_report:      ['claude', 'openai', 'ollama'],
  email_summary:     ['claude', 'openai', 'ollama'],
  general_chat:      ['claude', 'openai', 'ollama'],
  long_document_analysis: ['claude', 'openai', 'ollama'],

  // Web-grounded answers — Perplexity first, Ollama has no web access so skip
  web_search:        ['perplexity', 'gemini'],
  market_research:   ['perplexity', 'claude'],
  news_digest:       ['perplexity', 'openai'],

  // General fallback
  default:           ['claude', 'openai', 'gemini', 'ollama'],
}

// ---------------------------------------------------------------------------
// Capability → provider fallback chains
// ---------------------------------------------------------------------------

const CAPABILITY_ROUTING: Record<string, ProviderId[]> = {
  chat:    ['claude', 'openai', 'gemini'],
  vision:  ['claude', 'openai', 'gemini'],
  search:  ['perplexity', 'gemini'],
}

// ---------------------------------------------------------------------------
// Route & execute with fallback
// ---------------------------------------------------------------------------

export async function route(req: GatewayRequest, keys: KeyStore): Promise<GatewayResponse> {
  // 1. Explicit provider requested
  if (req.provider) {
    return callProvider(req.provider, req, keys)
  }

  // 2. Intent-based routing (prázdný intent/capability = spadni na default)
  const chain: ProviderId[] =
    (req.intent ? INTENT_ROUTING[req.intent] : undefined)
    ?? (req.capability ? CAPABILITY_ROUTING[req.capability] : undefined)
    ?? INTENT_ROUTING['default']!

  // Filter to providers that have a key configured
  const available = chain.filter((p: ProviderId) => hasKey(p, keys))

  if (available.length === 0) {
    throw new Error('No AI provider configured. Add at least one API key.')
  }

  // 3. Try in order — first success wins
  const errors: string[] = []
  for (const provider of available) {
    try {
      return await callProvider(provider, req, keys)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      errors.push(`${provider}: ${msg}`)
      // Detect billing/auth errors — 401 or 402 means no credit/invalid key
      if (/401|402|insufficient|credit|billing|quota|limit|overloaded/i.test(msg)) {
        console.error(`[gateway] ${provider} BILLING ERROR — no credit or invalid key:`, msg)
        // Emit server-sent event so the frontend can show a notification
        emitProviderAlert(provider, msg)
      } else {
        console.warn(`[gateway] ${provider} failed, trying next…`, msg)
      }
    }
  }

  throw new Error(`All providers failed:\n${errors.join('\n')}`)
}

// ---------------------------------------------------------------------------
// Dispatch to provider implementation
// ---------------------------------------------------------------------------

function callProvider(provider: ProviderId, req: GatewayRequest, keys: KeyStore): Promise<GatewayResponse> {
  switch (provider) {
    case 'claude':     return callClaude(req, keys.claude!)
    case 'openai':     return callOpenAI(req, keys.openai!)
    case 'gemini':     return callGemini(req, keys.gemini!)
    case 'perplexity': return callPerplexity(req, keys.perplexity!)
    case 'ollama':     return callOllama(req, keys.ollamaUrl ?? DEFAULT_OLLAMA_URL, keys.ollamaModel ?? DEFAULT_OLLAMA_MODEL)
    default:           throw new Error(`Unknown provider: ${provider}`)
  }
}

function hasKey(provider: ProviderId, keys: KeyStore): boolean {
  switch (provider) {
    case 'claude':     return !!keys.claude
    case 'openai':     return !!keys.openai
    case 'gemini':     return !!keys.gemini
    case 'perplexity': return !!keys.perplexity
    case 'elevenlabs': return !!keys.elevenlabs
    case 'whisper':    return !!keys.openai  // Whisper uses OpenAI key
    case 'ollama':     return true           // lokální — žádný klíč není potřeba
    default:           return false
  }
}
