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
import * as agentsAdp from '../../src/agents/index.ts'
import * as controlAdp from '../../src/control/index.ts'
import {
  HOST_CLOUD,
  PLUGIN_API_BASE,
  SSE_URL_CN,
  accountHostForVendor,
  hunyuanSearchUrl,
} from '../../src/core/hosts.ts'
import { fetchAppKey } from '../../src/agents/provision.ts'
import { isExternallyCallable, type PluginDetail } from '../../src/core/service.ts'
import { MODEL_SCENE_CLAW, normalizeModelList } from '../../src/core/models.ts'
import { MemoryCredentials, toolCall } from '../mock/harness.ts'

const required = ['ADP_API_KEY', 'ADP_SECRET_ID', 'ADP_SECRET_KEY'] as const
const keys = {
  gateway: process.env.ADP_API_KEY?.trim() ?? '',
  secretId: process.env.ADP_SECRET_ID?.trim() ?? '',
  secretKey: process.env.ADP_SECRET_KEY?.trim() ?? '',
}
const missing = required.filter((name) => !process.env[name]?.trim())

function appDisplayName(row: Record<string, unknown>): string {
  const profile = row.Profile && typeof row.Profile === 'object' ? row.Profile as Record<string, unknown> : undefined
  return String(profile?.Name ?? row.Name ?? '')
}

function appRows(data: Record<string, unknown>): Array<Record<string, unknown>> {
  return ((data.AppList ?? data.AppSummaryList ?? data.List) as Array<Record<string, unknown>> | undefined) ?? []
}

async function listAllApps(adp: { call: (action: string, payload?: Record<string, unknown>) => Promise<Record<string, unknown>> }) {
  const out: Array<Record<string, unknown>> = []
  for (let page = 0; page < 20; page += 1) {
    const data = await adp.call('DescribeAppSummaryList', { PageNumber: page, PageSize: 50 })
    const rows = appRows(data)
    out.push(...rows)
    if (rows.length === 0 || out.length >= Number(data.TotalCount ?? 0)) break
  }
  return out
}

