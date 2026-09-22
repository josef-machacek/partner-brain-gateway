// ---------------------------------------------------------------------------
// Ollama — lokální LLM provider.
//
// Běží na uživatelově stroji (http://localhost:11434), nepotřebuje API klíč
// a NESPOTŘEBOVÁVÁ tokeny. Stejný kontrakt jako cloud provideři → drop-in.
//
// Instalace: `brew install ollama && ollama serve`, model: `ollama pull llama3.1`
// ---------------------------------------------------------------------------

import type { GatewayRequest, GatewayResponse } from '../types.ts'

export const DEFAULT_OLLAMA_URL   = 'http://localhost:11434'
export const DEFAULT_OLLAMA_MODEL = 'qwen2.5:7b'

/** Je lokální Ollama server dostupný? Vrací seznam stažených modelů. */
export async function ollamaStatus(baseUrl = DEFAULT_OLLAMA_URL): Promise<{ up: boolean; models: string[] }> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return { up: false, models: [] }
    const data = await res.json() as { models?: { name: string }[] }
    return { up: true, models: (data.models ?? []).map(m => m.name) }
  } catch {
    return { up: false, models: [] }
  }
}

export async function callOllama(
  req: GatewayRequest,
  baseUrl = DEFAULT_OLLAMA_URL,
  defaultModel = DEFAULT_OLLAMA_MODEL,
): Promise<GatewayResponse> {
  const start = Date.now()
  const model = req.model ?? defaultModel

  const messages = [
    ...(req.system ? [{ role: 'system' as const, content: req.system }] : []),
    ...req.messages.filter(m => m.role !== 'system' || !req.system),
  ]

  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      options: {
        temperature: req.temperature ?? 0.7,
        ...(req.maxTokens ? { num_predict: req.maxTokens } : {}),
      },
    }),
    // lokální inference může být pomalejší než cloud
    signal: AbortSignal.timeout(120_000),
  })

  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`Ollama error ${res.status}: ${txt || res.statusText}`)
  }

  const data = await res.json() as {
    message?: { content?: string }
    prompt_eval_count?: number
    eval_count?: number
    error?: string
  }
  if (data.error) throw new Error(`Ollama: ${data.error}`)

  return {
    provider:     'ollama',
    model,
    content:      data.message?.content ?? '',
    // Tokeny hlásíme kvůli statistice — cena je ale nulová (běží lokálně).
    inputTokens:  data.prompt_eval_count,
    outputTokens: data.eval_count,
    latencyMs:    Date.now() - start,
    cached:       false,
  }
}
