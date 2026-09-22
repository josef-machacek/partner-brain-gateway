import type { GatewayRequest, GatewayResponse } from '../types.ts'

const API_URL       = 'https://api.perplexity.ai/chat/completions'
const DEFAULT_MODEL = 'llama-3.1-sonar-large-128k-online'   // web-grounded

export async function callPerplexity(req: GatewayRequest, apiKey: string): Promise<GatewayResponse> {
  const start = Date.now()
  const model = req.model ?? DEFAULT_MODEL

  const messages = [
    ...(req.system ? [{ role: 'system' as const, content: req.system }] : []),
    ...req.messages.filter(m => m.role !== 'system' || !req.system),
  ]

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens:  req.maxTokens ?? 2048,
      temperature: req.temperature ?? 0.2,  // lower = more factual for search
    }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any
    throw new Error(`Perplexity error ${res.status}: ${err?.error?.message ?? res.statusText}`)
  }

  const data = await res.json() as any
  return {
    provider:     'perplexity',
    model,
    content:      data.choices?.[0]?.message?.content ?? '',
    inputTokens:  data.usage?.prompt_tokens,
    outputTokens: data.usage?.completion_tokens,
    latencyMs:    Date.now() - start,
    cached:       false,
  }
}
