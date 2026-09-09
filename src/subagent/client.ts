/**
 * One-shot ADP HTTP SSE driver. Publication occurs after the POST receives a
 * successful event-stream response; later protocol and transport failures are
 * flattened through the DSH `SubagentRun.result` contract.
 * @module @tencentcloudadp/dsh-adp/subagent/client
 */

import { randomUUID } from 'node:crypto'
import { createParser } from 'eventsource-parser'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  settleRunResult,
  subprocessRunHandle,
  type SubagentResult,
  type SubagentRun,
  type SubagentStartRequest,
  type SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import { AdpProtocolError, AdpResponseFold, type AdpChatRequest, type AdpTextContent } from './protocol.ts'

/** Default Tencent Cloud ADP v2 chat endpoint. */
export const DEFAULT_ADP_ENDPOINT = 'https://wss.lke.cloud.tencent.com/adp/v2/chat'
/** Default whole-request timeout, including streaming. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 300_000
/** Default maximum buffered size of one SSE event. */
export const DEFAULT_MAX_EVENT_CHARS = 4 * 1024 * 1024
/** Default maximum text retained from one response. */
export const DEFAULT_MAX_OUTPUT_CHARS = 1_000_000

/** Resolved per-run ADP connection and request options. */
export interface AdpRunSpec {
  readonly endpoint: string
  readonly appKey: string
  readonly visitorId: string
  readonly streamingThrottle?: number
  readonly systemRole?: string
  readonly searchNetwork?: 'enable' | 'disable'
  readonly modelName?: string
  readonly workflowStatus?: 'enable' | 'disable'
  readonly enableMultiIntent?: boolean
  readonly agentId?: string
  readonly requestTimeoutMs: number
  readonly maxEventChars: number
  readonly maxOutputChars: number
  /** Reserved child identity; omitted by standalone remote callers. */
  readonly runId?: SessionId
  /** Observe each validated ADP SSE event for native child-session projection. */
  readonly onEvent?: (eventName: string | undefined, data: string) => void
  /** Fetch implementation; overridable for deterministic tests. */
  readonly fetch?: typeof globalThis.fetch
  /** Diagnostic sink for failures flattened to `stopReason: error`. */
  readonly onError?: (error: Error, stopReason: SubagentStopReason) => void
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * Translate a DSH task prompt to ADP request contents.
 * @param prompt - DSH content blocks supplied by the tool consumer.
 * @returns non-empty ADP text contents.
 */
export function toAdpContents(prompt: readonly ContentBlock[]): AdpTextContent[] {
  const contents: AdpTextContent[] = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new AdpProtocolError(`ADP subagents support text prompts only; received ${JSON.stringify(block.type)}`)
    }
    if (block.text.length > 0) contents.push({ Type: 'text', Text: block.text })
  }
  if (contents.length === 0) throw new AdpProtocolError('ADP subagent prompt must contain non-empty text')
  return contents
}

/**
 * Consume an ADP event stream into a response fold.
 * @param body - successful HTTP response body.
 * @param fold - response state owner.
 * @param maxEventChars - parser buffer limit for one pending SSE event.
 */
export async function consumeAdpStream(
  body: ReadableStream<Uint8Array>,
  fold: AdpResponseFold,
  maxEventChars: number,
  onEvent?: (eventName: string | undefined, data: string) => void,
): Promise<void> {
  let parseFailure: Error | undefined
  const parser = createParser({
    maxBufferSize: maxEventChars,
    onEvent: (event) => {
      try {
        fold.accept(event.event, event.data)
        onEvent?.(event.event, event.data)
      } catch (error: unknown) {
        parseFailure = toError(error)
        throw parseFailure
      }
    },
    onError: (error) => {
      parseFailure = error
      throw error
    },
  })
  const decoder = new TextDecoder()
  const reader = body.getReader()
  try {
    while (!fold.done) {
      const chunk = await reader.read()
      if (chunk.done) break
      parser.feed(decoder.decode(chunk.value, { stream: true }))
    }
    if (!fold.done) {
      parser.feed(decoder.decode())
      parser.reset({ consume: true })
    } else {
      await reader.cancel()
    }
    if (parseFailure !== undefined) throw parseFailure
  } finally {
    reader.releaseLock()
  }
}

