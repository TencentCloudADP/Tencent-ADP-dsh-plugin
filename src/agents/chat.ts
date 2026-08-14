export const MSG_REPLY = 'reply'
export const MSG_THOUGHT = 'thought'
export const EV_MESSAGE_ADDED = 'message.added'
export const EV_MESSAGE_PROCESSING = 'message.processing'
export const EV_MESSAGE_DONE = 'message.done'
export const EV_TEXT_DELTA = 'text.delta'
export const EV_ERROR = 'error'
export const EV_RESPONSE_COMPLETED = 'response.completed'

export class AdpChatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AdpChatError'
  }
}

export function newConversationId(): string {
  return crypto.randomUUID()
}

export function parseSseLine(line: string): Record<string, unknown> | undefined {
  const trimmed = (line || '').trim()
  if (!trimmed.startsWith('data:')) return undefined
  const body = trimmed.slice(5).trim()
  if (!body || body === '[DONE]') return undefined
  try {
    const event = JSON.parse(body) as unknown
    return event && typeof event === 'object' ? event as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

export function buildChatRequest(input: {
  appKey: string
  conversationId: string
  question: string
  visitorId: string
  files?: Array<{ type: string; url?: string; text?: string; name?: string }>
}): Record<string, unknown> {
  const contents: Array<Record<string, unknown>> = [{ Type: 'text', Text: input.question }]
  for (const file of input.files ?? []) {
    contents.push({
      Type: file.type || 'file',
      ...file.url ? { Url: file.url } : {},
      ...file.text ? { Text: file.text } : {},
      ...file.name ? { FileName: file.name } : {},
    })
  }
  return {
    ConversationId: input.conversationId,
    AppKey: input.appKey,
    Contents: contents,
    Incremental: true,
    EnableMultiIntent: true,
    VisitorId: input.visitorId,
    Stream: 'enable',
  }
}

export interface ChatReply {
  answer: string
  conversationId: string
  thought: string
  trace: string[]
  references: Array<Record<string, unknown>>
  files: Array<{ url: string; name?: string; type?: string }>
}

export class ReplyAssembler {
  private readonly types = new Map<string, string>()
  private readonly deltas = new Map<string, string[]>()
  private readonly order: string[] = []
  private readonly references: Array<Record<string, unknown>> = []
  private readonly trace: string[] = []
  private readonly files: Array<{ url: string; name?: string; type?: string }> = []
  completed = false

  constructor(readonly conversationId: string) {}

  feed(event: Record<string, unknown>): void {
    const eventType = String(event.Type ?? '')
    if (eventType === EV_ERROR) {
      const error = (event.Error ?? {}) as Record<string, unknown>
      throw new AdpChatError(`ADP error ${error.Code ?? '?'}: ${error.Message ?? 'unknown'}`)
    }
    if (eventType === EV_MESSAGE_ADDED || eventType === EV_MESSAGE_PROCESSING || eventType === EV_MESSAGE_DONE) {
      const message = (event.Message ?? {}) as Record<string, unknown>
      this.noteMessage(message)
      if (eventType === EV_MESSAGE_DONE) this.collect(message)
      return
    }
    if (eventType === EV_TEXT_DELTA) {
      const messageId = String(event.MessageId ?? '')
      const text = String(event.Text ?? '')
      if (messageId && text) {
        const list = this.deltas.get(messageId) ?? []
        list.push(text)
        this.deltas.set(messageId, list)
        if (!this.order.includes(messageId)) this.order.push(messageId)
      }
      return
    }
    if (eventType === EV_RESPONSE_COMPLETED) this.completed = true
  }

  result(): ChatReply {
    let answer = this.textFor(MSG_REPLY)
    if (!answer) {
      answer = this.order
        .filter((id) => !this.types.get(id))
        .map((id) => (this.deltas.get(id) ?? []).join(''))
        .join('')
    }
    return {
      answer,
      conversationId: this.conversationId,
      thought: this.textFor(MSG_THOUGHT),
      trace: [...this.trace],
      references: [...this.references],
      files: [...this.files],
    }
  }

  private noteMessage(message: Record<string, unknown>): void {
    const messageId = String(message.MessageId ?? '')
    if (!messageId) return
    const msgType = String(message.Type ?? '')
    const known = this.types.get(messageId)
    this.types.set(messageId, msgType || known || '')
    if (!this.order.includes(messageId)) {
      this.order.push(messageId)
      if (msgType) this.trace.push(msgType)
    }
  }

  private collect(message: Record<string, unknown>): void {
    const msgType = String(message.Type ?? '')
    for (const content of (message.Contents as Array<Record<string, unknown>> | undefined) ?? []) {
      if (msgType === MSG_REPLY) {
        for (const ref of (content.References as Array<Record<string, unknown>> | undefined) ?? []) {
          if (ref && typeof ref === 'object') this.references.push(ref)
        }
      }
      const type = String(content.Type ?? '').toLowerCase()
      if (type === 'file' || type === 'image' || type === 'video' || type === 'audio') {
        const url = String(content.Url ?? content.FileUrl ?? content.CosUrl ?? '')
        if (url) {
          this.files.push({
            url,
            ...content.FileName || content.Name ? { name: String(content.FileName ?? content.Name) } : {},
            type,
          })
        }
      }
    }
  }

  private textFor(wanted: string): string {
    return this.order
      .filter((id) => this.types.get(id) === wanted)
      .map((id) => (this.deltas.get(id) ?? []).join(''))
      .join('')
  }
}

export function assemble(conversationId: string, lines: Iterable<string>): ChatReply {
  const assembler = new ReplyAssembler(conversationId)
  for (const line of lines) {
    const event = parseSseLine(line)
    if (event) assembler.feed(event)
  }
  return assembler.result()
}

export async function streamChat(
  url: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  idleTimeoutMs = 180_000,
): Promise<ChatReply> {
  const conversationId = String(body.ConversationId ?? '')
  const assembler = new ReplyAssembler(conversationId)
  const controller = new AbortController()
  const fused = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  const timer = setTimeout(() => controller.abort(), idleTimeoutMs)
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: fused,
    })
    if (!resp.ok) {
      const text = await resp.text()
      throw new AdpChatError(`ADP HTTP ${resp.status}: ${text.slice(0, 300)}`)
    }
    if (!resp.body) throw new AdpChatError('ADP chat returned no body')
    const reader = resp.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += value
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const event = parseSseLine(line)
        if (event) assembler.feed(event)
      }
    }
  } finally {
    clearTimeout(timer)
  }
  return assembler.result()
}
