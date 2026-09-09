/**
 * Tencent Cloud ADP `/adp/v2/chat` request fields and streaming response fold.
 * Known wire events are validated before use; unknown event types are ignored
 * so the provider remains forward compatible with new ADP presentation events.
 * @module @tencentcloudadp/dsh-adp/subagent/protocol
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentStopReason } from '@deepseek-ai/dsh-subagent'

/** One text content item accepted by the ADP chat request. */
export interface AdpTextContent {
  readonly Type: 'text'
  readonly Text: string
}

/** Request body sent to the ADP HTTP SSE endpoint. */
export interface AdpChatRequest {
  readonly RequestId: string
  readonly ConversationId: string
  readonly AppKey: string
  readonly VisitorId: string
  readonly Contents: AdpTextContent[]
  readonly Incremental: true
  readonly Stream: 'enable'
  readonly StreamingThrottle?: number
  readonly SystemRole?: string
  readonly SearchNetwork?: 'enable' | 'disable'
  readonly ModelName?: string
  readonly WorkflowStatus?: 'enable' | 'disable'
  readonly EnableMultiIntent?: boolean
  readonly AgentId?: string
}

/** A malformed or incomplete ADP SSE response. */
export class AdpProtocolError extends Error {
  override readonly name = 'AdpProtocolError'
}

/** An ADP `error` event, with safe request diagnostics retained. */
export class AdpApiError extends Error {
  override readonly name = 'AdpApiError'

  /**
   * @param code - ADP error code.
   * @param message - ADP-provided error message.
   * @param requestId - request id returned by ADP, when present.
   * @param traceId - trace id returned by ADP, when present.
   */
  constructor(
    readonly code: number,
    message: string,
    readonly requestId?: string,
    readonly traceId?: string,
  ) {
    super(`ADP ${code}: ${message}`)
  }
}

interface MessageState {
  type?: string
  readonly contents: Map<number, string>
  readonly order: number
}

interface AdpMessage {
  readonly Type: string
  readonly MessageId: string
  readonly Contents?: unknown[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new AdpProtocolError(`${label} must be an object`)
  return value
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new AdpProtocolError(`${label} must be a string`)
  return value
}

/**
 * Read display text from ADP's loosely encoded content payloads. Deployed ADP
 * applications have been observed to emit `Text: null` on a terminal reply,
 * and some gateways wrap display text in `Value`/`Content`. Those forms carry
 * no protocol control meaning, so an absent/unrecognized value is safely an
 * empty fragment instead of aborting the whole response stream.
 */
function displayText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.map(displayText).join('')
  if (!isRecord(value)) return ''
  for (const key of ['Text', 'Value', 'Content'] as const) {
    if (value[key] !== undefined && value[key] !== value) return displayText(value[key])
  }
  return ''
}

function contentIndex(value: unknown): number {
  // Early ADP v2 examples omit ContentIndex for the sole content item even
  // though the field is documented as required. Accept that observed form as 0.
  if (value === undefined) return 0
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new AdpProtocolError('ContentIndex must be a non-negative safe integer')
  }
  return value as number
}

function parseMessage(value: unknown, label: string): AdpMessage {
  const message = requireRecord(value, label)
  const contents = message.Contents
  if (contents !== undefined && !Array.isArray(contents)) {
    throw new AdpProtocolError(`${label}.Contents must be an array`)
  }
  return {
    Type: requireString(message.Type, `${label}.Type`),
    MessageId: requireString(message.MessageId, `${label}.MessageId`),
    ...(contents === undefined ? {} : { Contents: contents }),
  }
}

function textContents(contents: readonly unknown[], label: string): Map<number, string> {
  const texts = new Map<number, string>()
  for (const [index, value] of contents.entries()) {
    const content = requireRecord(value, `${label}[${index}]`)
    const type = requireString(content.Type, `${label}[${index}].Type`)
    if (type !== 'text') continue
    texts.set(index, displayText(content.Text))
  }
  return texts
}

function joinContents(contents: ReadonlyMap<number, string>): string {
  return [...contents.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, text]) => text)
    .join('')
}

/**
 * Stateful fold for one ADP response stream. It applies `text.delta` and
 * `text.replace` by `(MessageId, ContentIndex)`, then lets `message.done` and
 * `response.completed` replace streamed candidates with authoritative data.
 */
export class AdpResponseFold {
  private readonly messages = new Map<string, MessageState>()
  private nextOrder = 0
  private trackedChars = 0
  private finalText: string | undefined
  private completedStatus: string | undefined
  private sawDoneEvent = false

  /** @param maxOutputChars - maximum text retained across in-flight messages. */
  constructor(private readonly maxOutputChars: number) {}

  /** Whether ADP sent its terminal `[DONE]` event. */
  get done(): boolean {
    return this.sawDoneEvent
  }