/**
 * Start one ADP request and publish a remote DSH subagent run after successful
 * HTTP response headers arrive.
 * @param request - validated DSH one-shot start request.
 * @param spec - resolved endpoint, credential, ADP options, and safety bounds.
 * @returns the published remote run.
 */
export async function startAdpRun(request: SubagentStartRequest, spec: AdpRunSpec): Promise<SubagentRun> {
  if (request.signal.aborted) throw new Error('subagent request was aborted before the ADP request started')

  const id = spec.runId ?? SessionId(randomUUID())
  const body: AdpChatRequest = {
    RequestId: randomUUID(),
    ConversationId: id,
    AppKey: spec.appKey,
    VisitorId: spec.visitorId,
    Contents: toAdpContents(request.prompt),
    Incremental: true,
    Stream: 'enable',
    ...(spec.streamingThrottle === undefined ? {} : { StreamingThrottle: spec.streamingThrottle }),
    ...(spec.systemRole === undefined ? {} : { SystemRole: spec.systemRole }),
    ...(spec.searchNetwork === undefined ? {} : { SearchNetwork: spec.searchNetwork }),
    ...(spec.modelName === undefined ? {} : { ModelName: spec.modelName }),
    ...(spec.workflowStatus === undefined ? {} : { WorkflowStatus: spec.workflowStatus }),
    ...(spec.enableMultiIntent === undefined ? {} : { EnableMultiIntent: spec.enableMultiIntent }),
    ...(spec.agentId === undefined ? {} : { AgentId: spec.agentId }),
  }
  const controller = new AbortController()
  let cancelled = false
  let timedOut = false
  const requestCancel = (): void => {
    if (cancelled) return
    cancelled = true
    controller.abort(new Error('ADP subagent request cancelled'))
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort(new Error(`ADP subagent request timed out after ${spec.requestTimeoutMs} ms`))
  }, spec.requestTimeoutMs)

  let response: Response
  try {
    response = await (spec.fetch ?? globalThis.fetch)(spec.endpoint, {
      method: 'POST',
      headers: {
        accept: 'text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (error: unknown) {
    clearTimeout(timeout)
    request.signal.removeEventListener('abort', onAbort)
    if (cancelled) throw new Error('subagent request was aborted before the ADP response started')
    if (timedOut) throw new Error(`ADP request timed out before response headers (${spec.requestTimeoutMs} ms)`)
    throw toError(error)
  }

  const rejectStartup = async (message: string): Promise<never> => {
    clearTimeout(timeout)
    request.signal.removeEventListener('abort', onAbort)
    await response.body?.cancel().catch(() => {})
    throw new Error(message)
  }
  if (!response.ok) {
    return rejectStartup(`ADP request failed before streaming: HTTP ${response.status} ${response.statusText}`)
  }
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.includes('text/event-stream')) {
    return rejectStartup(`ADP response is not an event stream (content-type: ${contentType || 'missing'})`)
  }
  if (response.body === null) return rejectStartup('ADP response has no body')

  const fold = new AdpResponseFold(spec.maxOutputChars)
  const collectOutput = (): ContentBlock[] => fold.collect()
  const result: Promise<SubagentResult> = settleRunResult({
    attempt: async () => {
      await consumeAdpStream(response.body!, fold, spec.maxEventChars, spec.onEvent)
      return { output: collectOutput(), stopReason: fold.finish() }
    },
    collectOutput,
    cancelled: () => cancelled,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })
  void result.finally(() => { clearTimeout(timeout) })

  return subprocessRunHandle({
    id,
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: async () => {
      controller.abort(new Error('ADP subagent run disposed'))
      await result
      if (!response.body!.locked) await response.body!.cancel().catch(() => {})
    },
  })
}
