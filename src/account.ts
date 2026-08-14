import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { unwrapAccountPayload } from './core/sse.ts'
import { ACCOUNT_HOST_STANDALONE, accountHostForVendor } from './core/hosts.ts'
import { PROXY_SITE_PATH, handleSite } from './site.ts'
import type { AdpService } from './core/service.ts'

/** Production independent-site account host. OneID callback landing is this origin. */
export const ACCOUNT_HOST = ACCOUNT_HOST_STANDALONE
/** The only `login_platform` the live service accepts. `adp-console` is RemoteServerError 19000. */
export const LOGIN_PLATFORM = 'oneid'
export const COOKIE_TOKEN = 'adp_iam_token'
export const ACCOUNT_LOGIN_URL_PATH = '/account/login-url'
export const PROXY_LOGIN_URL_PATH = '/adp/account/login-url'
export const PROXY_ICON_PATH = '/adp/icon.svg'

export type LoginUrlResult =
  | { ok: true; login_url: string; landing_host: string; cookie_name: string }
  | { ok: false; error: string }

interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

function normalizeHost(host: string): string {
  return host.replace(/\/$/, '')
}

/** Cookie jar host for the fixed OneID `redirect_uri`. Production: same as the API host. */
export function landingHost(apiHost: string = ACCOUNT_HOST): string {
  return normalizeHost(apiHost)
}

/**
 * POST `/account/login-url` and unwrap the authorize URL.
 * Does not exchange the session for AKSK / `sk-` / AppKey — ADP has no such API.
 */
export async function fetchLoginUrl(options: { host?: string } = {}): Promise<LoginUrlResult> {
  const host = normalizeHost(options.host ?? ACCOUNT_HOST)
  try {
    const resp = await fetch(`${host}${ACCOUNT_LOGIN_URL_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login_platform: LOGIN_PLATFORM }),
    })
    let parsed: unknown
    try {
      parsed = await resp.json()
    } catch {
      return { ok: false, error: `Account service returned HTTP ${resp.status} with non-JSON content.` }
    }
    const data = unwrapAccountPayload(parsed)
    const loginUrl = String(data.login_url ?? '')
    if (!loginUrl) {
      return { ok: false, error: 'The account service returned no login_url.' }
    }
    return {
      ok: true,
      login_url: loginUrl,
      landing_host: landingHost(host),
      cookie_name: COOKIE_TOKEN,
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function iconSvgPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'adp-icon.svg')
}

const LOGIN_URL_METHODS = new Set(['GET', 'POST'])

/** Same-origin proxy: always JSON, including 405 / upstream failure. */
export async function handleLoginUrl(
  req: IncomingMessage,
  res: ServerResponse,
  host?: string,
): Promise<void> {
  const method = req.method ?? 'GET'
  if (!LOGIN_URL_METHODS.has(method)) {
    res.setHeader('allow', 'GET, POST')
    sendJson(res, 405, { ok: false, error: `Method ${method} is not allowed.` })
    return
  }
  const result = await fetchLoginUrl(host ? { host } : {})
  sendJson(res, result.ok ? 200 : 502, result)
}

function handleIcon(_req: IncomingMessage, res: ServerResponse): void {
  try {
    const svg = readFileSync(iconSvgPath())
    res.statusCode = 200
    res.setHeader('content-type', 'image/svg+xml; charset=utf-8')
    res.setHeader('cache-control', 'public, max-age=86400')
    res.end(svg)
  } catch {
    res.statusCode = 404
    res.end()
  }
}

function accountHostFromCtx(ctx: Context): string {
  const adp = ctx.get('adp') as AdpService | undefined
  return adp ? accountHostForVendor(adp.vendor()) : ACCOUNT_HOST
}

/** Same-origin proxies for the web client. No-op until `webServer` exists (tests omit it). */
export function registerAdpWebRoutes(ctx: Context): void {
  const webServer = ctx.get('webServer') as WebServerLike | undefined
  if (!webServer) return
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: PROXY_LOGIN_URL_PATH,
    handler: (req, res) => handleLoginUrl(req, res, accountHostFromCtx(ctx)),
  }))
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: PROXY_ICON_PATH,
    handler: handleIcon,
  }))
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: PROXY_SITE_PATH,
    handler: (req, res) => handleSite(req, res, ctx),
  }))
}
