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
  HOST_CLOUD,
  PLUGIN_API_BASE,
  SSE_URL_CN,
  accountHostForVendor,
  hunyuanSearchUrl,
} from '../../src/core/hosts.ts'
import { isExternallyCallable, type PluginDetail } from '../../src/core/service.ts'
import { normalizeModelList } from '../../src/core/models.ts'
import { MemoryCredentials, toolCall } from '../mock/harness.ts'

const required = ['ADP_API_KEY', 'ADP_SECRET_ID', 'ADP_SECRET_KEY'] as const
const keys = {
  gateway: process.env.ADP_API_KEY?.trim() ?? '',
  secretId: process.env.ADP_SECRET_ID?.trim() ?? '',
  secretKey: process.env.ADP_SECRET_KEY?.trim() ?? '',
}
const missing = required.filter((name) => !process.env[name]?.trim())

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

describe.skipIf(missing.length > 0)('public-cloud e2e', () => {
  let ctx: Context
  let workspaceDir: string
  const found: { api?: PluginDetail; mcp?: PluginDetail } = {}

  beforeAll(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'adp-cloud-e2e-'))
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
      vendor: 'ChinaTencentCloud',
      workspaceDir,
    })
    await ctx.plugin(llmAdp)
    await ctx.plugin(webAdp)
    await ctx.plugin(pluginsAdp, { enabledPluginIds: [], harvestMedia: true })
    await ctx.plugin(skillsAdp)
    await ctx.plugin(controlAdp, { allowMutating: [] })
    await ctx.loader.await()
    const spaces = await ctx.adp.call('DescribeSpaceList', {})
    const first = ((spaces.SpaceList as Array<Record<string, unknown>> | undefined) ?? [])
      .map((row) => String(row.SpaceId ?? '').trim())
      .find(Boolean)
    if (first) ctx.adp.setLiveSpaceId(first)
  }, 30_000)

  afterAll(() => undefined)

  it('routes control, plugin, SSE, and account hosts to public cloud', () => {
    expect(ctx.adp.vendor()).toBe('ChinaTencentCloud')
    expect(ctx.adp.resolveControlEndpoint(keys.secretId)).toEqual({
      scheme: 'https',
      host: HOST_CLOUD,
    })
    expect(ctx.adp.pluginBaseURL()).toBe(PLUGIN_API_BASE)
    expect(ctx.adp.chatUrl()).toBe(SSE_URL_CN)
    expect(accountHostForVendor(ctx.adp.vendor())).toBe('https://adp.cloud.tencent.com')
    expect(ctx.adp.hunyuanSearchUrl()).toBe(hunyuanSearchUrl(PLUGIN_API_BASE))
  })

  it('lists models from DescribeModelList on adp.tencentcloudapi.com', async () => {
    const data = await ctx.adp.call('DescribeModelList', { ModelScene: 3 })
    const parsed = normalizeModelList(data)
    expect(parsed.length, 'DescribeModelList rows must unwrap ModelBasic.ModelId, not fall back to builtins').toBeGreaterThan(0)
    const models = await ctx.adp.listModels()
    expect(models.map((model) => model.id).sort()).toEqual(parsed.map((model) => model.id).sort())
    const llmModels = await ctx.llm.listModels('adp')
    expect(llmModels.some((model) => model.id === parsed[0]?.id)).toBe(true)
  })

  it('lists spaces and apps on the control plane', async () => {
    const spaces = await ctx.adp.call('DescribeSpaceList', {})
    expect(spaces.Error).toBeUndefined()
    expect(Array.isArray(spaces.SpaceList) || Number(spaces.TotalCount ?? 0) >= 0).toBe(true)
    const apps = await ctx.adp.call('DescribeAppSummaryList', { PageNumber: 0, PageSize: 10 })
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
      `gateway HTTP ${resp.status} for ${model} at /chat/completions. 401 not_authorized usually means /v1 was prepended; 403 AccountOverdueError means the key is valid but the model account needs credit. Body: ${text.slice(0, 200)}`,
    ).toBe(true)
    expect(text.toLowerCase()).toMatch(/pong|choices|delta|content/)
  })

  it('runs Hunyuan AI search through the public-cloud plugin host', async () => {
    const result = await ctx.web.search({ query: '腾讯云 ADP', maxResults: 5 })
    expect(result.sources.length + (result.content ? 1 : 0)).toBeGreaterThan(0)
  })

  it('lists marketplace plugins and describes one API and one MCP', async () => {
    const page = await ctx.adp.call('DescribePluginSummaryList', { PageNumber: 0, PageSize: 50 })
    const summaries = (page.PluginList as Array<Record<string, unknown>> | undefined) ?? []
    expect(summaries.length).toBeGreaterThan(0)
    for (const summary of summaries.slice(0, 16)) {
      const pluginId = String(summary.PluginId ?? '')
      if (!pluginId) continue
      try {
        const detail = await ctx.adp.describePlugin(pluginId)
        if (!isExternallyCallable(detail)) continue
        if (!found.api && detail.apiTools.length > 0) found.api = detail
        if (!found.mcp && detail.mcpUrl) found.mcp = detail
        if (found.api && found.mcp) break
      } catch {
        continue
      }
    }
    expect(found.api || found.mcp, 'no externally callable API/MCP plugin in the first page').toBeTruthy()
  })

  it('enables a marketplace plugin and registers its tools', async () => {
    const target = found.api ?? found.mcp
    expect(target, 'plugin describe step found nothing to enable').toBeTruthy()
    const result = await ctx.tools.execute(toolCall('adp_plugin_enable', { pluginId: target!.pluginId }))
    expect(result.isError).toBe(false)
    const value = result.value as { registered?: string[] }
    expect(value.registered?.length).toBeGreaterThan(0)
    expect(ctx.tools.get(value.registered![0]!)).toBeTruthy()
  })

  it('lists skill plaza entries', async () => {
    const data = await ctx.adp.call('DescribeSkillSummaryList', {
      PageNumber: 0,
      PageSize: 20,
    })
    expect(data.Error).toBeUndefined()
    const rows = data.SkillSummaryList ?? data.SkillList ?? data.List
    expect(Array.isArray(rows)).toBe(true)
    const skills = await ctx.skills.list()
    expect(Array.isArray(skills)).toBe(true)
  })

  it('exposes read-only control tools and refuses mutating calls', async () => {
    const listed = await ctx.tools.execute(toolCall('adp_list_actions'))
    expect(listed.isError).toBe(false)
    const denied = await ctx.tools.execute(toolCall('adp_call', {
      action: 'DeleteApp',
      payload: { AppId: 'must-not-run' },
    }))
    expect(denied.isError || denied.kind === 'deny' || (denied as { kind?: string }).kind === 'ask').toBeTruthy()
  })
})
