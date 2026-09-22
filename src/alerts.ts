// ---------------------------------------------------------------------------
// Provider alerts — in-memory queue. Frontend polls GET /alerts to drain it.
// ---------------------------------------------------------------------------

export interface ProviderAlert {
  id:       string
  provider: string
  kind:     'billing' | 'error'
  message:  string
  ts:       number
}

const alerts: ProviderAlert[] = []

export function emitProviderAlert(provider: string, message: string) {
  const kind = /401|402|billing|credit|insufficient/i.test(message) ? 'billing' : 'error'
  alerts.push({
    id:       `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    provider,
    kind,
    message,
    ts: Date.now(),
  })
  // Keep max 50 items
  if (alerts.length > 50) alerts.splice(0, alerts.length - 50)
}

// Drains (returns + clears) the queue
export function drainAlerts(): ProviderAlert[] {
  return alerts.splice(0, alerts.length)
}

// Peek without clearing
export function peekAlerts(): ProviderAlert[] {
  return [...alerts]
}
