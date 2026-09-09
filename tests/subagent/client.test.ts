import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MAX_EVENT_CHARS,
  DEFAULT_MAX_OUTPUT_CHARS,
  startAdpRun,
  toAdpContents,
  type AdpRunSpec,
} from '../../src/subagent/client.ts'

const parent = {
  id: 'parent',
  session: { id: 'parent-session', header: {} },
} as unknown as Agent

function request(
  prompt: ContentBlock[] = [{ type: 'text', text: 'do the task' }],
  signal = new AbortController().signal,
) {
  return { prompt, parent, signal }
}

function spec(fetch: typeof globalThis.fetch, overrides: Partial<AdpRunSpec> = {}): AdpRunSpec {
  return {
    endpoint: 'https://adp.example.test/adp/v2/chat',
    appKey: 'secret-app-key',
    visitorId: 'visitor-1',
    requestTimeoutMs: 5_000,
    maxEventChars: DEFAULT_MAX_EVENT_CHARS,
    maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
    fetch,
    ...overrides,
  }
}

function sse(eventName: string, data: unknown): string {
  const payload = typeof data === 'string' ? data : JSON.stringify({ Type: eventName, ...data as object })
  return `event: ${eventName}\ndata: ${payload}\n\n`
}

function successfulStream(text = 'answer'): string {
  return [
    sse('request_ack', { RequestAck: { Status: 'success' } }),
    sse('message.added', { Message: { Type: 'reply', MessageId: 'reply-1' } }),
    sse('content.added', { MessageId: 'reply-1', ContentIndex: 0, Content: { Type: 'text' } }),
    sse('text.delta', { MessageId: 'reply-1', ContentIndex: 0, Text: text }),
    sse('response.completed', {
      Response: {
        Status: 'success',
        Messages: [{ Type: 'reply', MessageId: 'reply-1', Contents: [{ Type: 'text', Text: text }] }],
      },
    }),
    sse('done', '[DONE]'),
  ].join('')
}

describe('toAdpContents', () => {
  it('keeps non-empty text blocks', () => {
    expect(toAdpContents([
      { type: 'text', text: 'one' },
      { type: 'text', text: '' },
      { type: 'text', text: 'two' },
    ])).toEqual([
      { Type: 'text', Text: 'one' },
      { Type: 'text', Text: 'two' },
    ])
  })

  it('rejects empty and non-text prompts', () => {
    expect(() => toAdpContents([])).toThrow('must contain non-empty text')
    expect(() => toAdpContents([{ type: 'reasoning', text: 'hidden' }])).toThrow('support text prompts only')
  })
})

describe('startAdpRun', () => {
  it('rejects a pre-aborted request without starting HTTP', async () => {
    const abort = new AbortController()
    abort.abort()
    const fetch = vi.fn<typeof globalThis.fetch>()
    await expect(startAdpRun(request(undefined, abort.signal), spec(fetch))).rejects.toThrow(
      'aborted before the ADP request started',
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('bounds startup while waiting for response headers', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(init.signal?.reason) }, { once: true })
    }))
    await expect(startAdpRun(request(), spec(fetch, { requestTimeoutMs: 10 }))).rejects.toThrow(
      'timed out before response headers',
    )
  })

  it('posts the ADP v2 request and returns only the final reply', async () => {
    let posted: Record<string, unknown> | undefined
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      posted = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(successfulStream('final answer'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      })
    })

    const run = await startAdpRun(request(), spec(fetch, {
      streamingThrottle: 7,
      systemRole: 'be concise',
      searchNetwork: 'disable',
      modelName: 'Deepseek/deepseek-v3.2',
      workflowStatus: 'enable',
      enableMultiIntent: true,
      agentId: 'agent-1',
    }))
    const result = await run.result
    await run.dispose()

    expect(run.localAgent).toBeUndefined()
    expect(result).toEqual({
      output: [{ type: 'text', text: 'final answer' }],
      stopReason: 'completed',
    })
    expect(fetch).toHaveBeenCalledOnce()
    expect(posted).toMatchObject({
      AppKey: 'secret-app-key',
      VisitorId: 'visitor-1',
      Contents: [{ Type: 'text', Text: 'do the task' }],
      Incremental: true,
      Stream: 'enable',
      StreamingThrottle: 7,
      SystemRole: 'be concise',
      SearchNetwork: 'disable',
      ModelName: 'Deepseek/deepseek-v3.2',
      WorkflowStatus: 'enable',
      EnableMultiIntent: true,
      AgentId: 'agent-1',
    })
    expect(posted?.RequestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(posted?.ConversationId).toBe(run.id)
  })

  it('flattens an ADP error event and preserves diagnostics', async () => {
    const errors: Error[] = []
    const body = [
      sse('message.added', { Message: { Type: 'reply', MessageId: 'reply-1' } }),
      sse('text.delta', { MessageId: 'reply-1', Text: 'partial' }),
      sse('error', { Error: { Code: 460501, Message: 'invalid input', RequestId: 'r', TraceId: 't' } }),
    ].join('')
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(body, {
      headers: { 'content-type': 'text/event-stream' },
    }))

    const run = await startAdpRun(request(), spec(fetch, {
      onError: error => { errors.push(error) },
    }))
    expect(await run.result).toEqual({
      output: [{ type: 'text', text: 'partial' }],
      stopReason: 'error',
    })
    expect(errors[0]).toMatchObject({ name: 'AdpApiError', code: 460501 })
    await run.dispose()
  })

  it('rejects startup on HTTP and content-type failures without exposing the AppKey', async () => {
    const denied = vi.fn<typeof globalThis.fetch>(async () => new Response('secret-app-key echoed', {
      status: 403,
      statusText: 'Forbidden',
    }))
    await expect(startAdpRun(request(), spec(denied))).rejects.toThrow('HTTP 403 Forbidden')
    await expect(startAdpRun(request(), spec(denied))).rejects.not.toThrow('secret-app-key')

    const json = vi.fn<typeof globalThis.fetch>(async () => new Response('{}', {
      headers: { 'content-type': 'application/json' },
    }))
    await expect(startAdpRun(request(), spec(json))).rejects.toThrow('not an event stream')
  })

  it('maps caller cancellation to aborted and reaches stream quiescence on dispose', async () => {
    const abort = new AbortController()
    let streamCancelled = false
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            sse('message.added', { Message: { Type: 'reply', MessageId: 'reply-1' } })
            + sse('text.delta', { MessageId: 'reply-1', Text: 'partial' }),
          ))
          init?.signal?.addEventListener('abort', () => {
            streamCancelled = true
            controller.error(init.signal?.reason)
          }, { once: true })
        },
      })
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    })

    const run = await startAdpRun(request(undefined, abort.signal), spec(fetch))
    abort.abort()
    expect(await run.result).toEqual({
      output: [{ type: 'text', text: 'partial' }],
      stopReason: 'aborted',
    })
    await run.dispose()
    expect(streamCancelled).toBe(true)
  })

  it('treats an incomplete EOF and oversized SSE event as errors', async () => {
    for (const [body, maxEventChars] of [
      [sse('request_ack', { RequestAck: {} }), DEFAULT_MAX_EVENT_CHARS],
      [`event: text.delta\ndata: ${'x'.repeat(200)}`, 32],
    ] as const) {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(body, {
        headers: { 'content-type': 'text/event-stream' },
      }))
      const run = await startAdpRun(request(), spec(fetch, { maxEventChars }))
      expect((await run.result).stopReason).toBe('error')
      await run.dispose()
    }
  })
})
