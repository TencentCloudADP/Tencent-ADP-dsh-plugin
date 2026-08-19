import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createContext, runInContext } from 'node:vm'
import { pathToFileURL } from 'node:url'

describe('sim-pack', () => {
  it('loads published lib/ with node, without tsx', async () => {
    const entry = resolve('lib/index.js')
    expect(existsSync(entry)).toBe(true)
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(pathToFileURL(entry).href)})`], {
      encoding: 'utf8',
    })
    expect(result.status, result.stderr).toBe(0)
  })

  it('invalid Config fails with a non-zero exit (no tsx)', () => {
    const script = `
      import { Context, Service } from '@deepseek-ai/cordis'
      import * as Adp from ${JSON.stringify(pathToFileURL(resolve('lib/index.js')).href)}
      class Creds extends Service {
        constructor(ctx) { super(ctx, 'credentials') }
        async resolve() { return undefined }
        async describe() { return { configured: false, writable: true } }
        async set() {}
        async unset() {}
      }
      const ctx = new Context()
      await ctx.plugin(Creds)
      try {
        await ctx.plugin(Adp, { vendor: 'not-a-vendor', timeoutMs: -1 })
        process.exit(0)
      } catch {
        process.exit(1)
      }
    `
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      cwd: process.cwd(),
    })
    expect(result.status).toBe(1)
  })

  it('declares one bundle patch under the package.json name', () => {
    const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      name: string
      exports?: Record<string, unknown>
      dsh?: {
        bundle?: { patch?: string }
        client?: { platform?: string; inject?: string[] }
      }
    }
    expect(manifest.name).toBe('@tencent/dsh-adp')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(existsSync(resolve('cordis.patch.yml'))).toBe(true)
    expect(manifest.dsh?.client?.platform).toBe('web')
    expect(manifest.dsh?.client?.inject).toEqual([
      '@deepseek-ai/dsh-client-connection',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-runtime',
    ])
    expect(manifest.exports?.['./client']).toEqual({ default: './lib/client.js' })
  })

  it('ships a ModuleLoader client bundle', () => {
    const client = resolve('lib/client.js')
    expect(existsSync(client)).toBe(true)
    const source = readFileSync(client, 'utf8')
    expect(source.startsWith('window.__ModuleLoader__.load')).toBe(true)
    expect(source).toContain('id: "@tencent/dsh-adp"')
    expect(source).toContain('settings.plugins.adp')
    expect(source).toContain('"locale"')
    expect(source).toContain('/adp/site')
    expect(source).toContain('const ADP_CORE_SETTINGS_NS = "adp-core"')
    expect(source).toContain('key: ADP_CORE_SETTINGS_NS')
    expect(source).toContain('id: ADP_CORE_SETTINGS_NS')
    expect(source).not.toContain('adp-credentials')
  })

  it('client factory registers on a keyed settings.plugin.item slot', () => {
    const source = readFileSync(resolve('lib/client.js'), 'utf8')
    const nodeRequire = createRequire(import.meta.url)
    type ClientMod = { apply: (ctx: { get: () => undefined; effect: () => undefined; slots: unknown }) => void }
    let loaded: ClientMod | undefined
    const sandbox = {
      window: {
        __ModuleLoader__: {
          load(entry: { factory: (req: (id: string) => unknown) => ClientMod }) {
            loaded = entry.factory((id) => {
              if (id === 'react' || id === 'react/jsx-runtime') return nodeRequire(id)
              if (id === '@deepseek-ai/dsh-client-ui-primitives') {
                return {
                  Button: () => null,
                  Input: () => null,
                  StateDot: () => null,
                  IconChevronDownOutline14: () => null,
                }
              }
              throw new Error(`unexpected client require: ${id}`)
            })
          },
        },
      },
    }
    runInContext(source, createContext(sandbox))
    expect(loaded?.apply).toBeTypeOf('function')

    const registered: { name?: string; key?: string }[] = []
    loaded!.apply({
      get() {
        return undefined
      },
      effect() {
        return undefined
      },
      slots: {
        inject(_name: string, factory: () => unknown) {
          return factory()
        },
        register(options: { name: string; key?: string }) {
          if (options.key === undefined) {
            throw new Error(`keyed slot "${options.name}" requires options.key`)
          }
          registered.push(options)
          return options
        },
      },
    })
    expect(registered).toEqual([expect.objectContaining({
      name: 'settings.plugin.item',
      key: 'adp-core',
      id: 'adp-core',
    })])
  })
})
