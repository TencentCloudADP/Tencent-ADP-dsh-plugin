import { describe, expect, it } from 'vitest'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { serializeMessages, serializeRequest } from '../../src/llm/serialize.ts'
import { DONE, translate } from '../../src/llm/sse.ts'
import { agentToolName, askSlug } from '../../src/core/names.ts'
import { nestAgentFields, normalizeCallPayload } from '../../src/control/contracts.ts'

function request(messages: Message[], extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'adp', model: 'Hunyuan/hy3', messages, ...extra } as GenerateOptions
}

async function collect(payloads: string[]): Promise<StreamChunk[]> {
  async function* source() {
    for (const payload of payloads) yield payload
  }
  const chunks: StreamChunk[] = []
  for await (const chunk of translate(source())) chunks.push(chunk)
  return chunks
}

describe('agent-loop serialize (official DeepSeek / Kimi / Hunyuan wire rules)', () => {
  it('sends empty string content on tool-call turns, never null, and passbacks reasoning_content', () => {
    const messages = serializeMessages(request([
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'need bash' },
          { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"command":"ls"}' },
        ],
      } as Message,
    ]))
    expect(messages).toEqual([
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'need bash',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'bash', arguments: '{"command":"ls"}' },
        }],
      },
    ])
    expect((messages[0] as { content: unknown }).content).not.toBeNull()
  })

  it('keeps user text and expands tool results as separate role:tool messages', () => {
    const messages = serializeMessages(request([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'ok continue' },
          {
            type: 'tool-result',
            toolCallId: 'call_1',
            content: [{ type: 'text', text: 'file list' }],
          },
        ],
      } as Message,
    ]))
    expect(messages).toEqual([
      { role: 'user', content: 'ok continue' },
      { role: 'tool', tool_call_id: 'call_1', content: 'file list' },
    ])
  })

  it('uses (no output) for empty successful tool results', () => {
    const messages = serializeMessages(request([
      {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'call_1', content: [] }],
      } as Message,
    ]))
    expect(messages).toEqual([{ role: 'tool', tool_call_id: 'call_1', content: '(no output)' }])
  })

  it('omits tools when the request has none', () => {
    const body = serializeRequest(request([]))
    expect(body.tools).toBeUndefined()
    expect(body.stream).toBe(true)
  })
})

describe('agent-loop SSE translate', () => {
  it('does not let empty-string continuation deltas wipe tool name/id', async () => {
    const chunks = await collect([
      JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{ index: 0, id: 'call_1', function: { name: 'bash', arguments: '' } }],
          },
        }],
      }),
      JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{ index: 0, id: '', function: { name: '', arguments: '{"command":"ls"}' } }],
          },
        }],
      }),
      JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{ index: 0, id: null, function: { name: null, arguments: '' } }],
          },
        }],
      }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      DONE,
    ])
    const ended = chunks.find((c) => c.type === 'block-end') as {
      block?: { type?: string; id?: string; name?: string; arguments?: string }
    } | undefined
    expect(ended?.block).toMatchObject({
      type: 'tool-call',
      id: 'call_1',
      name: 'bash',
      arguments: '{"command":"ls"}',
    })
  })

  it('stringifies object-shaped tool arguments', async () => {
    const chunks = await collect([
      JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_1',
              function: { name: 'bash', arguments: { command: 'ls' } },
            }],
          },
        }],
      }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      DONE,
    ])
    const ended = chunks.find((c) => c.type === 'block-end') as { block?: { arguments?: string } } | undefined
    expect(ended?.block?.arguments).toBe('{"command":"ls"}')
  })
})

describe('ask tool names', () => {
  it('CJK display names kebab the ASCII remainder instead of hashing', () => {
    expect(askSlug('Claw Demo 应用')).toBe('claw-demo')
    expect(agentToolName('Claw Demo 应用')).toBe('adp_ask_claw-demo')
    expect(agentToolName('demo')).toBe('adp_ask_demo')
    expect(agentToolName('demo-bot')).toBe('adp_ask_demo-bot')
  })
})

describe('adp_call payload normalize', () => {
  it('drops AgentId on CreateRelease, remaps GetAppSecret AppId, nests ModifyAgent SkillList', () => {
    expect(normalizeCallPayload('CreateRelease', { AppId: 'app-1', AgentId: 'agent-1' })).toEqual({ AppId: 'app-1' })
    expect(normalizeCallPayload('GetAppSecret', { AppId: 'app-1' })).toEqual({ AppBizId: 'app-1' })
    expect(nestAgentFields({
      AppId: 'app-1',
      AgentId: 'agent-1',
      SkillList: [{ SkillId: 's1' }],
    })).toEqual({
      AppId: 'app-1',
      AgentId: 'agent-1',
      Agent: { SkillList: [{ SkillId: 's1' }] },
    })
    expect(normalizeCallPayload('ModifyAgent', {
      AppId: 'app-1',
      AgentId: 'agent-1',
      Instructions: 'hi',
      SkillList: [{ SkillId: 's1' }],
    })).toEqual({
      AppId: 'app-1',
      AgentId: 'agent-1',
      Agent: { Instructions: 'hi', SkillList: [{ SkillId: 's1' }] },
    })
  })
})
