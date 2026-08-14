import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { AdpService } from './core/service.ts'
import {
  parseSiteVendor,
  siteVendorFromConfig,
  type AdpVendor,
  type SiteVendor,
} from './core/hosts.ts'

export const PROXY_SITE_PATH = '/adp/site'
export const ADP_SITE_SETTINGS_NS = settingsNamespace('adp-core')

export interface SiteSettings {
  vendor: SiteVendor
}

export const SiteConfig: z<SiteSettings> = z.object({
  vendor: z.union([
    z.const('ChinaTencentADP'),
    z.const('ChinaTencentCloud'),
  ]).default('ChinaTencentADP'),
})

type SettingsLike = {
  update: (ns: ReturnType<typeof settingsNamespace>, patch: object) => Promise<void>
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk))
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new Error('Request body is not JSON.')
  }
}

export function siteView(service: AdpService): { ok: true; vendor: SiteVendor } {
  return { ok: true, vendor: siteVendorFromConfig(service.vendor()) }
}

export async function applySiteVendor(ctx: Context, vendor: SiteVendor): Promise<void> {
  const service = ctx.get('adp') as AdpService | undefined
  if (!service) throw new Error('ADP service is not registered.')
  service.setLiveVendor(vendor)
  const settings = ctx.get('settings') as SettingsLike | undefined
  if (settings) {
    await settings.update(ADP_SITE_SETTINGS_NS, { vendor })
  }
}

/** Same-origin GET/POST for the settings card. DSH web does not expose `adp-core` over settings.*. */
export async function handleSite(req: IncomingMessage, res: ServerResponse, ctx: Context): Promise<void> {
  const service = ctx.get('adp') as AdpService | undefined
  if (!service) {
    sendJson(res, 503, { ok: false, error: 'ADP service is not registered.' })
    return
  }
  const method = req.method ?? 'GET'
  if (method === 'GET') {
    sendJson(res, 200, siteView(service))
    return
  }
  if (method === 'POST') {
    let payload: unknown
    try {
      payload = await readJsonBody(req)
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    const vendor = parseSiteVendor((payload as { vendor?: unknown }).vendor)
    if (!vendor) {
      sendJson(res, 400, { ok: false, error: 'vendor must be ChinaTencentADP or ChinaTencentCloud.' })
      return
    }
    await applySiteVendor(ctx, vendor)
    sendJson(res, 200, siteView(service))
    return
  }
  res.setHeader('allow', 'GET, POST')
  sendJson(res, 405, { ok: false, error: `Method ${method} is not allowed.` })
}

export function registerSiteSettings(ctx: Context, configVendor: AdpVendor | undefined): void {
  const service = ctx.get('adp') as AdpService | undefined
  if (!service) return
  if (!ctx.get('settings')) return
  installSettingsSection(ctx, ADP_SITE_SETTINGS_NS, SiteConfig, {
    vendor: siteVendorFromConfig(configVendor),
  }, {
    setSource: (current) => service.attachSiteSource(current),
    onChange: () => undefined,
  })
}

export type { SiteVendor }
