import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { apply, canonicalRequest, fetchLoginUrl, hostForVendor, chatUrlForVendor, pluginBaseForVendor, accountHostForVendor, parseSiteVendor, siteVendorFromConfig, isCloudAksk, readBody, unwrapAccountPayload } from '../../src/index.ts'
import {
  handleLoginUrl,
  PROXY_ICON_PATH,
  PROXY_LOGIN_URL_PATH,
  registerAdpWebRoutes,
} from '../../src/account.ts'
import { handleSite, PROXY_SITE_PATH } from '../../src/site.ts'
import { parseLoginUrlBody, readLoginUrlResponse } from '../../src/client/loginUrl.ts'
import { parseSiteBody } from '../../src/client/site.ts'
import { presentAdpSearchResult } from '../../src/web/index.ts'
import { assemble } from '../../src/agents/chat.ts'
import { secretFromApp } from '../../src/agents/provision.ts'
import { isExternallyCallable, normalizePluginDetail } from '../../src/core/service.ts'
import { normalizeModelList } from '../../src/core/models.ts'
import { McpSession } from '../../src/plugins/mcp.ts'
import { loadFixture, startMockAdp, type MockAdpServer } from '../mock/http.ts'
import { bootAdp, toolCall } from '../mock/harness.ts'
import { readFileSync } from 'node:fs'

const secrets = { secretId: 'AKIDxxxxxxxxxxxxxxxxxxxxxxxxxxxx', secretKey: 'control-secret' }

describe('sim-sign', () => {
  it('canonical string changes with host/vendor at a pinned timestamp', () => {
    const payload = '{"PageNumber":0}'
    const adp = canonicalRequest({ payload, host: 'capi.adp.tencent.com', action: 'DescribePluginSummaryList' })
    const cloud = canonicalRequest({ payload, host: 'adp.tencentcloudapi.com', action: 'DescribePluginSummaryList' })
    expect(adp).toContain('host:capi.adp.tencent.com')
    expect(cloud).toContain('host:adp.tencentcloudapi.com')
    expect(adp).not.toBe(cloud)
    expect(isCloudAksk('AKIDabc')).toBe(true)
    expect(hostForVendor(undefined, 'AKIDabc')).toBe('adp.tencentcloudapi.com')
    expect(hostForVendor('ChinaTencentADP', 'AKIDabc')).toBe('capi.adp.tencent.com')
    expect(hostForVendor(undefined, 'short-adp-key')).toBe('capi.adp.tencent.com')
    expect(chatUrlForVendor('ChinaTencentADP')).toBe('https://adp.tencent.com/adp/v2/chat')
    expect(chatUrlForVendor('ChinaTencentCloud')).toBe('https://wss.lke.cloud.tencent.com/adp/v2/chat')
    expect(pluginBaseForVendor('ChinaTencentADP')).toBe('https://adp.tencent.com')
    expect(pluginBaseForVendor('ChinaTencentCloud')).toBe('https://adp.cloud.tencent.com')
    expect(accountHostForVendor('ChinaTencentADP')).toBe('https://adp.tencent.com')
    expect(accountHostForVendor('ChinaTencentCloud')).toBe('https://adp.cloud.tencent.com')
    expect(parseSiteVendor('ChinaTencentADP')).toBe('ChinaTencentADP')
    expect(parseSiteVendor('nope')).toBeUndefined()
    expect(siteVendorFromConfig('International')).toBe('ChinaTencentADP')
  })
})

describe('account envelope', () => {
  it('accepts lowercase reqId/code/data (fixture account/lowercase.json)', () => {
    const raw = JSON.parse(readFileSync(new URL('../fixtures/account/lowercase.json', import.meta.url), 'utf8')) as unknown
    expect(unwrapAccountPayload(raw).Name).toBe('alice')
  })

  it('unwraps login_url from the account envelope (fixture account/login-url.json)', () => {
    const raw = JSON.parse(readFileSync(new URL('../fixtures/account/login-url.json', import.meta.url), 'utf8')) as unknown
    expect(unwrapAccountPayload(raw).login_url).toBe('https://example.test/oneid/authorize?x=1')
  })
})