function appStatusCode(row: Record<string, unknown>): number {
  const raw = row.Status
  if (raw && typeof raw === 'object') return Number((raw as Record<string, unknown>).Status ?? 0)
  return Number(raw ?? 0)
}

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
  let createdAppId: string | undefined
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
    await ctx.plugin(agentsAdp, { agents: [], defaultAppMode: 4 })
    await ctx.plugin(controlAdp, { allowMutating: [] })
    await ctx.loader.await()
    const spaces = await ctx.adp.call('DescribeSpaceList', {})
    const first = ((spaces.SpaceList as Array<Record<string, unknown>> | undefined) ?? [])
      .map((row) => String(row.SpaceId ?? '').trim())
      .find(Boolean)
    if (first) ctx.adp.setLiveSpaceId(first)
  }, 30_000)

  afterAll(async () => {
    const ids = new Set<string>()
    if (createdAppId) ids.add(createdAppId)
    try {
      for (const row of await listAllApps(ctx.adp)) {
        const appId = String(row.AppId ?? row.Id ?? '').trim()
        if (appId && appDisplayName(row).startsWith('dsh-e2e-')) ids.add(appId)
      }
    } catch {
      // Listing is best-effort cleanup.
    }
    for (const appId of ids) {
      try {
        await ctx.adp.call('DeleteApp', { AppId: appId })
      } catch {
        // Best-effort cleanup of the throwaway e2e app.
      }
    }
  })

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

  it('lists skill plaza entries through skills-adp', async () => {
    const data = await ctx.adp.call('DescribeSkillSummaryList', {
      PageNumber: 0,
      PageSize: 20,
    })
    expect(data.Error).toBeUndefined()
    const rows = data.SkillSummaryList ?? data.SkillList ?? data.List
    expect(Array.isArray(rows)).toBe(true)
    const skills = await ctx.skills.list({ cwd: workspaceDir })
    expect(Array.isArray(skills)).toBe(true)
    const first = skills.find((skill) => skill.provider === 'adp')
    if (first) {
      const got = await ctx.skills.get(first.name, { cwd: workspaceDir })
      if (got) expect(got.content.length).toBeGreaterThan(0)
    }
  })

  it('exposes control-adp tools: list, read call, deny mutating', async () => {
    expect(ctx.tools.get('adp_list_actions')).toBeTruthy()
    expect(ctx.tools.get('adp_call')).toBeTruthy()
    const listed = await ctx.tools.execute(toolCall('adp_list_actions'))
    expect(listed.isError).toBe(false)
    const actions = (listed.value as { actions: Array<{ action: string; allowed: boolean; mutating: boolean }> }).actions
    expect(actions.some((row) => row.action === 'DescribeAppSummaryList' && row.allowed)).toBe(true)
    expect(actions.some((row) => row.action === 'DeleteApp' && row.mutating && !row.allowed)).toBe(true)
    const read = await ctx.tools.execute(toolCall('adp_call', {
      action: 'DescribeAppSummaryList',
      payload: { PageNumber: 0, PageSize: 5 },
    }))
    expect(read.isError, `adp_call DescribeAppSummaryList: ${JSON.stringify(read).slice(0, 240)}`).toBe(false)
    const asString = await ctx.tools.execute(toolCall('adp_call', {
      action: 'DescribeAppSummaryList',
      payload: '{"PageNumber":0,"PageSize":5}',
    }))
    expect(asString.isError, `adp_call JSON-string payload: ${JSON.stringify(asString).slice(0, 240)}`).toBe(false)
    const denied = await ctx.tools.execute(toolCall('adp_call', {
      action: 'DeleteApp',
      payload: { AppId: 'must-not-run' },
    }))
    expect(denied.isError || (denied as { kind?: string }).kind === 'deny' || (denied as { kind?: string }).kind === 'ask').toBeTruthy()
  })

  it('provisions an app, waits for release, then asks over SSE', async () => {
    expect(ctx.tools.get('adp_provision_agent')).toBeTruthy()
    expect(ctx.tools.get('adp_ask')).toBeTruthy()
    const creds = ctx.credentials as MemoryCredentials
    const listed = await listAllApps(ctx.adp)
    for (const row of listed) {
      const appId = String(row.AppId ?? row.Id ?? '').trim()
      if (!appId || !appDisplayName(row).startsWith('dsh-e2e-')) continue
      try {
        await ctx.adp.call('DeleteApp', { AppId: appId })
      } catch {
        continue
      }
    }
    const claw = normalizeModelList(await ctx.adp.call('DescribeModelList', { ModelScene: MODEL_SCENE_CLAW }))
    const result = await ctx.tools.execute(toolCall('adp_provision_agent', {
      name: `dsh-e2e-${Date.now().toString(36)}`,
      instructions: 'Reply with the single word pong and nothing else.',
      appMode: claw.length > 0 ? 4 : 1,
    }))
    let appKey = ''
    if (!result.isError) {
      const value = result.value as { kind: string; appId?: string; appKeyRef?: string; message?: string }
      createdAppId = value.appId
      expect(value.kind, value.message ?? JSON.stringify(value)).toBe('ready')
      expect(value.appKeyRef).toBeTruthy()
      const stored = await creds.resolve(credentialRef(value.appKeyRef!))
      appKey = stored?.value ?? ''
    } else {
      expect(JSON.stringify(result), `adp_provision_agent: ${JSON.stringify(result).slice(0, 400)}`).toMatch(/4900001/)
      const running = listed.filter((row) => appStatusCode(row) === 2 && !appDisplayName(row).startsWith('dsh-e2e-'))
      let appId = ''
      for (const row of running.slice(0, 12)) {
        const id = String(row.AppId ?? row.Id ?? '').trim()
        if (!id) continue
        try {
          const key = await fetchAppKey(ctx.adp, id)
          if (key) {
            appId = id
            appKey = key
            break
          }
        } catch {
          continue
        }
      }
      expect(appId, 'quota blocked CreateApp and no running app with AppKey').toBeTruthy()
      await expect(ctx.adp.call('DescribeReleaseSummary', { AppId: appId })).rejects.toThrow(/ReleaseId|MissingParameter/)
      const latest = await ctx.adp.call('DescribeLatestRelease', { AppId: appId })
      const release = (latest.ReleaseSummary ?? latest) as Record<string, unknown>
      const releaseId = String(release.ReleaseId ?? latest.ReleaseId ?? '')
      expect(releaseId, 'DescribeLatestRelease returned no ReleaseId').toBeTruthy()
      const summary = await ctx.adp.call('DescribeReleaseSummary', { AppId: appId, ReleaseId: releaseId })
      const polled = (summary.ReleaseSummary ?? summary) as Record<string, unknown>
      expect(Number(polled.Status ?? 0)).toBe(3)
    }
    expect(appKey, 'no AppKey from provision or existing app').toBeTruthy()
    await creds.set(credentialRef('ADP_APP_KEY_E2E'), appKey)
    const asked = await ctx.tools.execute(toolCall('adp_ask', {
      question: 'Reply with the single word pong.',
      appKeyEnv: 'ADP_APP_KEY_E2E',
    }))
    expect(asked.isError, `adp_ask: ${JSON.stringify(asked).slice(0, 400)}`).toBe(false)
    const answer = (asked.value as { answer?: string }).answer ?? ''
    expect(answer.length).toBeGreaterThan(0)
  }, 180_000)
})
