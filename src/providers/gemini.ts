import type { GatewayRequest, GatewayResponse } from '../types.ts'

const DEFAULT_MODEL = 'gemini-2.0-flash'

export async function callGemini(req: GatewayRequest, apiKey: string): Promise<GatewayResponse> {
  const start = Date.now()
  const model = req.model ?? DEFAULT_MODEL
  const url   = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`

  // Convert to Gemini message format
  const systemInstruction = req.system ?? req.messages.find(m => m.role === 'system')?.content
  const contents = req.messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))

  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      maxOutputTokens: req.maxTokens ?? 4096,
      temperature:     req.temperature ?? 0.7,
    },
  }
  if (systemInstruction) {
    body.systemInstruction = { parts: [{ text: systemInstruction }] }
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any
    throw new Error(`Gemini error ${res.status}: ${err?.error?.message ?? res.statusText}`)
  }

  const data = await res.json() as any
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  return {
    provider:     'gemini',
    model,
    content:      text,
    inputTokens:  data.usageMetadata?.promptTokenCount,
    outputTokens: data.usageMetadata?.candidatesTokenCount,
    latencyMs:    Date.now() - start,
    cached:       false,
  }
}
