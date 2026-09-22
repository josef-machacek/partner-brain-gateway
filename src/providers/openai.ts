import type { GatewayRequest, GatewayResponse, TTSRequest, STTRequest, STTResponse } from '../types.ts'

const CHAT_URL  = 'https://api.openai.com/v1/chat/completions'
const TTS_URL   = 'https://api.openai.com/v1/audio/speech'
const STT_URL   = 'https://api.openai.com/v1/audio/transcriptions'

const DEFAULT_MODEL = 'gpt-4o'

function authHeaders(apiKey: string) {
  return { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
}

export async function callOpenAI(req: GatewayRequest, apiKey: string): Promise<GatewayResponse> {
  const start = Date.now()
  const model = req.model ?? DEFAULT_MODEL

  // Merge system prompt as first message if provided
  const messages = [
    ...(req.system ? [{ role: 'system' as const, content: req.system }] : []),
    ...req.messages.filter(m => m.role !== 'system' || !req.system),
  ]

  const res = await fetch(CHAT_URL, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify({
      model,
      messages,
      max_tokens:  req.maxTokens ?? 4096,
      temperature: req.temperature ?? 0.7,
    }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any
    throw new Error(`OpenAI error ${res.status}: ${err?.error?.message ?? res.statusText}`)
  }

  const data = await res.json() as any
  return {
    provider:     'openai',
    model,
    content:      data.choices?.[0]?.message?.content ?? '',
    inputTokens:  data.usage?.prompt_tokens,
    outputTokens: data.usage?.completion_tokens,
    latencyMs:    Date.now() - start,
    cached:       false,
  }
}

export async function openAITTS(req: TTSRequest, apiKey: string): Promise<ArrayBuffer> {
  const res = await fetch(TTS_URL, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify({
      model: req.model ?? 'tts-1',
      input: req.text,
      voice: req.voice ?? 'alloy',
    }),
  })
  if (!res.ok) throw new Error(`OpenAI TTS error ${res.status}`)
  return res.arrayBuffer()
}

export async function openAISTT(req: STTRequest, apiKey: string): Promise<STTResponse> {
  const start = Date.now()

  // Convert base64 to blob
  const binary = Buffer.from(req.audioBase64, 'base64')
  const blob   = new Blob([binary], { type: req.mimeType ?? 'audio/webm' })

  const form = new FormData()
  form.append('file', blob, 'audio.webm')
  form.append('model', 'whisper-1')
  if (req.language) form.append('language', req.language)

  const res = await fetch(STT_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: form,
  })
  if (!res.ok) throw new Error(`OpenAI Whisper error ${res.status}`)

  const data = await res.json() as any
  return { provider: 'whisper', text: data.text ?? '', latencyMs: Date.now() - start }
}