describe('plugin body SSE', () => {
  it('takes the last cumulative frame, not a concat (fixture plugin/api-cumulative.sse)', () => {
    const body = readBody(loadFixture('plugin/api-cumulative.sse')) as { Data: { Answer: string } }
    expect(body.Data.Answer).toBe('先写一半再写完')
    expect(body.Data.Answer.includes('先写一半先写一半')).toBe(false)
  })
})

describe('plugin filter', () => {
  it('trusts DescribePlugin URLs, not list AllowExternalAccess', () => {
    const usable = JSON.parse(loadFixture('control/plugin-detail-usable.json')).Response as Record<string, unknown>
    const none = JSON.parse(loadFixture('control/plugin-detail-no-url.json')).Response as Record<string, unknown>
    const header = JSON.parse(loadFixture('control/plugin-detail-empty-header.json')).Response as Record<string, unknown>
    expect(isExternallyCallable(normalizePluginDetail('x', usable))).toBe(true)
    expect(isExternallyCallable(normalizePluginDetail('x', none))).toBe(false)
    expect(isExternallyCallable(normalizePluginDetail('x', header))).toBe(false)
  })
})

describe('chat assembler', () => {
  it('returns only reply when thought and reply interleave', () => {
    const lines = loadFixture('chat/thought-reply.sse').split('\n')
    const reply = assemble('c1', lines)
    expect(reply.answer).toBe('Hello world')
    expect(reply.thought).toBe('thinking...')
    expect(reply.answer.includes('thinking')).toBe(false)
  })
})

describe('appkey field mask', () => {
  it('SecretInfo is empty without FieldMask and present with it', () => {
    const no = JSON.parse(loadFixture('control/describe-app-no-mask.json')).Response as Record<string, unknown>
    const yes = JSON.parse(loadFixture('control/describe-app-with-mask.json')).Response as Record<string, unknown>
    expect(secretFromApp(no)).toBeUndefined()
    expect(secretFromApp(yes)).toBe('appkey-from-fieldmask')
  })
})

