/**
 * OpenAI-compatible SSE translator. Usage is flushed before finish; tool-call
 * arguments stay raw JSON strings.
 */
import { CallId, EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { EventSourceParserStream } from 'eventsource-parser/stream'

export const DONE = '[DONE]'

export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  onComment?: (comment: string) => void,
): AsyncGenerator<string> {
  const events = stream
    .pipeThrough(new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>)
    .pipeThrough(new EventSourceParserStream({ onComment }))
  for await (const { data } of events as unknown as AsyncIterable<{ data: string }>) {
    yield data
    if (data === DONE) return
  }
  // Some servers close the socket without a [DONE] frame.
  yield DONE
}

interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  callId?: string
  name?: string
}

interface WireUsage {
  prompt_tokens: number
  completion_tokens: number
  prompt_tokens_details?: { cached_tokens?: number }
  prompt_cache_hit_tokens?: number
  completion_tokens_details?: { reasoning_tokens?: number }
}

interface WireChunk {
  choices?: Array<{
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string | null
        function?: { name?: string | null; arguments?: string | Record<string, unknown> | null }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: WireUsage
}

/** First non-empty identity wins. Continuation deltas often repeat id/name as "" or null. */
function keepIdentity(current: string | undefined, next: string | null | undefined): string | undefined {
  if (typeof next === 'string' && next.length > 0) return next
  return current
}

function argumentsFragment(value: string | Record<string, unknown> | null | undefined): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') return JSON.stringify(value)
  return ''
}

export function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop': return { kind: 'stop' }
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    default:
      return { kind: 'error', failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() } }
  }
}

export function mapUsage(usage: WireUsage): TokenUsage {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  return {
    inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens,
    ...cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {},
    ...reasoning !== undefined ? { reasoningTokens: reasoning } : {},
  }
}

function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'reasoning', text: block.text }
    case 'tool-call':
      return {
        type: 'tool-call',
        id: CallId(block.callId ?? ''),
        name: block.name ?? '',
        arguments: block.text,
      }
  }
}

export async function* translate(payloads: AsyncIterable<string>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  let textBlock: OpenBlock | undefined
  let reasoningBlock: OpenBlock | undefined
  const toolBlocks = new Map<number, OpenBlock>()
  const order: OpenBlock[] = []
  let pendingFinish: FinishReason | undefined
  let pendingUsage: TokenUsage | undefined

  function open(kind: OpenBlock['kind']): OpenBlock {
    const block: OpenBlock = { index: nextIndex++, kind, text: '' }
    order.push(block)
    return block
  }

  for await (const payload of payloads) {
    if (payload === DONE) {
      for (const block of order) {
        yield { type: 'block-end', index: block.index, block: closeBlock(block) }
      }
      if (pendingUsage) yield { type: 'usage', usage: pendingUsage }
      const reason = pendingFinish ?? { kind: 'stop' as const }
      yield {
        type: 'finish',
        reason: reason.kind === 'stop' && order.length === 0
          ? {
              kind: 'error',
              failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
            }
          : reason,
      }
      return
    }

    let chunk: WireChunk
    try {
      chunk = JSON.parse(payload) as WireChunk
    } catch {
      throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE')
    }

    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta
      const reasoning = delta?.reasoning_content
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = open('reasoning')
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += reasoning
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning }
      }
      const content = delta?.content
      if (typeof content === 'string' && content.length > 0) {
        if (!textBlock) {
          textBlock = open('text')
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += content
        yield { type: 'text-delta', index: textBlock.index, text: content }
      }
      for (const call of delta?.tool_calls ?? []) {
        const wireIndex = call.index ?? toolBlocks.size
        let block = toolBlocks.get(wireIndex)
        if (!block) {
          block = open('tool-call')
          toolBlocks.set(wireIndex, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        block.callId = keepIdentity(block.callId, call.id)
        block.name = keepIdentity(block.name, call.function?.name)
        const fragment = argumentsFragment(call.function?.arguments)
        block.text += fragment
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: CallId(block.callId ?? ''),
          ...block.name ? { name: block.name } : {},
          argumentsDelta: fragment,
        }
      }
      if (typeof choice.finish_reason === 'string') pendingFinish = mapFinishReason(choice.finish_reason)
    }
    if (chunk.usage) pendingUsage = mapUsage(chunk.usage)
  }
  throw new LlmError('SSE payload stream ended without [DONE]', 'STREAM_CLOSED')
}
