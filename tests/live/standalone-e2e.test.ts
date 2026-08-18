import './env.ts'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import WebRuntime from '@deepseek-ai/dsh-web'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as adpCore from '../../src/index.ts'
import * as llmAdp from '../../src/llm/index.ts'
import * as webAdp from '../../src/web/index.ts'
import * as pluginsAdp from '../../src/plugins/index.ts'
import * as skillsAdp from '../../src/skills/index.ts'
import * as controlAdp from '../../src/control/index.ts'
import {
  HOST_ADP,
  PLUGIN_API_BASE_STANDALONE,
  SSE_URL_STANDALONE,
  accountHostForVendor,
  hunyuanSearchUrl,
} from '../../src/core/hosts.ts'
import { MemoryCredentials } from '../mock/harness.ts'
import { normalizeModelList } from '../../src/core/models.ts'

const required = ['ADP_API_KEY', 'ADP_SECRET_ID', 'ADP_SECRET_KEY'] as const
const keys = {
  gateway: process.env.ADP_API_KEY?.trim() ?? '',
  secretId: process.env.ADP_SECRET_ID?.trim() ?? '',
  secretKey: process.env.ADP_SECRET_KEY?.trim() ?? '',
}
const missing = required.filter((name) => !process.env[name]?.trim())
const isStandaloneKey = keys.secretId.length > 0 && !keys.secretId.toUpperCase().startsWith('AKID')

class SystemPromptStub extends Service {
  constructor(ctx: Context) {
    super(ctx, 'systemPrompt')
  }
  section(): () => void {
    return () => undefined
  }
  context(): () => void {
    return () => undefined
  }
  tools(): () => void {
    return () => undefined
  }
  variable(): () => void {
    return () => undefined
  }
}

describe.skipIf(missing.length > 0 || !isStandaloneKey)('independent-site e2e', () => {
  let ctx: Context
  let workspaceDir: string

  beforeAll(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'adp-standalone-e2e-'))
    ctx = new Context()
    await ctx.plugin(Loader)
    await ctx.plugin(MemoryCredentials)
    await ctx.plugin(SystemPromptStub)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(WebRuntime, { searchProvider: 'adp' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SkillRegistry)

    const creds = ctx.credentials as MemoryCredentials
    await creds.set(credentialRef('ADP_API_KEY'), keys.gateway)
    await creds.set(credentialRef('ADP_SECRET_ID'), keys.secretId)
    await creds.set(credentialRef('ADP_SECRET_KEY'), keys.secretKey)

    await ctx.plugin(adpCore, {
      vendor: 'ChinaTencentADP',
      workspaceDir,
    })
    await ctx.plugin(llmAdp)
    await ctx.plugin(webAdp)
    await ctx.plugin(pluginsAdp, { enabledPluginIds: [], harvestMedia: true })
    await ctx.plugin(skillsAdp)
    await ctx.plugin(controlAdp, { allowMutating: [] })
    await ctx.loader.await()
  }, 30_000)

  afterAll(() => undefined)

  it('routes control, plugin, SSE, and account hosts to the independent site', () => {
    expect(ctx.adp.vendor()).toBe('ChinaTencentADP')
    expect(ctx.adp.resolveControlEndpoint(keys.secretId)).toEqual({
      scheme: 'https',
      host: HOST_ADP,
    })
    expect(ctx.adp.pluginBaseURL()).toBe(PLUGIN_API_BASE_STANDALONE)
    expect(ctx.adp.chatUrl()).toBe(SSE_URL_STANDALONE)
    expect(accountHostForVendor(ctx.adp.vendor())).toBe('https://adp.tencent.com')
    expect(ctx.adp.hunyuanSearchUrl()).toBe(hunyuanSearchUrl(PLUGIN_API_BASE_STANDALONE))
  })

  it('lists models from DescribeModelList on capi.adp.tencent.com', async () => {
    const data = await ctx.adp.call('DescribeModelList', { ModelScene: 3 })
    expect(data.Error).toBeUndefined()
    const parsed = normalizeModelList(data)
    expect(parsed.length, 'independent-site DescribeModelList also nests ModelBasic.ModelId').toBeGreaterThan(0)
    const models = await ctx.adp.listModels()
    expect(models.map((model) => model.id).sort()).toEqual(parsed.map((model) => model.id).sort())
  })

  it('lists spaces and apps with standalone paging (PageIndex)', async () => {
    const spaces = await ctx.adp.call('DescribeSpaceList', {})
    expect(spaces.Error).toBeUndefined()
    const apps = await ctx.adp.call('DescribeAppSummaryList', { PageIndex: 1, PageSize: 10 })
    expect(apps.Error).toBeUndefined()
  })

  it('completes a gateway turn with a catalog model', async () => {
    const models = await ctx.adp.listModels()
    const model = models.find((item) => /hunyuan|hy3/i.test(item.id))?.id ?? models[0]?.id ?? 'Hunyuan/hy3'
    const resp = await ctx.adp.gatewayFetch('/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model,
        stream: false,
        messages: [{ role: 'user', content: 'Reply with the single word pong.' }],
        max_tokens: 16,
      }),
    })
    const text = await resp.text()
    expect(
      resp.ok,
      `gateway HTTP ${resp.status} for ${model}. 401 AuthenticationError (凭证无效或已过期) is a dead gateway key, not the /v1 path bug (that one is not_authorized). Body: ${text.slice(0, 200)}`,
    ).toBe(true)
    expect(text.toLowerCase()).toMatch(/pong|choices|delta|content/)
  })

  it('runs Hunyuan AI search through the independent-site plugin host', async () => {
    const result = await ctx.web.search({ query: '腾讯云 ADP', maxResults: 5 })
    expect(result.sources.length + (result.content ? 1 : 0)).toBeGreaterThan(0)
  })
})
