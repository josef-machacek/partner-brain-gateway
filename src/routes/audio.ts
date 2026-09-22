import { Hono } from 'hono'
import { openAITTS, openAISTT } from '../providers/openai.ts'
import { callElevenLabs }       from '../providers/elevenlabs.ts'
import type { KeyStore, TTSRequest, STTRequest } from '../types.ts'

export function audioRoutes(keys: KeyStore) {
  const app = new Hono()

  // POST /audio/tts — text → audio (mp3)
  app.post('/tts', async (c) => {
    const body = await c.req.json<TTSRequest>().catch(() => null)
    if (!body?.text) return c.json({ error: 'text is required' }, 400)

    const provider = body.provider ?? (keys.elevenlabs ? 'elevenlabs' : 'openai')

    try {
      let audio: ArrayBuffer
      if (provider === 'elevenlabs' && keys.elevenlabs) {
        audio = await callElevenLabs(body, keys.elevenlabs)
      } else if (keys.openai) {
        audio = await openAITTS(body, keys.openai)
      } else {
        return c.json({ error: 'No TTS provider configured' }, 502)
      }
      return new Response(audio, { headers: { 'Content-Type': 'audio/mpeg' } })
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502)
    }
  })

  // GET /audio/voices — seznam dostupných ElevenLabs hlasů
  app.get('/voices', async (c) => {
    if (!keys.elevenlabs) return c.json({ error: 'ElevenLabs not configured' }, 502)
    const res = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': keys.elevenlabs },
    })
    if (!res.ok) return c.json({ error: `ElevenLabs ${res.status}` }, 502)
    const data = await res.json() as { voices: unknown[] }
    return c.json(data)
  })

  // POST /audio/stt — audio → text (Whisper via OpenAI)
  app.post('/stt', async (c) => {
    const body = await c.req.json<STTRequest>().catch(() => null)
    if (!body?.audioBase64) return c.json({ error: 'audioBase64 is required' }, 400)

    if (!keys.openai) return c.json({ error: 'OpenAI key not configured (needed for Whisper)' }, 502)

    try {
      const result = await openAISTT(body, keys.openai)
      return c.json(result)
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502)
    }
  })

  return app
}
