/**
 * Projection of Tencent ADP SSE events into a normal DSH child-session log.
 * The web UI therefore renders the remote run through the same transcript
 * components as an in-process subagent: reasoning, tool calls/results, and the
 * final answer are all standard session events.
 * @module @tencentcloudadp/dsh-adp/subagent/transcript
 */

import {
  CallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  type ContentBlock,
} from '@deepseek-ai/dsh-llm'
import type { Session, TurnEndReason } from '@deepseek-ai/dsh-session'
import type {
  SubagentDescriptorData,
  SubagentResult,
} from '@deepseek-ai/dsh-subagent'

/** Default cap for ADP reasoning and procedure detail copied to the session. */
export const DEFAULT_MAX_TRACE_CHARS = 256 * 1024

interface ProcedureState {
  readonly callId: ReturnType<typeof CallId>
  readonly callSeq: number
  readonly name: string
  readonly step: number
  done: boolean
}

interface ToolMessageState {
  readonly procedure: ProcedureState
  readonly contents: Map<number, string>
}

interface AdpTranscriptOptions {
  readonly provider: string
  readonly model: string
  readonly maxTraceChars: number
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function textFromContents(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value.flatMap((item) => {
    const content = record(item)
    return content?.Type === 'text' && typeof content.Text === 'string' ? [content.Text] : []
  }).join('')
}

function toolTextFromContents(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value.flatMap((item) => {
    const content = record(item)
    return typeof content?.Text === 'string' ? [content.Text] : []
  }).join('\n')
}

function procedures(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  const result: Record<string, unknown>[] = []
  for (const item of value) {
    const procedure = record(item)
    if (procedure !== undefined) result.push(procedure)
  }
  return result
}

function statusIsTerminal(status: string | undefined): boolean {
  return status === 'success'
    || status === 'failed'
    || status === 'error'
    || status === 'stop'
    || status === 'cancelled'
    || status === 'canceled'
}

function statusIsError(status: string | undefined): boolean {
  return status === 'failed'
    || status === 'error'
    || status === 'stop'
    || status === 'cancelled'
    || status === 'canceled'
}

function toTurnEndReason(reason: SubagentResult['stopReason'], failure?: Error): TurnEndReason {
  switch (reason) {
    case 'completed':
      return { kind: 'completed' }
    case 'aborted':
      return { kind: 'aborted', reason: { kind: 'parent' } }
    case 'max-tokens':
      return { kind: 'max-tokens' }
    case 'refusal':
      return { kind: 'blocked' }
    case 'error':
    default:
      return {
        kind: 'error',
        error: {
          message: failure?.message.slice(0, 2_000) ?? 'Tencent ADP subagent run failed',
          code: 'UNKNOWN',
        },
      }
  }
}

/** One session-backed projection for one ADP request. */
export class AdpNativeTranscript {
  private readonly messageTypes = new Map<string, string>()
  private readonly thoughtMessages = new Set<string>()
  private readonly procedureStates = new Map<string, ProcedureState>()
  private readonly toolMessages = new Map<string, ToolMessageState>()
  private reasoning = ''
  private traceChars = 0
  private toolCounter = 0
  private finished = false
  private readonly turn = 1
  private step = 1
  private stepOpen = false
  private advanceAfterTools = false
  private chunkSeqs: number[] = []

  constructor(
    private readonly session: Session,
    private readonly options: AdpTranscriptOptions,
  ) {}

