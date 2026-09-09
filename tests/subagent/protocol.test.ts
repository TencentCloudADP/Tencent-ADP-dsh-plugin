import { describe, expect, it } from 'vitest'
import {
  AdpApiError,
  AdpProtocolError,
  AdpResponseFold,
} from '../../src/subagent/protocol.ts'

function event(type: string, fields: Record<string, unknown>): string {
  return JSON.stringify({ Type: type, ...fields })
}

describe('AdpResponseFold', () => {
  it('applies indexed deltas and replacements, then trusts the completed reply', () => {
    const fold = new AdpResponseFold(1_000)
    fold.accept('message.added', event('message.added', {
      Message: { Type: 'reply', MessageId: 'reply-1' },
    }))
    fold.accept('content.added', event('content.added', {
      MessageId: 'reply-1',
      Content: { Type: 'text', Text: 'Hel' },
    }))
    fold.accept('text.delta', event('text.delta', {
      MessageId: 'reply-1',
      Text: 'lo',
    }))
    expect(fold.collect()).toEqual([{ type: 'text', text: 'Hello' }])

    fold.accept('text.replace', event('text.replace', {
      MessageId: 'reply-1',
      ContentIndex: 0,
      Text: 'Corrected',
    }))
    fold.accept('text.delta', event('text.delta', {
      MessageId: 'reply-1',
      ContentIndex: 1,
      Text: ' answer',
    }))
    expect(fold.collect()).toEqual([{ type: 'text', text: 'Corrected answer' }])

    fold.accept('response.completed', event('response.completed', {
      Response: {
        Status: 'success',
        Messages: [
          { Type: 'thought', MessageId: 'thought-1', Contents: [{ Type: 'text', Text: 'private trace' }] },
          { Type: 'reply', MessageId: 'reply-1', Contents: [{ Type: 'text', Text: 'Final answer' }] },
        ],
      },
    }))
    fold.accept('done', '[DONE]')

    expect(fold.done).toBe(true)
    expect(fold.finish()).toBe('completed')
    expect(fold.collect()).toEqual([{ type: 'text', text: 'Final answer' }])
    expect(() => fold.accept('request_ack', event('request_ack', {}))).toThrow('after [DONE]')
  })

  it('uses message.done as the authoritative streamed candidate', () => {
    const fold = new AdpResponseFold(100)
    fold.accept('text.delta', event('text.delta', { MessageId: 'm', Text: 'draft' }))
    expect(fold.collect()).toEqual([])

    fold.accept('message.done', event('message.done', {
      Message: {
        Type: 'reply',
        MessageId: 'm',
        Contents: [{ Type: 'text', Text: 'committed' }],
      },
    }))
    expect(fold.collect()).toEqual([{ type: 'text', text: 'committed' }])
  })

  it('tolerates null and wrapped text emitted by deployed ADP gateways', () => {
    const fold = new AdpResponseFold(100)
    expect(() => fold.accept('message.done', event('message.done', {
      Message: {
        Type: 'reply',
        MessageId: 'empty-reply',
        Contents: [{ Type: 'text', Text: null }],
      },
    }))).not.toThrow()
    fold.accept('message.done', event('message.done', {
      Message: {
        Type: 'reply',
        MessageId: 'wrapped-reply',
        Contents: [{ Type: 'text', Text: { Value: 'wrapped answer' } }],
      },
    }))
    expect(fold.collect()).toEqual([{ type: 'text', text: 'wrapped answer' }])
    fold.accept('response.completed', event('response.completed', {
      Response: {
        Status: 'success',
        Messages: [{
          Type: 'reply',
          MessageId: 'final',
          Contents: [{ Type: 'text', Text: { Content: 'final answer' } }],
        }],
      },
    }))
    expect(fold.finish()).toBe('completed')
    expect(fold.collect()).toEqual([{ type: 'text', text: 'final answer' }])
  })

  it('maps remote stop and failed statuses without reporting success', () => {
    for (const [status, expected] of [['stop', 'aborted'], ['failed', 'error']] as const) {
      const fold = new AdpResponseFold(100)
      fold.accept('response.completed', event('response.completed', {
        Response: { Status: status, Messages: [] },
      }))
      expect(fold.finish()).toBe(expected)
    }
  })

  it('surfaces ADP error diagnostics', () => {
    const fold = new AdpResponseFold(100)
    expect(() => fold.accept('error', event('error', {
      Error: {
        Code: 460501,
        Message: 'invalid input',
        RequestId: 'request-id',
        TraceId: 'trace-id',
      },
    }))).toThrow(AdpApiError)

    try {
      fold.accept('error', event('error', {
        Error: { Code: 460501, Message: 'invalid input', RequestId: 'request-id', TraceId: 'trace-id' },
      }))
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: 460501, requestId: 'request-id', traceId: 'trace-id' })
    }
  })

  it('rejects mismatched event names, incomplete streams, and oversized output', () => {
    const mismatch = new AdpResponseFold(100)
    expect(() => mismatch.accept('text.delta', event('text.replace', {
      MessageId: 'm', Text: 'x',
    }))).toThrow(AdpProtocolError)

    const incomplete = new AdpResponseFold(100)
    expect(() => incomplete.finish()).toThrow('ended before response.completed')

    const oversized = new AdpResponseFold(4)
    expect(() => oversized.accept('text.delta', event('text.delta', {
      MessageId: 'm', Text: '12345',
    }))).toThrow('exceeds maxOutputChars')

    const thought = new AdpResponseFold(4)
    thought.accept('message.added', event('message.added', {
      Message: { Type: 'thought', MessageId: 'thought-1' },
    }))
    expect(() => thought.accept('text.delta', event('text.delta', {
      MessageId: 'thought-1', Text: 'a long private thought' },
    ))).not.toThrow()
    expect(thought.collect()).toEqual([])
  })

  it('ignores unknown presentation events', () => {
    const fold = new AdpResponseFold(100)
    fold.accept('future.widget.updated', event('future.widget.updated', { Widget: {} }))
    expect(fold.collect()).toEqual([])
  })
})
