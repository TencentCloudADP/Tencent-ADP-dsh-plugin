import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
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
  })
})
