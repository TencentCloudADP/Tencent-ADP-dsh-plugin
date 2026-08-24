/**
 * Serialize harness messages into ADP's OpenAI-shaped gateway.
 * Matches `@deepseek-ai/dsh-llm-deepseek` wire rules so Hunyuan / DeepSeek /
 * Kimi / GLM on the same host all survive a multi-step tool loop.
 */
import type { ContentBlock, GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import { LlmError } from '@deepseek-ai/dsh-llm'

function flattenText(blocks: ContentBlock[]): string {
  return blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('')
}

function flattenReasoning(blocks: ContentBlock[]): string {
  return blocks.filter((b) => b.type === 'reasoning').map((b) => (b as { text: string }).text).join('')
}

/** Serialize one assistant message (text + reasoning + tool calls). */
function serializeAssistant(message: Message): Record<string, unknown> {
  const text = flattenText(message.content)
  const reasoning = flattenReasoning(message.content)
  const toolCalls = message.content
    .filter((b) => b.type === 'tool-call')
    .map((b) => {
      const call = b as { type: 'tool-call'; id: string; name: string; arguments: string }
      return {
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: call.arguments },
      }
    })

  return {
    role: 'assistant',
    // Text-less turns send "" — NEVER null. Pure tool-call turns: official
    // samples replay message.content as "" and some gateways (DeepSeek V4,
    // Kimi) reject null outright. A null here also bricks later turns of the
    // same session once it sits in history.
    content: text,
    // Thinking-mode passback: reasoning_content must return on tool-call
    // turns. Plain turns drop it to save tokens.
    ...toolCalls.length > 0 && reasoning.length > 0 ? { reasoning_content: reasoning } : {},
    ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
  }
}

/**
 * Serialize the conversation. `tool-result` blocks become standalone
 * `{role: 'tool'}` messages. A mixed user message contributes its text first
 * and its tool results as separate wire messages after — dropping the text
 * used to hide the model's own commentary from the next gateway request.
 */
export function serializeMessages(options: GenerateOptions): unknown[] {
  const wire: unknown[] = []
  if (options.system) wire.push({ role: 'system', content: options.system })
  for (const message of options.messages) {
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message))
      continue
    }
    const toolResults = message.content.filter((b) => b.type === 'tool-result')
    const text = flattenText(message.content)
    if (text.length > 0 || toolResults.length === 0) {
      wire.push({ role: 'user', content: text })
    }
    for (const result of toolResults) {
      const block = result as { type: 'tool-result'; toolCallId: string; content: ContentBlock[]; isError?: boolean }
      wire.push({
        role: 'tool',
        tool_call_id: block.toolCallId,
        content: flattenText(block.content) || (block.isError ? 'error' : '(no output)'),
      })
    }
  }
  return wire
}

export function serializeTools(tools: ToolSchema[] | undefined): unknown[] | undefined {
  if (!tools?.length) return undefined
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
}

export function serializeRequest(options: GenerateOptions): Record<string, unknown> {
  if (options.stop?.length) {
    // ADP gateway honors stop; keep it. (DeepSeek adapter throws UNSUPPORTED for some options.)
  }
  return {
    model: options.model,
    stream: true,
    stream_options: { include_usage: true },
    messages: serializeMessages(options),
    ...options.tools?.length ? { tools: serializeTools(options.tools) } : {},
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {},
    ...options.stop?.length ? { stop: options.stop } : {},
  }
}

export function httpErrorCode(status: number): string {
  if (status === 401 || status === 403) return 'INVALID_CREDENTIAL'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

export function throwIfUnsupported(options: GenerateOptions): void {
  void options
  void LlmError
}
