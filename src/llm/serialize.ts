import type { ContentBlock, GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import { LlmError } from '@deepseek-ai/dsh-llm'

function textOf(blocks: ContentBlock[]): string {
  return blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('')
}

export function serializeMessages(options: GenerateOptions): unknown[] {
  const out: unknown[] = []
  if (options.system) out.push({ role: 'system', content: options.system })
  for (const message of options.messages) {
    out.push(...serializeMessage(message))
  }
  return out
}

function serializeMessage(message: Message): unknown[] {
  const toolResults = message.content.filter((b) => b.type === 'tool-result')
  if (toolResults.length > 0) {
    return toolResults.map((b) => {
      const block = b as { type: 'tool-result'; toolCallId: string; content: ContentBlock[]; isError?: boolean }
      return {
        role: 'tool',
        tool_call_id: block.toolCallId,
        content: textOf(block.content) || (block.isError ? 'error' : ''),
      }
    })
  }
  const toolCalls = message.content.filter((b) => b.type === 'tool-call')
  if (message.role === 'assistant' && toolCalls.length > 0) {
    return [{
      role: 'assistant',
      content: textOf(message.content) || null,
      tool_calls: toolCalls.map((b) => {
        const call = b as { type: 'tool-call'; id: string; name: string; arguments: string }
        return {
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        }
      }),
    }]
  }
  const role = message.role === 'system' ? 'system' : message.role === 'assistant' ? 'assistant' : 'user'
  return [{ role, content: textOf(message.content) }]
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
