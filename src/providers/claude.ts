import type { GatewayRequest, GatewayResponse } from '../types.ts'

const API_URL = 'https://api.anthropic.com/v1/messages'
const DEFAULT_MODEL = 'claude-sonnet-4-6'

export async function callClaude(req: GatewayRequest, apiKey: string): Promise<GatewayResponse> {
  const start = Date.now()
  const model = req.model ?? DEFAULT_MODEL

  const messages = req.messages.filter(m => m.role !== 'system')
  const system   = req.system ?? req.messages.find(m => m.role === 'system')?.content

  const body: Record<string, unknown> = {
    model,
    max_tokens: req.maxTokens ?? 4096,
    messages,
  }
  if (system)           body.system      = system
  if (req.temperature)  body.temperature = req.temperature

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key':           apiKey,
      'anthropic-version':   '2023-06-01',
      'content-type':        'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any
    throw new Error(`Claude error ${res.status}: ${err?.error?.message ?? res.statusText}`)
  }

  const data = await res.json() as any
  return {
    provider:     'claude',
    model,
    content:      data.content?.[0]?.text ?? '',
    inputTokens:  data.usage?.input_tokens,
    outputTokens: data.usage?.output_tokens,
    latencyMs:    Date.now() - start,
    cached:       false,
  }
}
