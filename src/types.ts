// ---------------------------------------------------------------------------
// AI Gateway — shared types
// ---------------------------------------------------------------------------

export type ProviderId =
  | 'claude'
  | 'openai'
  | 'gemini'
  | 'perplexity'
  | 'elevenlabs'
  | 'whisper'
  | 'ollama'      // lokální LLM — bez klíče, bez tokenů

export type CapabilityId =
  | 'chat'           // text in → text out
  | 'vision'         // image + text → text
  | 'tts'            // text → audio
  | 'stt'            // audio → text
  | 'search'         // web-grounded answers
  | 'embedding'      // text → vector

// Which providers support which capabilities
export const PROVIDER_CAPABILITIES: Record<ProviderId, CapabilityId[]> = {
  claude:      ['chat', 'vision'],
  openai:      ['chat', 'vision', 'tts', 'stt', 'embedding'],
  gemini:      ['chat', 'vision', 'embedding'],
  perplexity:  ['chat', 'search'],
  elevenlabs:  ['tts'],
  whisper:     ['stt'],
  ollama:      ['chat', 'embedding'],
}

// ---------------------------------------------------------------------------
// Chat (text generation) — used by 90 % of requests
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role:    'system' | 'user' | 'assistant'
  content: string
}

export interface GatewayRequest {
  // Routing
  provider?:   ProviderId    // explicit override; omit = auto-route
  capability?: CapabilityId  // used for auto-routing
  model?:      string        // model override within provider

  // Content
  messages:    ChatMessage[]
  system?:     string        // system prompt (merged into messages if needed)
  maxTokens?:  number
  temperature?: number

  // Context (passed through, used for logging / decision memory)
  intent?:     string
  companyId?:  string
  module?:     string
}

export interface GatewayResponse {
  provider:   ProviderId
  model:      string
  content:    string
  inputTokens?:  number
  outputTokens?: number
  latencyMs:  number
  cached:     boolean
}

// ---------------------------------------------------------------------------
// TTS
// ---------------------------------------------------------------------------

export interface TTSRequest {
  provider?: 'openai' | 'elevenlabs'
  text:      string
  voice?:    string
  model?:    string
}

// ---------------------------------------------------------------------------
// STT
// ---------------------------------------------------------------------------

export interface STTRequest {
  provider?: 'openai' | 'whisper'
  audioBase64: string   // base64-encoded audio
  mimeType?:   string
  language?:   string
}

export interface STTResponse {
  provider:  ProviderId
  text:      string
  language?: string
  latencyMs: number
}

// ---------------------------------------------------------------------------
// Provider key registry (stored in env / config)
// ---------------------------------------------------------------------------

export interface KeyStore {
  claude?:      string   // sk-ant-...
  openai?:      string   // sk-proj-...
  gemini?:      string   // AIza...
  perplexity?:  string   // pplx-...
  elevenlabs?:  string   // el_...
  /** Ollama nepotřebuje klíč — jen adresu lokálního serveru. */
  ollamaUrl?:   string   // http://localhost:11434
  /** Výchozí lokální model (např. "llama3.1", "qwen2.5"). */
  ollamaModel?: string
}
