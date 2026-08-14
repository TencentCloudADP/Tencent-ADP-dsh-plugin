import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { CredentialProvider, credentialRef, type CredentialInfo, type CredentialRef, type ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import LlmRuntime, { CallId } from '@deepseek-ai/dsh-llm'
import WebRuntime from '@deepseek-ai/dsh-web'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import * as adpCore from '../../src/index.ts'
import * as llmAdp from '../../src/llm/index.ts'
import * as webAdp from '../../src/web/index.ts'
import * as pluginsAdp from '../../src/plugins/index.ts'
import * as skillsAdp from '../../src/skills/index.ts'
import * as agentsAdp from '../../src/agents/index.ts'
import * as controlAdp from '../../src/control/index.ts'
import type { MockAdpServer } from './http.ts'

export class MemoryCredentials extends CredentialProvider {
  readonly store = new Map<string, string>()

  async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.store.get(ref)
    if (!value) return undefined
    return { value, source: 'memory' }
  }

  async describe(ref: CredentialRef): Promise<CredentialInfo> {
    return { configured: this.store.has(ref), writable: true, ...this.store.has(ref) ? { source: 'memory' } : {} }
  }

  async set(ref: CredentialRef, value: string): Promise<void> {
    this.store.set(ref, value)
  }

  async unset(ref: CredentialRef): Promise<void> {
    this.store.delete(ref)
  }
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

  tools(_provider: unknown): () => void {
    return () => undefined
  }

  variable(): () => void {
    return () => undefined
  }
}

let callSeq = 0

/** Typed tool call for tests — ToolRuntime requires a branded callId. */
export function toolCall(name: string, args: Record<string, unknown> = {}): ToolExecutionInput {
  callSeq += 1
  return {
    name,
    arguments: args,
    callId: CallId(`test-${name}-${callSeq}`),
    signal: new AbortController().signal,
  }
}

export interface BootOptions {
  mock: MockAdpServer
  keys?: {
    gateway?: string
    secretId?: string
    secretKey?: string
    appKey?: string
  }
  workspaceDir?: string
  enabledPluginIds?: string[]
  allowMutating?: string[]
}

export async function bootAdp(options: BootOptions) {
  const ctx = new Context()
  await ctx.plugin(Loader)
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(SystemPromptStub)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(WebRuntime)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)

  const creds = ctx.credentials as MemoryCredentials
  if (options.keys?.gateway) await creds.set(credentialRef('ADP_API_KEY'), options.keys.gateway)
  if (options.keys?.secretId) await creds.set(credentialRef('ADP_SECRET_ID'), options.keys.secretId)
  if (options.keys?.secretKey) await creds.set(credentialRef('ADP_SECRET_KEY'), options.keys.secretKey)
  if (options.keys?.appKey) await creds.set(credentialRef('ADP_APP_KEY'), options.keys.appKey)

  const coreConfig = {
    controlHost: options.mock.host,
    controlScheme: 'http' as const,
    gatewayBaseURL: options.mock.origin,
    pluginBaseURL: options.mock.origin,
    chatUrl: `${options.mock.origin}/adp/v2/chat`,
    vendor: 'ChinaTencentADP' as const,
    workspaceDir: options.workspaceDir,
  }

  await ctx.plugin(adpCore, coreConfig)
  await ctx.plugin(llmAdp)
  await ctx.plugin(webAdp)
  await ctx.plugin(pluginsAdp, { enabledPluginIds: options.enabledPluginIds ?? [], harvestMedia: true })
  await ctx.plugin(skillsAdp)
  await ctx.plugin(agentsAdp, {
    agents: options.keys?.appKey
      ? [{ name: 'demo', appId: 'app-demo', appKeyEnv: 'ADP_APP_KEY', description: 'demo' }]
      : [],
  })
  await ctx.plugin(controlAdp, { allowMutating: options.allowMutating ?? ['CreateApp', 'CreateAgent', 'ModifyApp', 'ModifyAgent', 'CreateRelease', 'DeleteAgent', 'DeleteApp'] })
  await ctx.loader.await()
  return { ctx, creds }
}

/** Loader composition: product-visible plugins loaded by name via the Loader. */
export async function bootViaLoader(options: BootOptions) {
  const ctx = new Context()
  await ctx.plugin(Loader, { baseUrl: pathToFileURL(resolve(process.cwd()) + '/').href })
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(SystemPromptStub)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(WebRuntime)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)

  const creds = ctx.credentials as MemoryCredentials
  if (options.keys?.gateway) await creds.set(credentialRef('ADP_API_KEY'), options.keys.gateway)
  if (options.keys?.secretId) await creds.set(credentialRef('ADP_SECRET_ID'), options.keys.secretId)
  if (options.keys?.secretKey) await creds.set(credentialRef('ADP_SECRET_KEY'), options.keys.secretKey)

  const entry = (rel: string) => {
    const built = resolve(process.cwd(), 'lib', rel)
    const source = resolve(process.cwd(), 'src', rel.replace(/\.js$/, '.ts'))
    return pathToFileURL(existsSync(built) ? built : source).href
  }

  await ctx.loader.create({
    id: 'adp-core',
    name: entry('index.js'),
    config: {
      controlHost: options.mock.host,
      controlScheme: 'http',
      gatewayBaseURL: options.mock.origin,
      pluginBaseURL: options.mock.origin,
      chatUrl: `${options.mock.origin}/adp/v2/chat`,
      vendor: 'ChinaTencentADP',
      workspaceDir: options.workspaceDir,
    },
  })
  await ctx.loader.create({ id: 'llm-adp', name: entry('llm/index.js') })
  await ctx.loader.create({ id: 'web-adp', name: entry('web/index.js') })
  await ctx.loader.create({
    id: 'plugins-adp',
    name: entry('plugins/index.js'),
    config: { enabledPluginIds: options.enabledPluginIds ?? [] },
  })
  await ctx.loader.create({ id: 'skills-adp', name: entry('skills/index.js') })
  await ctx.loader.create({ id: 'agents-adp', name: entry('agents/index.js') })
  await ctx.loader.create({
    id: 'control-adp',
    name: entry('control/index.js'),
    config: { allowMutating: options.allowMutating ?? ['DeleteApp'] },
  })
  await ctx.loader.await()
  return { ctx, creds }
}
