/**
 * Plugin / search HTTP bodies may be JSON *or* cumulative SSE.
 * Last frame wins — concatenating would repeat the answer N times.
 * Fixture: tests/fixtures/plugin/cumulative-sse.jsonl
 */
export function readBody(text: string): unknown {
  const stripped = text.trim()
  if (!stripped.startsWith('data:')) {
    try {
      return JSON.parse(stripped) as unknown
    } catch {
      return { raw: stripped.slice(0, 2000) }
    }
  }
  let last: unknown
  for (const line of stripped.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    try {
      last = JSON.parse(trimmed.slice(5).trim()) as unknown
    } catch {
      continue
    }
  }
  return last !== undefined ? last : { raw: stripped.slice(0, 2000) }
}

export function lastSseAnswer(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined
  const rec = body as Record<string, unknown>
  const data = rec.Data
  if (data && typeof data === 'object') {
    const answer = (data as Record<string, unknown>).Answer
    if (typeof answer === 'string') return answer
  }
  if (typeof rec.Answer === 'string') return rec.Answer
  return undefined
}

/** Account-plane envelope: live API uses reqId/code/data, docs say PascalCase. */
export function unwrapAccountPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') {
    throw new Error('account payload is not an object')
  }
  const rec = payload as Record<string, unknown>
  const code = rec.code ?? rec.Code
  const message = String(rec.message ?? rec.Message ?? '')
  if (code !== 0 && code !== undefined && code !== null) {
    throw new Error(`${message || 'request refused'} (code ${code})`)
  }
  const data = rec.data ?? rec.Data
  if (data && typeof data === 'object') {
    const inner = (data as Record<string, unknown>).Response ?? (data as Record<string, unknown>).response
    if (inner && typeof inner === 'object') return inner as Record<string, unknown>
    return data as Record<string, unknown>
  }
  return rec
}
