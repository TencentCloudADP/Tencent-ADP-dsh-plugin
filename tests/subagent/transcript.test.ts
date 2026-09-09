import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentDescriptorData } from '@deepseek-ai/dsh-subagent'
import { describe, expect, it } from 'vitest'
import { AdpNativeTranscript } from '../../src/subagent/transcript.ts'

const descriptor: SubagentDescriptorData = {
  version: 2,
  provider: 'adp',
  mode: 'one-shot',
  label: '云南旅行专家',
}

function event(type: string, fields: Record<string, unknown>): string {
  return JSON.stringify({ Type: type, ...fields })
}

describe('AdpNativeTranscript', () => {
  it('writes reasoning, ADP procedures, and the final reply as native DSH events', () => {
    const session = Session.create(SessionId('adp-child'))
    const transcript = new AdpNativeTranscript(session, {
      provider: 'adp',
      model: 'travel-agent',
      maxTraceChars: 10_000,
    })
    transcript.start([{ type: 'text', text: '规划云南五日游' }], descriptor)
    transcript.accept('message.added', event('message.added', {
      Message: { Type: 'thought', MessageId: 'thought-1' },
    }))
    transcript.accept('text.delta', event('text.delta', {
      MessageId: 'thought-1', Text: '先查询天气和景点开放情况。',
    }))
    transcript.accept('thought', event('thought', {
      Procedures: [{
        Index: 1,
        Name: '查询天气',
        ToolName: 'weather_search',
        Type: 'plugin',
        Status: 'success',
        Debugging: { DisplayContent: '昆明晴，18-26℃' },
      }],
    }))
    transcript.accept('message.added', event('message.added', {
      Message: { Type: 'reply', MessageId: 'reply-1' },
    }))
    transcript.accept('text.delta', event('text.delta', {
      MessageId: 'reply-1', Text: '第一天抵达昆明。',
    }))
    transcript.finish({
      output: [{ type: 'text', text: '第一天抵达昆明，随后前往大理。' }],
      stopReason: 'completed',
    })

    expect(session.events.map(item => item.type)).toEqual([
      'turn/start',
      'user/message',
      'subagent/descriptor',
      'step/start',
      'assistant/chunk',
      'assistant/message',
      'tool/call',
      'tool/result',
      'step/end',
      'step/start',
      'assistant/chunk',
      'assistant/message',
      'step/end',
      'turn/end',
    ])
    const call = session.events.find(item => item.type === 'tool/call')
    const result = session.events.find(item => item.type === 'tool/result')
    expect(call?.data).toMatchObject({ name: 'weather_search' })
    expect(result?.type === 'tool/result' && result.data.message.content[0]).toMatchObject({
      type: 'tool-result',
      isError: false,
      content: [{ type: 'text', text: '昆明晴，18-26℃' }],
    })
    expect(session.events.at(-1)?.data).toEqual({ turn: 1, reason: { kind: 'completed' } })
  })

  it('bounds projected trace detail and closes failed turns', () => {
    const session = Session.create(SessionId('bounded-child'))
    const transcript = new AdpNativeTranscript(session, {
      provider: 'adp',
      model: 'agent',
      maxTraceChars: 5,
    })
    transcript.start([{ type: 'text', text: 'task' }], descriptor)
    transcript.accept('message.added', event('message.added', {
      Message: { Type: 'thought', MessageId: 'thought-1' },
    }))
    transcript.accept('text.delta', event('text.delta', {
      MessageId: 'thought-1', Text: '123456789',
    }))
    transcript.finish(
      { output: [], stopReason: 'error' },
      new Error('Message.Contents[0].Text could not be decoded'),
    )

    const chunk = session.events.find(item => item.type === 'assistant/chunk')
    expect(chunk?.type === 'assistant/chunk' && chunk.data.chunk).toEqual({
      type: 'reasoning-delta', index: 0, text: '1234…',
    })
    expect(session.events.at(-1)?.data).toMatchObject({
      reason: {
        kind: 'error',
        error: { message: 'Message.Contents[0].Text could not be decoded' },
      },
    })
  })

  it('maps ADP v2 tool_call message events and text.replace into native tool events', () => {
    const session = Session.create(SessionId('adp-v2-tool-child'))
    const transcript = new AdpNativeTranscript(session, {
      provider: 'adp',
      model: 'travel-agent',
      maxTraceChars: 10_000,
    })
    transcript.start([{ type: 'text', text: '先搜索再规划' }], descriptor)
    transcript.accept('message.processing', event('message.processing', {
      MessageId: 'prc-tool-1',
      Message: {
        Type: 'tool_call',
        MessageId: 'prc-tool-1',
        Name: '联网搜索',
        Title: '工具执行',
        Status: 'processing',
        StatusDesc: '执行中',
        ExtraInfo: {
          ToolName: '工作流/联网搜索',
          ToolInput: '{"query":"云南旅游"}',
        },
      },
    }))
    transcript.accept('text.replace', event('text.replace', {
      MessageId: 'prc-tool-1',
      ContentIndex: 0,
      Text: '{"results":["昆明","大理"]}',
    }))
    transcript.accept('message.done', event('message.done', {
      MessageId: 'prc-tool-1',
      Message: {
        Type: 'tool_call',
        MessageId: 'prc-tool-1',
        Name: '联网搜索',
        Title: '工具执行',
        Status: 'success',
        StatusDesc: '工具执行完成',
        Contents: [{ Type: 'json_text', Text: '{"results":["昆明","大理"]}' }],
        ExtraInfo: { ToolName: '工作流/联网搜索' },
      },
    }))
    transcript.finish({
      output: [{ type: 'text', text: '已完成规划。' }],
      stopReason: 'completed',
    })

    const call = session.events.find(item => item.type === 'tool/call')
    const result = session.events.find(item => item.type === 'tool/result')
    expect(call?.data).toMatchObject({
      name: '工作流/联网搜索',
      arguments: '{"query":"云南旅游"}',
    })
    expect(result?.type === 'tool/result' && result.data.message.content[0]).toMatchObject({
      type: 'tool-result',
      isError: false,
      content: [{ type: 'text', text: '{"results":["昆明","大理"]}' }],
    })
    expect(session.events.filter(item => item.type === 'tool/call')).toHaveLength(1)
    expect(session.events.filter(item => item.type === 'tool/result')).toHaveLength(1)
  })

  it('puts pre-tool reasoning in an earlier native step than post-tool reasoning', () => {
    const session = Session.create(SessionId('adp-v2-step-order-child'))
    const transcript = new AdpNativeTranscript(session, {
      provider: 'adp',
      model: 'travel-agent',
      maxTraceChars: 10_000,
    })
    transcript.start([{ type: 'text', text: '生成行程文件' }], descriptor)
    transcript.accept('message.added', event('message.added', {
      Message: { Type: 'thought', MessageId: 'thought-before' },
    }))
    transcript.accept('text.delta', event('text.delta', {
      MessageId: 'thought-before', Text: '先整理行程，再写入文件。',
    }))
    transcript.accept('message.processing', event('message.processing', {
      Message: {
        Type: 'tool_call',
        MessageId: 'write-call',
        Name: 'write',
        Status: 'processing',
      },
    }))
    transcript.accept('message.done', event('message.done', {
      Message: {
        Type: 'tool_call',
        MessageId: 'write-call',
        Name: 'write',
        Status: 'success',
        Contents: [{ Type: 'text', Text: '文件写入成功' }],
      },
    }))
    transcript.accept('message.added', event('message.added', {
      Message: { Type: 'thought', MessageId: 'thought-after' },
    }))
    transcript.accept('text.delta', event('text.delta', {
      MessageId: 'thought-after', Text: '文件已写入，准备总结。',
    }))
    transcript.finish({
      output: [{ type: 'text', text: '行程已经生成。' }],
      stopReason: 'completed',
    })

    const assistantMessages = session.events.filter(item => item.type === 'assistant/message')
    expect(assistantMessages).toHaveLength(2)
    expect(assistantMessages[0]?.data).toMatchObject({
      turn: 1,
      step: 1,
      message: {
        content: [
          { type: 'reasoning', text: '先整理行程，再写入文件。' },
          { type: 'tool-call', name: 'write' },
        ],
      },
    })
    expect(assistantMessages[1]?.data).toMatchObject({
      turn: 1,
      step: 2,
      message: {
        content: [
          { type: 'reasoning', text: '文件已写入，准备总结。' },
          { type: 'text', text: '行程已经生成。' },
        ],
      },
    })
    expect(session.events.map(item => item.type)).toEqual([
      'turn/start',
      'user/message',
      'subagent/descriptor',
      'step/start',
      'assistant/chunk',
      'assistant/message',
      'tool/call',
      'tool/result',
      'step/end',
      'step/start',
      'assistant/chunk',
      'assistant/message',
      'step/end',
      'turn/end',
    ])
  })

  it('flushes streamed ADP tool output when the stream ends without message.done', () => {
    const session = Session.create(SessionId('adp-v2-tool-flush-child'))
    const transcript = new AdpNativeTranscript(session, {
      provider: 'adp',
      model: 'travel-agent',
      maxTraceChars: 10_000,
    })
    transcript.start([{ type: 'text', text: '调用工具' }], descriptor)
    transcript.accept('message.processing', event('message.processing', {
      Message: {
        Type: 'tool_call',
        MessageId: 'prc-tool-2',
        Name: '生成文档',
        Status: 'processing',
        ExtraInfo: { ToolName: 'document_writer' },
      },
    }))
    transcript.accept('text.delta', event('text.delta', {
      MessageId: 'prc-tool-2', ContentIndex: 0, Text: '创建',
    }))
    transcript.accept('text.delta', event('text.delta', {
      MessageId: 'prc-tool-2', ContentIndex: 0, Text: '完成',
    }))
    transcript.finish({ output: [], stopReason: 'completed' })

    const result = session.events.find(item => item.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.message.content[0]).toMatchObject({
      isError: false,
      content: [{ type: 'text', text: '创建完成' }],
    })
  })
})
