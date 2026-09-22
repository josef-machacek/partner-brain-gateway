// ---------------------------------------------------------------------------
// Key store — loads API keys from env or .keys.json (gitignored)
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { KeyStore } from './types.ts'

const __dir = dirname(fileURLToPath(import.meta.url))

function loadKeysFile(): Partial<KeyStore> {
  try {
    const path = resolve(__dir, '../.keys.json')
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

// Klíče zadané v integraci Partnera. Partner je píše do ~/.config/partner-voice/
// config.json (0600) — stejný zdroj, ze kterého čte Partner Voice i Knowledge
// Engine. Uživatel tak zadá klíč jednou v UI a nemusí nic exportovat v shellu.
function loadPartnerConfig(): { openai?: string; claude?: string } {
  try {
    const path = resolve(homedir(), '.config', 'partner-voice', 'config.json')
    const json = JSON.parse(readFileSync(path, 'utf8')) as {
      openaiApiKey?: string; anthropicApiKey?: string
    }
    return { openai: json.openaiApiKey, claude: json.anthropicApiKey }
  } catch {
    return {}
  }
}

export function loadKeys(): KeyStore {
  const file    = loadKeysFile()
  const partner = loadPartnerConfig()
  return {
    // pořadí: env (produkce) → .keys.json → klíč z integrace v Partnerovi
    claude:     process.env['ANTHROPIC_API_KEY']  ?? file.claude     ?? partner.claude,
    openai:     process.env['OPENAI_API_KEY']     ?? file.openai     ?? partner.openai,
    gemini:     process.env['GEMINI_API_KEY']      ?? file.gemini,
    perplexity: process.env['PERPLEXITY_API_KEY'] ?? file.perplexity,
    elevenlabs: process.env['ELEVENLABS_API_KEY'] ?? file.elevenlabs,
    // Ollama — lokální, bez klíče; jen adresa a výchozí model
    ollamaUrl:   process.env['OLLAMA_URL']   ?? file.ollamaUrl,
    ollamaModel: process.env['OLLAMA_MODEL'] ?? file.ollamaModel,
  }
}

export function updateKey(store: KeyStore, provider: keyof KeyStore, value: string): void {
  store[provider] = value
}