  /** Open the child turn and persist its prompt and subagent identity. */
  start(prompt: readonly ContentBlock[], descriptor: SubagentDescriptorData): void {
    this.session.append('turn/start', { turn: this.turn })
    this.session.append('user/message', createUserMessage({
      content: [...prompt],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    this.session.append('subagent/descriptor', descriptor)
    this.openStep()
  }

  /** Consume one already protocol-validated SSE event. Unknown shapes are ignored. */
  accept(_eventName: string | undefined, data: string): void {
    if (this.finished || data === '[DONE]') return
    let event: Record<string, unknown> | undefined
    try {
      event = record(JSON.parse(data))
    } catch {
      return
    }
    if (event === undefined) return
    const type = string(event.Type)
    switch (type) {
      case 'message.added':
      case 'message.processing':
      case 'message.done':
        this.acceptMessage(record(event.Message))
        break
      case 'text.delta':
        this.acceptDelta(event)
        break
      case 'text.replace':
        this.acceptReplacement(event)
        break
      case 'response.processing':
        this.appendReasoning(string(event.StatusDesc) ?? '')
        break
      case 'thought':
        this.acceptThoughtEvent(event)
        break
      case 'response.completed':
        this.acceptCompleted(record(event.Response))
        break
      default:
        // ADP presentation-only events deliberately remain outside the native
        // transcript until they carry reasoning or procedure semantics.
        break
    }
  }

  /** Close the synthetic step/turn with the authoritative ADP result. */
  finish(result: SubagentResult, failure?: Error): void {
    if (this.finished) return
    this.finished = true
    for (const state of this.toolMessages.values()) {
      if (!state.procedure.done) {
        const resultText = this.toolMessageText(state)
        this.appendToolResult(
          state.procedure,
          resultText || 'ADP tool call ended without a terminal status',
          result.stopReason !== 'completed',
        )
      }
    }
    for (const state of this.procedureStates.values()) {
      if (!state.done) this.appendToolResult(state, 'ADP procedure ended without a terminal status', true)
    }

    const content: ContentBlock[] = []
    if (this.reasoning.length > 0) content.push({ type: 'reasoning', text: this.reasoning })
    content.push(...result.output)
    if (content.length > 0) {
      this.ensureAssistantStep()
      this.session.append('assistant/message', {
        turn: this.turn,
        step: this.step,
        message: createAssistantMessage({
          content,
          source: { provider: this.options.provider, model: this.options.model },
        }),
      }, { surfaceOp: 'append', sourceEventSeqs: this.chunkSeqs })
    }
    this.closeStep()
    this.session.append('turn/end', { turn: this.turn, reason: toTurnEndReason(result.stopReason, failure) })
  }

  private acceptMessage(message: Record<string, unknown> | undefined): void {
    if (message === undefined) return
    const id = string(message.MessageId)
    const type = string(message.Type)
    if (id === undefined || type === undefined) return
    this.messageTypes.set(id, type)
    if (type === 'tool_call') {
      this.acceptToolMessage(id, message)
      return
    }
    if (type !== 'thought' || this.thoughtMessages.has(id)) return
    const text = textFromContents(message.Contents)
    if (text.length > 0) {
      this.thoughtMessages.add(id)
      this.appendReasoning(text)
    }
  }

  private acceptDelta(event: Record<string, unknown>): void {
    const id = string(event.MessageId)
    const text = typeof event.Text === 'string' ? event.Text : ''
    if (id === undefined || text.length === 0) return
    const messageType = this.messageTypes.get(id)
    if (messageType === 'thought') {
      this.thoughtMessages.add(id)
      this.appendReasoning(text)
    } else if (messageType === 'tool_call') {
      this.updateToolMessageContent(id, event.ContentIndex, text, false)
    } else if (messageType === 'reply') {
      this.ensureAssistantStep()
      const chunk = this.session.append('assistant/chunk', {
        turn: this.turn,
        step: this.step,
        chunk: { type: 'text-delta', index: 1, text },
      })
      this.chunkSeqs.push(chunk.seq)
    }
  }

  private acceptReplacement(event: Record<string, unknown>): void {
    const id = string(event.MessageId)
    const text = typeof event.Text === 'string' ? event.Text : ''
    if (id === undefined || this.messageTypes.get(id) !== 'tool_call') return
    this.updateToolMessageContent(id, event.ContentIndex, text, true)
  }

  private acceptThoughtEvent(event: Record<string, unknown>): void {
    const thought = record(event.Thought) ?? record(event.Payload)
    const list = procedures(event.Procedures ?? thought?.Procedures)
    this.acceptProcedures(list)
  }

  private acceptCompleted(response: Record<string, unknown> | undefined): void {
    if (response === undefined) return
    if (Array.isArray(response.Messages)) {
      for (const raw of response.Messages) {
        const message = record(raw)
        if (message?.Type === 'tool_call') {
          this.acceptMessage(message)
          continue
        }
        const id = string(message?.MessageId)
        if (message?.Type !== 'thought' || (id !== undefined && this.thoughtMessages.has(id))) continue
        const text = textFromContents(message.Contents)
        if (text.length > 0) {
          if (id !== undefined) this.thoughtMessages.add(id)
          this.appendReasoning(text)
        }
      }
    }
    this.acceptProcedures(procedures(response.Procedures))
  }

  private acceptProcedures(list: readonly Record<string, unknown>[]): void {
    for (const [position, procedure] of list.entries()) {
      const debugging = record(procedure.Debugging)
      const displayThought = debugging?.DisplayThought
      const thought = typeof displayThought === 'string'
        ? displayThought
        : displayThought === true ? string(debugging?.Content) ?? '' : ''
      if (thought.length > 0) this.appendReasoning(thought)

      const pluginType = string(procedure.PluginType)
      const type = string(procedure.Type)
      const rawName = string(procedure.ToolName)
        ?? pluginType
        ?? string(procedure.NodeName)
        ?? string(procedure.WorkflowName)
        ?? string(procedure.Name)
      const toolLike = rawName !== undefined && (
        pluginType !== undefined
        || debugging !== undefined
        || type === 'plugin'
        || type === 'tool'
        || type === 'workflow'
      )
      if (!toolLike) continue

      const key = String(procedure.Index ?? `${rawName}:${position}`)
      let state = this.procedureStates.get(key)
      if (state === undefined) {
        state = this.appendToolCall(key, rawName, procedure)
        this.procedureStates.set(key, state)
      }
      const status = string(procedure.Status)
      if (!state.done && statusIsTerminal(status)) {
        const result = string(debugging?.DisplayContent)
          ?? string(debugging?.Content)
          ?? string(procedure.StatusDesc)
          ?? string(procedure.Title)
          ?? status
          ?? 'completed'
        this.appendToolResult(state, result, statusIsError(status))
      }
    }
  }

  private acceptToolMessage(id: string, message: Record<string, unknown>): void {
    const extra = record(message.ExtraInfo)
    const name = string(extra?.ToolName)
      ?? string(message.Name)
      ?? string(message.Title)
      ?? 'adp_tool'
    const key = `message:${id}`
    let state = this.toolMessages.get(id)
    if (state === undefined) {
      const procedure = this.appendToolCall(key, name, {
        ...message,
        ToolName: name,
        ToolInput: extra?.ToolInput,
      })
      state = { procedure, contents: new Map() }
      this.toolMessages.set(id, state)
    }

    const completedText = toolTextFromContents(message.Contents)
    if (completedText.length > 0) state.contents.set(0, completedText)
    const status = string(message.Status)
    if (!state.procedure.done && statusIsTerminal(status)) {
      this.appendToolResult(
        state.procedure,
        this.toolMessageText(state)
          || string(message.StatusDesc)
          || status
          || 'completed',
        statusIsError(status),
      )
    }
  }

  private updateToolMessageContent(
    id: string,
    rawIndex: unknown,
    text: string,
    replace: boolean,
  ): void {
    const state = this.toolMessages.get(id)
    if (state === undefined) return
    const index = typeof rawIndex === 'number' && Number.isSafeInteger(rawIndex) && rawIndex >= 0
      ? rawIndex
      : 0
    state.contents.set(index, replace ? text : `${state.contents.get(index) ?? ''}${text}`)
  }

  private toolMessageText(state: ToolMessageState): string {
    return [...state.contents.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, value]) => value)
      .join('\n')
  }

  private appendReasoning(value: string): void {
    const text = this.takeTrace(value)
    if (text.length === 0) return
    this.ensureAssistantStep()
    this.reasoning += text
    const chunk = this.session.append('assistant/chunk', {
      turn: this.turn,
      step: this.step,
      chunk: { type: 'reasoning-delta', index: 0, text },
    })
    this.chunkSeqs.push(chunk.seq)
  }

  private appendToolCall(key: string, name: string, procedure: Record<string, unknown>): ProcedureState {
    this.ensureAssistantStep()
    const callId = CallId(`adp:${++this.toolCounter}:${key}`)
    const rawInput = string(procedure.ToolInput)
    let args: string
    if (rawInput !== undefined) {
      try {
        JSON.parse(rawInput)
        args = rawInput
      } catch {
        args = JSON.stringify({ input: rawInput })
      }
    } else {
      args = JSON.stringify({
        ...(string(procedure.Title) === undefined ? {} : { title: string(procedure.Title) }),
        ...(string(procedure.Type) === undefined ? {} : { type: string(procedure.Type) }),
        ...(string(procedure.WorkflowName) === undefined ? {} : { workflow: string(procedure.WorkflowName) }),
        ...(string(procedure.NodeName) === undefined ? {} : { node: string(procedure.NodeName) }),
        ...(string(procedure.TargetAgentName) === undefined ? {} : { targetAgent: string(procedure.TargetAgentName) }),
      })
    }
    const content: ContentBlock[] = []
    if (this.reasoning.length > 0) {
      content.push({ type: 'reasoning', text: this.reasoning })
      this.reasoning = ''
    }
    content.push({ type: 'tool-call', id: callId, name, arguments: args })
    this.session.append('assistant/message', {
      turn: this.turn,
      step: this.step,
      message: createAssistantMessage({
        content,
        source: { provider: this.options.provider, model: this.options.model },
      }),
    }, { surfaceOp: 'append', sourceEventSeqs: this.chunkSeqs })
    const call = this.session.append('tool/call', {
      turn: this.turn,
      step: this.step,
      callId,
      name,
      arguments: args,
    })
    return { callId, callSeq: call.seq, name, step: this.step, done: false }
  }

  private appendToolResult(state: ProcedureState, value: string, isError: boolean): void {
    const text = this.takeTrace(value) || (isError ? 'ADP procedure failed' : 'ADP procedure completed')
    this.session.append('tool/result', {
      turn: this.turn,
      step: state.step,
      message: createToolResultMessage({
        callId: state.callId,
        content: [{ type: 'text', text }],
        isError,
      }),
      ...(isError ? { error: { name: 'AdpProcedureError', code: 'ADP_PROCEDURE_FAILED' } } : {}),
    }, { surfaceOp: 'append', sourceEventSeqs: [state.callSeq] })
    state.done = true
    if (state.step === this.step) this.advanceAfterTools = true
  }

  private ensureAssistantStep(): void {
    if (!this.stepOpen) this.openStep()
    if (!this.advanceAfterTools || this.hasPendingTools(this.step)) return
    this.closeStep()
    this.step += 1
    this.openStep()
  }

  private hasPendingTools(step: number): boolean {
    for (const state of this.toolMessages.values()) {
      if (state.procedure.step === step && !state.procedure.done) return true
    }
    for (const state of this.procedureStates.values()) {
      if (state.step === step && !state.done) return true
    }
    return false
  }

  private openStep(): void {
    if (this.stepOpen) return
    this.session.append('step/start', { turn: this.turn, step: this.step })
    this.stepOpen = true
    this.advanceAfterTools = false
    this.chunkSeqs = []
  }

  private closeStep(): void {
    if (!this.stepOpen) return
    this.session.append('step/end', { turn: this.turn, step: this.step })
    this.stepOpen = false
  }

  private takeTrace(value: string): string {
    const remaining = this.options.maxTraceChars - this.traceChars
    if (remaining <= 0 || value.length === 0) return ''
    const text = value.length <= remaining
      ? value
      : remaining === 1 ? '…' : `${value.slice(0, remaining - 1)}…`
    this.traceChars += text.length
    return text
  }
}