describe('live HTTP sims', () => {
  let mock: MockAdpServer | undefined
  afterEach(async () => {
    await mock?.close()
    mock = undefined
  })

  it('sim-cred-missing: route stays, call is MISSING_CREDENTIAL', async () => {
    mock = await startMockAdp()
    const { ctx } = await bootAdp({ mock, keys: { secretId: secrets.secretId, secretKey: secrets.secretKey } })
    expect(ctx.llm.listProviders().some((p) => p.id === 'adp')).toBe(true)
    const chunks: Array<{ type: string; reason?: { kind?: string; failure?: { code?: string } } }> = []
    for await (const chunk of ctx.llm.stream({
      provider: 'adp',
      model: 'Hunyuan/hy3',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
    })) {
      chunks.push(chunk)
    }
    const finish = chunks.find((c) => c.type === 'finish')
    expect(finish?.reason?.kind).toBe('error')
    expect(finish?.reason?.failure?.code).toBe('MISSING_CREDENTIAL')
  })

  it('sim-cred-bad: INVALID_CREDENTIAL and the key is not in the error', async () => {
    mock = await startMockAdp()
    const { ctx, creds } = await bootAdp({
      mock,
      keys: { gateway: 'sk-bad', secretId: secrets.secretId, secretKey: secrets.secretKey },
    })
    const chunks: Array<{ type: string; reason?: { failure?: { code?: string; message?: string } } }> = []
    for await (const chunk of ctx.llm.stream({
      provider: 'adp',
      model: 'Hunyuan/hy3',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
    })) {
      chunks.push(chunk)
    }
    const finish = chunks.find((c) => c.type === 'finish')
    expect(finish?.reason?.failure?.code).toBe('INVALID_CREDENTIAL')
    expect(JSON.stringify(chunks).includes('sk-bad')).toBe(false)
    await creds.set(creds.store.keys().next().value as never, 'sk-bad\nnewline')
  })

  it('sim-llm-sse: usage before finish; tool-call arguments stay a string', async () => {
    mock = await startMockAdp()
    const { ctx } = await bootAdp({
      mock,
      keys: { gateway: 'sk-good', secretId: secrets.secretId, secretKey: secrets.secretKey },
    })
    const chunks: Array<{ type: string; usage?: unknown; block?: { arguments?: unknown } }> = []
    for await (const chunk of ctx.llm.stream({
      provider: 'adp',
      model: 'Hunyuan/hy3',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
    })) {
      chunks.push(chunk)
    }
    const types = chunks.map((c) => c.type)
    expect(types.indexOf('usage')).toBeGreaterThan(-1)
    expect(types.indexOf('usage')).toBeLessThan(types.indexOf('finish'))
    expect(types.at(-1)).toBe('finish')
    const ended = chunks.find((c) => c.type === 'block-end' && c.block && 'arguments' in (c.block as object))
    expect(typeof (ended?.block as { arguments: string }).arguments).toBe('string')
    expect((ended?.block as { arguments: string }).arguments).toBe('{"query":"图片"}')
  })

  it('sim-web-sse: last-frame Answer and web/search presentResult', async () => {
    mock = await startMockAdp()
    const { ctx } = await bootAdp({
      mock,
      keys: { gateway: 'sk-good', secretId: secrets.secretId, secretKey: secrets.secretKey },
    })
    const result = await ctx.web.search({ query: '混元' })
    expect(result.content).toBe('部分答案全文')
    const view = presentAdpSearchResult(
      { query: '混元' },
      { content: [], isError: false, meta: { sources: result.sources, truncated: false, answer: result.content } },
    )
    expect(view?.card).toBe('web')
    expect(view?.kind).toBe('search')
  })

  it('sim-plugin-list: PageNumber is 0-based and page 2 is not dropped', async () => {
    mock = await startMockAdp()
    const { ctx } = await bootAdp({
      mock,
      keys: { secretId: secrets.secretId, secretKey: secrets.secretKey },
    })
    const summaries = await ctx.adp.listPluginSummaries()
    expect(summaries.map((s) => s.PluginId)).toEqual([
      'plugin-usable-listed-false',
      'plugin-no-url',
      'plugin-empty-header',
    ])
    const pages = mock.calls.filter((c) => c.action === 'DescribePluginSummaryList').map((c) => JSON.parse(c.body) as { PageNumber: number })
    expect(pages[0]?.PageNumber).toBe(0)
    expect(pages[1]?.PageNumber).toBe(1)
  })

  it('sim-plugin-filter: list false + detail URL kept; no URL / empty header dropped', async () => {
    mock = await startMockAdp()
    const { ctx } = await bootAdp({
      mock,
      keys: { secretId: secrets.secretId, secretKey: secrets.secretKey },
    })
    const usable = await ctx.adp.usablePlugins()
    expect(usable.map((p) => p.pluginId)).toEqual(['plugin-usable-listed-false'])
  })

  it('sim-plugin-api-sse: canonical value is the last frame', async () => {
    mock = await startMockAdp()
    const { ctx } = await bootAdp({
      mock,
      keys: { gateway: 'sk-good', secretId: secrets.secretId, secretKey: secrets.secretKey },
    })
    const body = await ctx.adp.pluginFetch(`${mock.origin}/plugin/api/v1/plugin-api/tool-api`, { Query: 'x' })
    expect((body as { Data: { Answer: string } }).Data.Answer).toBe('先写一半再写完')
  })

  it('sim-plugin-mcp-405: wrong transport is explicit and not retried as the other', async () => {
    mock = await startMockAdp()
    const session = new McpSession(`${mock.origin}/mcp/sse`, 'streamable-http', async () => 'sk-good')
    await expect(session.listTools()).rejects.toMatchObject({ code: 'MCP_TRANSPORT_405' })
    const posts = mock.calls.filter((c) => c.url.startsWith('/mcp/sse'))
    expect(posts.length).toBe(1)
  })

  it('sim-media: saved_files land on disk', async () => {
    mock = await startMockAdp()
    const dir = await mkdtemp(join(tmpdir(), 'adp-dsh-'))
    const { ctx } = await bootAdp({
      mock,
      workspaceDir: dir,
      keys: { gateway: 'sk-good', secretId: secrets.secretId, secretKey: secrets.secretKey },
    })
    const harvested = await ctx.adp.harvest({ url: `${mock.origin}/cos/demo.png` }) as { saved_files?: string[] }
    expect(harvested.saved_files?.[0]).toBeTruthy()
    const info = await stat(join(dir, harvested.saved_files![0]!))
    expect(info.size).toBeGreaterThan(0)
    const bytes = await readFile(join(dir, harvested.saved_files![0]!))
    expect(bytes[0]).toBe(0x89)
  })

  it('sim-provision: CreateApp→Agent→Release then FieldMask AppKey', async () => {
    mock = await startMockAdp()
    const { ctx } = await bootAdp({
      mock,
      keys: { gateway: 'sk-good', secretId: secrets.secretId, secretKey: secrets.secretKey },
    })
    const result = await ctx.tools.execute(toolCall('adp_provision_agent', { name: 'demo-bot', instructions: 'be helpful' }))
    expect(result.isError).toBeFalsy()
    const value = (result as { value: { kind: string; appKeyRef?: string; askTool?: string } }).value
    expect(value.kind).toBe('ready')
    expect(value.appKeyRef).toBeTruthy()
    const actions = mock.calls.map((c) => c.action).filter(Boolean)
    expect(actions).toContain('CreateApp')
    expect(actions).toContain('CreateAgent')
    expect(actions).toContain('CreateRelease')
    expect(actions).toContain('DescribeReleaseSummary')
    const releasePoll = mock.calls.find((c) => c.action === 'DescribeReleaseSummary')
    expect(releasePoll).toBeTruthy()
    const pollBody = JSON.parse(releasePoll!.body) as { AppId?: string; ReleaseId?: string }
    expect(pollBody.AppId).toBe('app-1')
    expect(pollBody.ReleaseId).toBe('rel-1')
    const describe = mock.calls.filter((c) => c.action === 'DescribeApp').map((c) => JSON.parse(c.body) as { FieldMask?: { Paths?: string[] } })
    expect(describe.some((b) => b.FieldMask?.Paths?.includes('SecretInfo'))).toBe(true)
    const createAgent = mock.calls.find((c) => c.action === 'CreateAgent')
    expect(createAgent).toBeTruthy()
    const agentBody = JSON.parse(createAgent!.body) as { Name?: string; Agent?: { Profile?: { Name?: string }; Model?: { ModelId?: string } } }
    expect(agentBody.Name).toBeUndefined()
    expect(agentBody.Agent?.Profile?.Name).toBe('demo-bot')
    expect(agentBody.Agent?.Model?.ModelId).toBeTruthy()
  })

  it('sim-spaceid-scope: cloud AKSK fills SpaceId on lists, not DescribeApp', async () => {
    mock = await startMockAdp()
    const { ctx } = await bootAdp({
      mock,
      keys: { secretId: secrets.secretId, secretKey: secrets.secretKey },
    })
    await ctx.adp.call('DescribeApp', { AppId: 'app-1', FieldMask: { Paths: ['SecretInfo'] } })
    const describe = JSON.parse(mock.calls.find((c) => c.action === 'DescribeApp')!.body) as { SpaceId?: string }
    expect(describe.SpaceId).toBeUndefined()
    await ctx.adp.call('DescribeAppSummaryList', { PageNumber: 0, PageSize: 10 })
    const listed = JSON.parse(mock.calls.find((c) => c.action === 'DescribeAppSummaryList')!.body) as { SpaceId?: string }
    expect(listed.SpaceId).toBe('default_space')
    await ctx.adp.call('DescribeAgentSummaryList', { AppId: 'app-1' })
    const agents = JSON.parse(mock.calls.find((c) => c.action === 'DescribeAgentSummaryList')!.body) as { SpaceId?: string }
    expect(agents.SpaceId).toBeUndefined()
  })

  it('sim-adp-call-json-string: stringified payload is parsed, not dropped', async () => {
    mock = await startMockAdp()
    const { ctx } = await bootAdp({
      mock,
      keys: { secretId: secrets.secretId, secretKey: secrets.secretKey },
    })
    const result = await ctx.tools.execute(toolCall('adp_call', {
      action: 'DescribeApp',
      payload: '{"AppId":"app-1","FieldMask":{"Paths":["SecretInfo"]}}',
    }))
    expect(result.isError).toBeFalsy()
    const body = JSON.parse(mock.calls.find((c) => c.action === 'DescribeApp')!.body) as {
      AppId?: string
      FieldMask?: { Paths?: string[] }
    }
    expect(body.AppId).toBe('app-1')
    expect(body.FieldMask?.Paths).toEqual(['SecretInfo'])
    const bad = await ctx.tools.execute(toolCall('adp_call', {
      action: 'DescribeApp',
      payload: '{not-json',
    }))
    expect(bad.isError).toBe(true)
  })

  it('sim-appkey-mask / sim-appkey-absent', async () => {
    mock = await startMockAdp()
    const { ctx } = await bootAdp({
      mock,
      keys: { secretId: secrets.secretId, secretKey: secrets.secretKey },
    })
    const masked = await ctx.adp.call('DescribeApp', { AppId: 'app-1', FieldMask: { Paths: ['SecretInfo'] } })
    expect(secretFromApp(masked)).toBe('appkey-from-fieldmask')
    mock.describeAppWithMask = false
    const bare = await ctx.adp.call('DescribeApp', { AppId: 'app-1' })
    expect(secretFromApp(bare)).toBeUndefined()
    mock.describeAppWithMask = false
    const result = await ctx.tools.execute(toolCall('adp_provision_agent', { name: 'no-key', instructions: 'x' }))
    const value = (result as { value: { kind: string; message?: string } }).value
    expect(value.kind).toBe('needs_appkey')
    expect(value.message?.toLowerCase()).toContain('appkey')
    expect(ctx.tools.get('adp_ask_no-key')).toBeUndefined()
  })

  it('sim-ask-sse: only reply is the answer', async () => {
    mock = await startMockAdp()
    const { ctx } = await bootAdp({
      mock,
      keys: { gateway: 'sk-good', secretId: secrets.secretId, secretKey: secrets.secretKey, appKey: 'app-key-1' },
    })
    const result = await ctx.tools.execute(toolCall('adp_ask_demo', { question: 'hello' }))
    expect((result as { value: { answer: string } }).value.answer).toBe('Hello world')
    expect(JSON.stringify(result)).not.toContain('thinking')
  })

  it('sim-ask-file: claw file lands in workspace', async () => {
    mock = await startMockAdp()
    const dir = await mkdtemp(join(tmpdir(), 'adp-dsh-'))
    const { ctx } = await bootAdp({
      mock,
      workspaceDir: dir,
      keys: { gateway: 'sk-good', secretId: secrets.secretId, secretKey: secrets.secretKey, appKey: 'app-key-1' },
    })
    const result = await ctx.tools.execute(toolCall('adp_ask_demo', { question: 'file-please' }))
    const saved = (result as { value: { saved_files?: string[] } }).value.saved_files
    expect(saved?.[0]).toBeTruthy()
    expect((await stat(join(dir, saved![0]!))).size).toBeGreaterThan(0)
  })

  it('sim-mutating-gate: DeleteApp does not hit the control plane when unapproved', async () => {
    mock = await startMockAdp()
    const { ctx } = await bootAdp({
      mock,
      keys: { secretId: secrets.secretId, secretKey: secrets.secretKey },
    })
    const result = await ctx.tools.execute(toolCall('adp_call', { action: 'DeleteApp', payload: { AppId: 'app-1' } }))
    expect(result.isError).toBe(true)
    expect(mock.calls.some((c) => c.action === 'DeleteApp')).toBe(false)
  })

  it('sim-skill-empty-url / sim-skill-md', async () => {
    mock = await startMockAdp()
    const { ctx } = await bootAdp({
      mock,
      keys: { secretId: secrets.secretId, secretKey: secrets.secretKey },
    })
    const listed = await ctx.skills.list({ cwd: process.cwd() })
    const names = listed.map((s) => s.name)
    expect(names).toContain('hello-docs')
    expect(names).toContain('empty-url')
    const md = listed.find((s) => s.name === 'hello-docs')!
    const empty = listed.find((s) => s.name === 'empty-url')!
    const got = await ctx.skills.get(md.name, { cwd: process.cwd() })
    expect(got?.content).toContain('Hello Skill')
    const missing = await ctx.skills.get(empty.name, { cwd: process.cwd() })
    expect(missing).toBeUndefined()
  })
})

