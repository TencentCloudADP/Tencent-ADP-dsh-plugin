import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox, type Agent, type AgentFactory } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { afterEach, describe, expect, it } from 'vitest'
import * as adp from '../../src/subagent/index.ts'

const ENV_NAME = 'TENCENT_ADP_APP_KEY'
const previousKey = process.env[ENV_NAME]

class AdpCoreStub extends Service {
  constructor(ctx: Context, private readonly endpoint: string) {
    super(ctx, 'adp')
  }

  chatUrl(): string {
    return this.endpoint
  }
}

afterEach(() => {
  if (previousKey === undefined) delete process.env[ENV_NAME]
  else process.env[ENV_NAME] = previousKey
})

describe('ADP provider over real HTTP streaming', () => {
  it('runs through ctx.subagents and a chunked SSE server', async () => {
    let posted: Record<string, unknown> | undefined
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => { chunks.push(Buffer.from(chunk)) })
      request.on('end', () => {
        posted = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
        })
        response.write('event: message.added\ndata: {"Type":"message.added","Message":{"Type":"reply","MessageId":"reply-1"}}\n\n')
        response.write('event: text.delta\ndata: {"Type":"text.delta","MessageId":"reply-1","Text":"chunked "}\n\n')
        setImmediate(() => {
          response.write('event: text.delta\ndata: {"Type":"text.delta","MessageId":"reply-1","Text":"answer"}\n\n')
          response.write('event: response.completed\ndata: {"Type":"response.completed","Response":{"Status":"success","Messages":[{"Type":"reply","MessageId":"reply-1","Contents":[{"Type":"text","Text":"chunked answer"}]}]}}\n\n')
          response.end('event: done\ndata: [DONE]\n\n')
        })
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo

    process.env[ENV_NAME] = 'local-test-key'
    const ctx = new Context()
    try {
      await ctx.plugin(AgentRegistry)
      const factory: AgentFactory = {
        async createAgent(ownerCtx, options) {
          const session = Session.create(options.sessionId, options.seed, {
            version: 0,
            id: options.sessionId,
            createdAt: Date.now(),
            ...options.meta,
          })
          const child: Agent = {
            id: options.sessionId,
            session,
            options: options.agentOptions ?? {},
            inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
            status: 'idle',
            ctx: ownerCtx,
            send: () => {},
            followup: () => {},
            steer: () => {},
            inject: () => {},
            cancel: () => {},
            runMaintenance: task => task(new AbortController().signal),
            whenIdle: async () => {},
          }
          const detach = ownerCtx.agents.enter(child, ownerCtx.agent)
          ownerCtx.agents.announce(child)
          return { agent: child, async dispose() { detach() } }
        },
        async resume() {
          throw new Error('not used in this test')
        },
      }
      ctx.agents.setFactory(factory)
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(AdpCoreStub, `http://127.0.0.1:${address.port}/adp/v2/chat`)
      await ctx.plugin(adp, {
        visitorId: 'e2e-visitor',
      })
      const parentSession = Session.create(SessionId('parent-session'))
      const parent: Agent = {
        id: parentSession.id,
        session: parentSession,
        options: {},
        inbox: new Inbox(parentSession, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
        status: 'idle',
        ctx,
        send: () => {},
        followup: () => {},
        steer: () => {},
        inject: () => {},
        cancel: () => {},
        runMaintenance: task => task(new AbortController().signal),
        whenIdle: async () => {},
      }
      const run = await ctx.subagents.start('adp', {
        prompt: [{ type: 'text', text: 'execute through HTTP' }],
        parent,
        signal: new AbortController().signal,
      })
      expect(await run.result).toEqual({
        output: [{ type: 'text', text: 'chunked answer' }],
        stopReason: 'completed',
      })
      expect(run.localAgent).toBeDefined()
      expect(run.localAgent?.id).toBe(run.id)
      expect(run.localAgent?.session.header).toMatchObject({
        parentSession: parent.session.id,
        origin: 'subagent',
        delegationDepth: 1,
      })
      expect(run.localAgent?.session.events.map(event => event.type)).toEqual([
        'turn/start',
        'user/message',
        'subagent/descriptor',
        'step/start',
        'assistant/chunk',
        'assistant/chunk',
        'assistant/message',
        'step/end',
        'turn/end',
      ])
      await run.dispose()
      expect(posted).toMatchObject({
        AppKey: 'local-test-key',
        VisitorId: 'e2e-visitor',
        Contents: [{ Type: 'text', Text: 'execute through HTTP' }],
      })
    } finally {
      await ctx.fiber.dispose()
      await new Promise<void>((resolve, reject) => {
        server.close(error => { error === undefined ? resolve() : reject(error) })
      })
    }
  })
})
