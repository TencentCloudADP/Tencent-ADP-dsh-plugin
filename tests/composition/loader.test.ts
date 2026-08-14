import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as adpCore from '../../src/index.ts'
import { PROXY_ICON_PATH, PROXY_LOGIN_URL_PATH } from '../../src/account.ts'
import * as llmAdp from '../../src/llm/index.ts'
import * as webAdp from '../../src/web/index.ts'
import * as pluginsAdp from '../../src/plugins/index.ts'
import * as skillsAdp from '../../src/skills/index.ts'
import * as agentsAdp from '../../src/agents/index.ts'
import * as controlAdp from '../../src/control/index.ts'
import { startMockAdp, type MockAdpServer } from '../mock/http.ts'
import { bootViaLoader, MemoryCredentials, toolCall } from '../mock/harness.ts'

/** Loader ids from a bundle patch `insert:` list (DSH concatenates insert layers). */
function insertIds(source: string): string[] {
  return [...source.matchAll(/^\s+- id: (\S+)\s*$/gm)].map((match) => match[1]!)
}

function assertUniqueLoaderIds(ids: string[]): void {
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) throw new TypeError(`duplicate loader entry id: ${id}`)
    seen.add(id)
  }
}

describe('bundle patch loader ids', () => {
  const patch = readFileSync(resolve(process.cwd(), 'cordis.patch.yml'), 'utf8')
  const ids = insertIds(patch)

  it('one bundle layer has unique loader ids', () => {
    expect(ids).toEqual(['adp-core', 'llm-adp', 'web-adp', 'plugins-adp', 'skills-adp', 'agents-adp', 'control-adp'])
    expect(() => assertUniqueLoaderIds(ids)).not.toThrow()
  })

  it('two bundle layers of this patch duplicate adp-core', () => {
    expect(() => assertUniqueLoaderIds([...ids, ...ids])).toThrow(TypeError)
    expect(() => assertUniqueLoaderIds([...ids, ...ids])).toThrow(/duplicate loader entry id: adp-core/)
  })

  it('Loader rejects a composed insert list with duplicate adp-core', async () => {
    const ctx = new Context()
    await ctx.plugin(Loader)
    const rows = ids.map((id) => ({ id, name: `@tencent/dsh-adp` }))
    await expect(ctx.loader.root.update([...rows, ...rows])).rejects.toThrow(/duplicate loader entry id: adp-core/)
  })
})

describe('sim-export', () => {
  it('function plugins keep named name/inject/apply and default does not replace them', () => {
    const loader = Object.create(Loader.prototype) as Loader
    for (const mod of [adpCore, llmAdp, webAdp, pluginsAdp, skillsAdp, agentsAdp, controlAdp]) {
      expect('default' in mod).toBe(false)
      expect(mod.name).toBeTypeOf('string')
      expect(mod.inject).toBeInstanceOf(Array)
      expect(mod.apply).toBeTypeOf('function')
      const unwrapped = loader.unwrapExports(mod)
      expect(unwrapped).toBe(mod)
      expect(unwrapped.name).toBe(mod.name)
      expect(unwrapped.apply).toBe(mod.apply)
    }
    expect(loader.unwrapExports(adpCore)).not.toBe(adpCore.AdpService)
  })

  it('apply registers /adp/account/login-url when webServer is present', async () => {
    const routes = new Map<string, { kind: string; path: string }>()
    class WebServerStub extends Service {
      constructor(ctx: Context) {
        super(ctx, 'webServer')
      }
      register(route: { kind: string; path: string }) {
        routes.set(route.path, route)
        return () => {
          routes.delete(route.path)
        }
      }
    }
    const ctx = new Context()
    await ctx.plugin(MemoryCredentials)
    await ctx.plugin(WebServerStub)
    await ctx.plugin(adpCore, { timeoutMs: 1000 })
    expect(routes.get(PROXY_LOGIN_URL_PATH)?.kind).toBe('exact')
    expect(routes.get(PROXY_ICON_PATH)?.kind).toBe('exact')
  })
})

describe('sim-hmr + Loader composition', () => {
  let mock: MockAdpServer | undefined
  afterEach(async () => {
    await mock?.close()
    mock = undefined
  })

  it('loads product plugins through Loader against the mock', async () => {
    mock = await startMockAdp()
    const { ctx } = await bootViaLoader({
      mock,
      keys: { gateway: 'sk-good', secretId: 'AKIDxxxxxxxxxxxxxxxxxxxxxxxxxxxx', secretKey: 'control-secret' },
      enabledPluginIds: ['plugin-api'],
    })
    expect(ctx.adp).toBeTruthy()
    expect(ctx.llm.listProviders().some((p) => p.id === 'adp')).toBe(true)
    expect(ctx.tools.get('adp_plugin_list')).toBeTruthy()
    expect(ctx.tools.get('adp_list_actions')).toBeTruthy()
  })

  it('sim-hmr: disposing the plugins fiber unregisters tools', async () => {
    mock = await startMockAdp()
    const { ctx } = await bootViaLoader({
      mock,
      keys: { gateway: 'sk-good', secretId: 'AKIDxxxxxxxxxxxxxxxxxxxxxxxxxxxx', secretKey: 'control-secret' },
    })
    await ctx.tools.execute(toolCall('adp_plugin_enable', { pluginId: 'plugin-api' }))
    expect(ctx.tools.get('adp_p__runquery')).toBeTruthy()
    const entry = [...ctx.loader.entries()].find((e) => e.options.id === 'plugins-adp')
    expect(entry).toBeTruthy()
    await ctx.loader.remove(entry!.id)
    await ctx.loader.await()
    expect(ctx.tools.get('adp_p__runquery')).toBeUndefined()
    expect(ctx.tools.get('adp_plugin_list')).toBeUndefined()
  })
})
