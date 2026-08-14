import { describe, it } from 'vitest'

const required = ['ADP_API_KEY'] as const

describe('with-key smoke', () => {
  const missing = required.filter((name) => !process.env[name])
  it.skipIf(missing.length > 0)('gateway completion (skipped without env)', async () => {
    const key = process.env.ADP_API_KEY!
    const resp = await fetch('https://api.adp.cloud.tencent.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'Hunyuan/hy3',
        stream: true,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 8,
      }),
    })
    if (!resp.ok) throw new Error(`gateway HTTP ${resp.status}`)
    await resp.body?.cancel()
  })
})