describe('account login-url', () => {
  let mock: MockAdpServer | undefined
  afterEach(async () => {
    await mock?.close()
    mock = undefined
  })

  it('fetchLoginUrl posts oneid and unwraps login_url against the mock', async () => {
    mock = await startMockAdp()
    const result = await fetchLoginUrl({ host: mock.origin })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.login_url).toBe('https://example.test/oneid/authorize?x=1')
    expect(result.landing_host).toBe(mock.origin)
    expect(result.cookie_name).toBe('adp_iam_token')
    const call = mock.calls.find((entry) => entry.url.startsWith('/account/login-url'))
    expect(call?.method).toBe('POST')
    expect(JSON.parse(call?.body || '{}')).toEqual({ login_platform: 'oneid' })
  })

  it('proxy handler returns JSON for GET and POST', async () => {
    const payload = JSON.parse(loadFixture('account/login-url.json')) as unknown
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/account/login-url')) {
        expect(init?.method).toBe('POST')
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return originalFetch(input, init)
    }) as typeof fetch
    try {
      for (const method of ['GET', 'POST'] as const) {
        const captured = collectResponse()
        await handleLoginUrl({ method } as IncomingMessage, captured.node)
        expect(captured.status).toBe(200)
        expect(captured.headers['content-type']).toContain('application/json')
        const parsed = JSON.parse(captured.body) as { ok: boolean; login_url: string }
        expect(parsed.ok).toBe(true)
        expect(parsed.login_url).toBe('https://example.test/oneid/authorize?x=1')
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('proxy handler returns JSON 405 for other methods', async () => {
    const captured = collectResponse()
    await handleLoginUrl({ method: 'PUT' } as IncomingMessage, captured.node)
    expect(captured.status).toBe(405)
    expect(JSON.parse(captured.body)).toEqual({ ok: false, error: 'Method PUT is not allowed.' })
  })

  it('registerAdpWebRoutes claims the exact login-url path', () => {
    const routes: Array<{ kind: string; path: string }> = []
    const ctx = {
      get: (name: string) => name === 'webServer'
        ? {
            register: (route: { kind: string; path: string }) => {
              routes.push(route)
              return () => undefined
            },
          }
        : undefined,
      effect: (fn: () => unknown) => fn(),
    }
    registerAdpWebRoutes(ctx as never)
    expect(routes).toEqual([
      expect.objectContaining({ kind: 'exact', path: PROXY_LOGIN_URL_PATH }),
      expect.objectContaining({ kind: 'exact', path: PROXY_ICON_PATH }),
      expect.objectContaining({ kind: 'exact', path: PROXY_SITE_PATH }),
    ])
  })
})

describe('adp site proxy', () => {
  function fakeCtx(initial: 'ChinaTencentADP' | 'ChinaTencentCloud' = 'ChinaTencentADP') {
    let vendor = initial
    let spaceId = 'default_space'
    return {
      get(name: string) {
        if (name === 'adp') {
          return {
            vendor: () => vendor,
            spaceId: () => spaceId,
            setLiveVendor: (next: typeof vendor | undefined) => {
              if (next) vendor = next
            },
            setLiveSpaceId: (next: string | undefined) => {
              if (next?.trim()) spaceId = next.trim()
            },
            listSpaces: async () => [] as Array<{ id: string; name: string }>,
          }
        }
        return undefined
      },
    }
  }

  function postReq(body: string): IncomingMessage {
    const stream = Readable.from([Buffer.from(body)]) as IncomingMessage
    stream.method = 'POST'
    return stream
  }

  it('GET returns the current vendor', async () => {
    const captured = collectResponse()
    await handleSite({ method: 'GET' } as IncomingMessage, captured.node, fakeCtx() as never)
    expect(captured.status).toBe(200)
    expect(JSON.parse(captured.body)).toEqual({
      ok: true,
      vendor: 'ChinaTencentADP',
      spaceId: 'default_space',
      spaces: [],
    })
    expect(parseSiteBody(200, captured.body)).toEqual({
      ok: true,
      vendor: 'ChinaTencentADP',
      spaceId: 'default_space',
      spaces: [],
    })
  })

  it('POST switches to public cloud without settings', async () => {
    const ctx = fakeCtx()
    const captured = collectResponse()
    await handleSite(postReq(JSON.stringify({ vendor: 'ChinaTencentCloud' })), captured.node, ctx as never)
    expect(captured.status).toBe(200)
    expect(JSON.parse(captured.body)).toEqual({
      ok: true,
      vendor: 'ChinaTencentCloud',
      spaceId: 'default_space',
      spaces: [],
    })
    expect(ctx.get('adp').vendor()).toBe('ChinaTencentCloud')
  })

  it('POST persists a real spaceId', async () => {
    const ctx = fakeCtx()
    const captured = collectResponse()
    await handleSite(postReq(JSON.stringify({ spaceId: 'workspace_one' })), captured.node, ctx as never)
    expect(captured.status).toBe(200)
    expect(JSON.parse(captured.body)).toEqual({
      ok: true,
      vendor: 'ChinaTencentADP',
      spaceId: 'workspace_one',
      spaces: [],
    })
    expect(ctx.get('adp').spaceId()).toBe('workspace_one')
  })

  it('POST rejects an unknown vendor', async () => {
    const captured = collectResponse()
    await handleSite(postReq(JSON.stringify({ vendor: 'International' })), captured.node, fakeCtx() as never)
    expect(captured.status).toBe(400)
  })

  it('POST returns JSON when settings.update throws', async () => {
    const ctx = {
      get(name: string) {
        if (name === 'adp') {
          return {
            vendor: () => 'ChinaTencentADP',
            spaceId: () => 'default_space',
            setLiveVendor: () => undefined,
            setLiveSpaceId: () => undefined,
            listSpaces: async () => [],
          }
        }
        if (name === 'settings') {
          return {
            update: async () => {
              throw new Error('settings namespace "adp-core" is not registered')
            },
          }
        }
        return undefined
      },
    }
    const captured = collectResponse()
    await handleSite(postReq(JSON.stringify({ vendor: 'ChinaTencentCloud' })), captured.node, ctx as never)
    expect(captured.status).toBe(500)
    expect(JSON.parse(captured.body)).toEqual({
      ok: false,
      error: 'settings namespace "adp-core" is not registered',
    })
  })

  it('returns JSON 405 for other methods', async () => {
    const captured = collectResponse()
    await handleSite({ method: 'PUT' } as IncomingMessage, captured.node, fakeCtx() as never)
    expect(captured.status).toBe(405)
    expect(parseSiteBody(405, captured.body)).toEqual({
      ok: false,
      error: 'Method PUT is not allowed.',
    })
  })

  it('client parse surfaces empty site bodies', () => {
    expect(parseSiteBody(405, '')).toEqual({
      ok: false,
      error: 'Site proxy returned HTTP 405 with an empty body.',
    })
  })
})

describe('normalizeModelList', () => {
  it('reads flat ModelId rows', () => {
    const models = normalizeModelList(JSON.parse(loadFixture('control/model-list.json')).Response)
    expect(models.map((model) => model.id)).toEqual(['Hunyuan/hy3', 'Deepseek/deepseek-v4-pro'])
  })

  it('unwraps public-cloud ModelBasic.ModelId', () => {
    const models = normalizeModelList({
      ModelList: [
        { ModelBasic: { ModelId: 'Hunyuan/hy3', ModelName: '混元', ContextWindow: 256000 } },
        { ModelBasic: { ModelId: 'Deepseek/deepseek-v4-flash' } },
        { ModelBasic: {} },
      ],
    })
    expect(models).toEqual([
      { id: 'Hunyuan/hy3', name: '混元', contextWindow: 256000 },
      { id: 'Deepseek/deepseek-v4-flash', name: 'Deepseek/deepseek-v4-flash' },
    ])
  })

  it('reads independent-site ListModel ModelName when ModelId is absent', () => {
    const models = normalizeModelList({
      List: [{ ModelName: 'Auto/auto', AliasName: 'Auto', MaxTokens: { Default: 4096 } }],
    })
    expect(models[0]).toMatchObject({ id: 'Auto/auto', name: 'Auto/auto' })
  })
})

describe('sim-site-settings', () => {
  it('waits for settings and adp before installing the site section', () => {
    const injected: string[][] = []
    apply({
      plugin() {
        return undefined
      },
      inject(deps: string[]) {
        injected.push(deps)
      },
    } as never, {})
    expect(injected).toContainEqual(['settings', 'adp'])
    expect(injected).not.toContainEqual(['settings'])
  })
})

describe('account login-url client parse', () => {
  it('surfaces empty and non-JSON bodies instead of throwing', async () => {
    expect(parseLoginUrlBody(405, '')).toEqual({
      ok: false,
      error: 'Login proxy returned HTTP 405 with an empty body.',
    })
    expect(parseLoginUrlBody(200, '<!doctype html>')).toEqual({
      ok: false,
      error: 'Login proxy returned HTTP 200 with non-JSON content.',
    })
    const empty = await readLoginUrlResponse(new Response('', { status: 405 }))
    expect(empty).toEqual({
      ok: false,
      error: 'Login proxy returned HTTP 405 with an empty body.',
    })
    const ok = parseLoginUrlBody(200, JSON.stringify({
      ok: true,
      login_url: 'https://example.test/oneid/authorize?x=1',
    }))
    expect(ok).toEqual({
      ok: true,
      login_url: 'https://example.test/oneid/authorize?x=1',
    })
  })
})

function collectResponse() {
  const headers: Record<string, string> = {}
  let body = ''
  const node = {
    statusCode: 0,
    setHeader(name: string, value: string | number | readonly string[]) {
      headers[name.toLowerCase()] = String(value)
    },
    end(chunk?: unknown) {
      body = chunk == null ? '' : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    },
  }
  return {
    node: node as unknown as ServerResponse,
    headers,
    get body() {
      return body
    },
    get status() {
      return node.statusCode
    },
  }
}
