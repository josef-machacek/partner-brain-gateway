import type { TTSRequest } from '../types.ts'

const API_URL      = 'https://api.elevenlabs.io/v1/text-to-speech'
const DEFAULT_VOICE = 'pNInz6obpgDQGcFmaJgB'   // Adam — neutral, clear
const DEFAULT_MODEL = 'eleven_multilingual_v2'

export async function callElevenLabs(req: TTSRequest, apiKey: string): Promise<ArrayBuffer> {
  const voiceId = req.voice ?? DEFAULT_VOICE
  const url     = `${API_URL}/${voiceId}`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key':   apiKey,
      'Content-Type': 'application/json',
      'Accept':       'audio/mpeg',
    },
    body: JSON.stringify({
      text:       req.text,
      model_id:   req.model ?? DEFAULT_MODEL,
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`ElevenLabs error ${res.status}: ${err}`)
  }

  return res.arrayBuffer()
}