  /**
   * Consume one parsed SSE event.
   * @param eventName - SSE `event` field, when supplied.
   * @param data - complete SSE `data` payload.
   */
  accept(eventName: string | undefined, data: string): void {
    if (this.sawDoneEvent) throw new AdpProtocolError('ADP stream emitted an event after [DONE]')
    if (data === '[DONE]') {
      this.sawDoneEvent = true
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch (error: unknown) {
      throw new AdpProtocolError(`ADP event data is not valid JSON: ${String(error)}`)
    }
    const event = requireRecord(parsed, 'ADP event')
    const type = requireString(event.Type, 'ADP event.Type')
    if (eventName !== undefined && eventName !== type) {
      throw new AdpProtocolError(`SSE event ${JSON.stringify(eventName)} does not match data Type ${JSON.stringify(type)}`)
    }

    switch (type) {
      case 'message.added':
        this.acceptMessage(parseMessage(event.Message, 'Message'))
        return
      case 'content.added':
        this.acceptContentAdded(event)
        return
      case 'text.delta':
        this.acceptTextChange(event, false)
        return
      case 'text.replace':
        this.acceptTextChange(event, true)
        return
      case 'message.done':
        this.acceptMessage(parseMessage(event.Message, 'Message'))
        return
      case 'response.completed':
        this.acceptCompleted(event.Response)
        return
      case 'error':
        this.throwApiError(event.Error)
        return
      default:
        // request_ack, response.created/processing, message.processing,
        // quote/reference events, and future presentation events do not alter
        // the final reply selected by this provider.
    }
  }

  /**
   * Select the final or currently streamed reply.
   * @returns one DSH text block, or an empty list before any reply text exists.
   */
  collect(): ContentBlock[] {
    const text = this.finalText ?? this.latestReplyText()
    return text === undefined || text.length === 0 ? [] : [{ type: 'text', text }]
  }

  /**
   * Validate terminal protocol state and map the ADP status.
   * @returns the DSH stop reason for the completed response.
   */
  finish(): SubagentStopReason {
    if (this.completedStatus === undefined) {
      throw new AdpProtocolError('ADP stream ended before response.completed')
    }
    switch (this.completedStatus) {
      case 'success':
        return 'completed'
      case 'stop':
        return 'aborted'
      case 'failed':
        return 'error'
      default:
        throw new AdpProtocolError(`ADP response.completed has unknown status ${JSON.stringify(this.completedStatus)}`)
    }
  }

  private state(messageId: string): MessageState {
    let state = this.messages.get(messageId)
    if (state === undefined) {
      state = { contents: new Map(), order: this.nextOrder++ }
      this.messages.set(messageId, state)
    }
    return state
  }

  private acceptMessage(message: AdpMessage): void {
    const state = this.state(message.MessageId)
    state.type = message.Type
    if (message.Contents !== undefined) {
      this.replaceContents(
        state,
        message.Type === 'reply' ? textContents(message.Contents, 'Message.Contents') : new Map(),
      )
    }
  }

  private acceptContentAdded(event: Record<string, unknown>): void {
    const messageId = requireString(event.MessageId, 'MessageId')
    const index = contentIndex(event.ContentIndex)
    const content = requireRecord(event.Content, 'Content')
    const type = requireString(content.Type, 'Content.Type')
    if (type !== 'text') return
    const text = displayText(content.Text)
    const state = this.state(messageId)
    if (state.type !== undefined && state.type !== 'reply') return
    this.setContent(state, index, text)
  }

  private acceptTextChange(event: Record<string, unknown>, replace: boolean): void {
    const messageId = requireString(event.MessageId, 'MessageId')
    const index = contentIndex(event.ContentIndex)
    const text = displayText(event.Text)
    const state = this.state(messageId)
    if (state.type !== undefined && state.type !== 'reply') return
    this.setContent(state, index, replace ? text : `${state.contents.get(index) ?? ''}${text}`)
  }

  private acceptCompleted(value: unknown): void {
    const response = requireRecord(value, 'Response')
    this.completedStatus = requireString(response.Status, 'Response.Status')
    if (!Array.isArray(response.Messages)) {
      throw new AdpProtocolError('Response.Messages must be an array')
    }
    let lastReply: string | undefined
    for (const [index, raw] of response.Messages.entries()) {
      const message = parseMessage(raw, `Response.Messages[${index}]`)
      if (message.Type !== 'reply' || message.Contents === undefined) continue
      const text = joinContents(textContents(message.Contents, `Response.Messages[${index}].Contents`))
      if (text.length > 0) lastReply = text
    }
    if (lastReply !== undefined) this.assertOutputBound(lastReply.length)
    this.messages.clear()
    this.trackedChars = 0
    this.finalText = lastReply ?? ''
  }

  private throwApiError(value: unknown): never {
    const error = requireRecord(value, 'Error')
    if (typeof error.Code !== 'number' || !Number.isSafeInteger(error.Code)) {
      throw new AdpProtocolError('Error.Code must be a safe integer')
    }
    const message = requireString(error.Message, 'Error.Message')
    const requestId = error.RequestId === undefined ? undefined : requireString(error.RequestId, 'Error.RequestId')
    const traceId = error.TraceId === undefined ? undefined : requireString(error.TraceId, 'Error.TraceId')
    throw new AdpApiError(error.Code, message, requestId, traceId)
  }

  private setContent(state: MessageState, index: number, text: string): void {
    const previous = state.contents.get(index) ?? ''
    const nextTotal = this.trackedChars - previous.length + text.length
    this.assertOutputBound(nextTotal)
    state.contents.set(index, text)
    this.trackedChars = nextTotal
  }

  private replaceContents(state: MessageState, contents: Map<number, string>): void {
    const previous = [...state.contents.values()].reduce((sum, text) => sum + text.length, 0)
    const replacement = [...contents.values()].reduce((sum, text) => sum + text.length, 0)
    const nextTotal = this.trackedChars - previous + replacement
    this.assertOutputBound(nextTotal)
    state.contents.clear()
    for (const [index, text] of contents) state.contents.set(index, text)
    this.trackedChars = nextTotal
  }

  private latestReplyText(): string | undefined {
    let selected: { order: number; text: string } | undefined
    for (const state of this.messages.values()) {
      if (state.type !== 'reply') continue
      const text = joinContents(state.contents)
      if (text.length === 0 || (selected !== undefined && selected.order > state.order)) continue
      selected = { order: state.order, text }
    }
    return selected?.text
  }

  private assertOutputBound(chars: number): void {
    if (chars > this.maxOutputChars) {
      throw new AdpProtocolError(`ADP reply exceeds maxOutputChars (${this.maxOutputChars})`)
    }
  }
}
