import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import z from '@deepseek-ai/schemastery'
import { CATALOG, catalogList, type CatalogEntry } from './catalog.ts'
import { AdpError, INVALID_CREDENTIAL, MISSING_CREDENTIAL, errorWithoutSecret } from './errors.ts'
import {
  GATEWAY_BASE_URL,
  HOST_LKE,
  type AdpVendor,
  type SiteVendor,
  chatUrlForVendor,
  hostForVendor,
  pluginBaseForVendor,
  hunyuanSearchUrl,
  isCloudAksk,
} from './hosts.ts'
import { harvestMedia } from './media.ts'
import { BUILTIN_MODELS, MODEL_SCENE_AGENT, normalizeModelList } from './models.ts'
import { readBody } from './sse.ts'
import { buildHeaders } from './signing.ts'

export type { AdpVendor }

declare module '@deepseek-ai/cordis' {
  interface Context {
    adp: AdpService
  }
}

export interface AdpConfig {
  gatewayKeyEnv?: string
  secretIdEnv?: string
  secretKeyEnv?: string
  spaceId?: string
  region?: string
  vendor?: AdpVendor
  /** Override control-plane host (`host[:port]`, no scheme). Tests point this at the mock. */
  controlHost?: string
  controlScheme?: 'https' | 'http'
  gatewayBaseURL?: string
  pluginBaseURL?: string
  chatUrl?: string
  userId?: string
  timeoutMs?: number
  workspaceDir?: string
}

export const Config: z<AdpConfig> = z.object({
  gatewayKeyEnv: z.string().role('credential-ref').default('ADP_API_KEY'),
  secretIdEnv: z.string().role('credential-ref').default('ADP_SECRET_ID'),
  secretKeyEnv: z.string().role('credential-ref').default('ADP_SECRET_KEY'),
  spaceId: z.string().default('default_space'),
  region: z.string().default('ap-guangzhou'),
  vendor: z.union([
    z.const('ChinaTencentADP'),
    z.const('ChinaTencentCloud'),
    z.const('International'),
  ]).default('ChinaTencentADP'),
  controlHost: z.string(),
  controlScheme: z.union(['https', 'http']),
  gatewayBaseURL: z.string(),
  pluginBaseURL: z.string(),
  chatUrl: z.string(),
  userId: z.string().default('adp-dsh'),
  timeoutMs: z.number().min(1).default(30_000),
  workspaceDir: z.string(),
})

export interface ControlCredentials {
  secretId: string
  secretKey: string
}

export interface PluginHeaderNeed {
  name: string
}

export interface ApiToolInfo {
  toolId: string
  name: string
  description: string
  url: string
  method: string
  streamMode: number
  body: ParamDecl[]
}

export interface ParamDecl {
  name: string
  description: string
  type: number | undefined
  required: boolean
  subParams: ParamDecl[]
}

export interface PluginDetail {
  pluginId: string
  name: string
  description: string
  kind: number | undefined
  mcpUrl: string
  mcpTransport: 'sse' | 'streamable-http'
  apiTools: ApiToolInfo[]
  needsHeaders: PluginHeaderNeed[]
  allowExternalAccess: boolean
}

const DEFAULT_GATEWAY_ENV = 'ADP_API_KEY'
const DEFAULT_SECRET_ID_ENV = 'ADP_SECRET_ID'
const DEFAULT_SECRET_KEY_ENV = 'ADP_SECRET_KEY'

export class AdpService extends Service {
  static inject = ['credentials']
  static Config = Config

  /** Test hook: pin TC3 timestamps. */
  clock: () => number = () => Math.floor(Date.now() / 1000)

  private siteSource?: () => { vendor: SiteVendor; spaceId?: string }
  private liveVendor?: AdpVendor
  private liveSpaceId?: string

  constructor(protected ctx: Context, public config: AdpConfig) {
    super(ctx, 'adp')
  }

  /** Settings-resolved site choice, when `ctx.settings` is present. */
  attachSiteSource(source: () => { vendor: SiteVendor; spaceId?: string }): void {
    this.siteSource = source
  }

  /** In-process override used when settings are absent (tests, or settings inject pending). */
  setLiveVendor(vendor: AdpVendor | undefined): void {
    this.liveVendor = vendor
  }

  /** In-process SpaceId override. Public-cloud apps/plugins reject the patch default `default_space`. */
  setLiveSpaceId(spaceId: string | undefined): void {
    const trimmed = spaceId?.trim()
    this.liveSpaceId = trimmed || undefined
  }

  gatewayKeyRef(): CredentialRef {
    return credentialRef(this.config.gatewayKeyEnv ?? DEFAULT_GATEWAY_ENV)
  }

  secretIdRef(): CredentialRef {
    return credentialRef(this.config.secretIdEnv ?? DEFAULT_SECRET_ID_ENV)
  }

  secretKeyRef(): CredentialRef {
    return credentialRef(this.config.secretKeyEnv ?? DEFAULT_SECRET_KEY_ENV)
  }

  vendor(): AdpVendor {
    if (this.liveVendor) return this.liveVendor
    const site = this.siteSource?.()
    if (site?.vendor) return site.vendor
    return this.config.vendor ?? 'ChinaTencentADP'
  }

  spaceId(): string {
    if (this.liveSpaceId) return this.liveSpaceId
    const site = this.siteSource?.()
    if (site?.spaceId?.trim()) return site.spaceId.trim()
    return this.config.spaceId || 'default_space'
  }

  async listSpaces(signal?: AbortSignal): Promise<Array<{ id: string; name: string }>> {
    const data = await this.call('DescribeSpaceList', {}, signal)
    const rows = (data.SpaceList as Array<Record<string, unknown>> | undefined) ?? []
    const out: Array<{ id: string; name: string }> = []
    for (const row of rows) {
      const id = String(row.SpaceId ?? '').trim()
      if (!id) continue
      out.push({ id, name: String(row.Name ?? row.SpaceName ?? id) })
    }
    return out
  }

  region(): string {
    return this.config.region || 'ap-guangzhou'
  }

  userId(): string {
    return this.config.userId || 'adp-dsh'
  }

  gatewayBaseURL(): string {
    return (this.config.gatewayBaseURL || GATEWAY_BASE_URL).replace(/\/$/, '')
  }

  pluginBaseURL(): string {
    return (this.config.pluginBaseURL || pluginBaseForVendor(this.vendor())).replace(/\/$/, '')
  }

  chatUrl(): string {
    return this.config.chatUrl || chatUrlForVendor(this.vendor())
  }

  hunyuanSearchUrl(): string {
    return hunyuanSearchUrl(this.pluginBaseURL())
  }

  workspaceDir(): string | undefined {
    return this.config.workspaceDir
  }

  catalog() {
    return catalogList()
  }

  async resolveGatewayKey(): Promise<string> {
    const ref = this.gatewayKeyRef()
    const hit = await this.ctx.credentials.resolve(ref)
    if (!hit?.value) {
      throw new AdpError(
        `No ADP gateway key for ${ref}. Store it through credentials or export ${ref}.`,
        MISSING_CREDENTIAL,
      )
    }
    const value = hit.value.trim()
    if (!value) {
      throw new AdpError(`ADP gateway key ${ref} is blank.`, INVALID_CREDENTIAL)
    }
    if (/[\r\n]/.test(value)) {
      throw new AdpError(`ADP gateway key ${ref} contains illegal characters.`, INVALID_CREDENTIAL)
    }
    return value
  }

  async resolveControlCredentials(): Promise<ControlCredentials> {
    const idRef = this.secretIdRef()
    const keyRef = this.secretKeyRef()
    const idHit = await this.ctx.credentials.resolve(idRef)
    const keyHit = await this.ctx.credentials.resolve(keyRef)
    if (!idHit?.value || !keyHit?.value) {
      const missing = !idHit?.value ? idRef : keyRef
      throw new AdpError(
        `No ADP control-plane credential for ${missing}. Listing plugins and apps needs SecretId/SecretKey.`,
        MISSING_CREDENTIAL,
      )
    }
    return { secretId: idHit.value.trim(), secretKey: keyHit.value.trim() }
  }

  resolveControlEndpoint(secretId: string): { scheme: 'http' | 'https'; host: string } {
    if (this.config.controlHost) {
      return {
        scheme: this.config.controlScheme ?? 'http',
        host: this.config.controlHost.replace(/^https?:\/\//, '').replace(/\/$/, ''),
      }
    }
    return { scheme: 'https', host: hostForVendor(this.vendor(), secretId) }
  }

  /**
   * Signed control-plane call. Returns the unwrapped `Response` object.
   * Cloud API reports application errors with HTTP 200 + `Error`.
   */
  async call(action: string, payload: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const entry = CATALOG[action]
    if (!entry) {
      const near = Object.keys(CATALOG).filter((a) => a.toLowerCase().includes(action.toLowerCase())).slice(0, 5)
      throw new AdpError(
        `Unknown action ${action}.${near.length ? ` Did you mean: ${near.join(', ')}?` : ''} Call adp_list_actions.`,
        'UNKNOWN_ACTION',
      )
    }
    const creds = await this.resolveControlCredentials()
    return this.callWith(action, entry, payload, creds, signal)
  }

  async callWith(
    action: string,
    entry: CatalogEntry,
    payload: Record<string, unknown>,
    creds: ControlCredentials,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const fill = this.inject(action, entry, payload)
    const { scheme, host } = entry.hostOverride === 'lke' && !this.config.controlHost
      ? { scheme: 'https' as const, host: HOST_LKE }
      : this.resolveControlEndpoint(creds.secretId)
    let region = entry.region
    if (!region && isCloudAksk(creds.secretId)) region = this.region()
    if (isCloudAksk(creds.secretId) && fill.SpaceId === undefined && action !== 'DescribeSpaceList') {
      fill.SpaceId = this.spaceId()
    }
    const body = JSON.stringify(fill)
    const timestamp = this.clock()
    const headers = buildHeaders({
      secretId: creds.secretId,
      secretKey: creds.secretKey,
      payload: body,
      timestamp,
      host,
      service: entry.service ?? 'adp',
      action,
      version: entry.version,
      region,
    })
    let resp: Response
    try {
      resp = await fetch(`${scheme}://${host}/`, {
        method: 'POST',
        headers,
        body,
        signal,
      })
    } catch (error) {
      if (signal?.aborted) throw error
      throw new AdpError(
        `Could not reach the ADP control plane (${error instanceof Error ? error.name : 'error'})`,
        'TRANSPORT',
        error,
      )
    }
    let parsed: unknown
    try {
      parsed = await resp.json()
    } catch {
      throw new AdpError(`ADP returned a non-JSON response (HTTP ${resp.status})`, 'BAD_RESPONSE')
    }
    const rec = parsed as Record<string, unknown>
    const data = rec.Response && typeof rec.Response === 'object' ? rec.Response as Record<string, unknown> : rec
    const error = data.Error
    if (error && typeof error === 'object') {
      const err = error as Record<string, unknown>
      const code = String(err.Code || 'UnknownError')
      const message = errorWithoutSecret(String(err.Message || ''), creds.secretKey)
      const requestId = data.RequestId ? ` (RequestId ${data.RequestId})` : ''
      throw new AdpError(`${action} failed — ${code}: ${message}${requestId}`, code)
    }
    return data
  }

  private inject(action: string, entry: CatalogEntry, payload: Record<string, unknown>): Record<string, unknown> {
    const out = { ...payload }
    if (entry.inject.includes('AppKey') && !out.AppKey) {
      throw new AdpError(`${action} needs AppKey.`, MISSING_CREDENTIAL)
    }
    if (entry.inject.includes('UserId') && !out.UserId) {
      out.UserId = this.userId()
    }
    return out
  }

  async gatewayFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const key = await this.resolveGatewayKey()
    const url = path.startsWith('http') ? path : `${this.gatewayBaseURL()}${path.startsWith('/') ? path : `/${path}`}`
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${key}`)
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    return fetch(url, { ...init, headers })
  }

  async pluginFetch(url: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const key = await this.resolveGatewayKey()
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(body ?? {}),
      signal,
    })
    const text = await resp.text()
    if (resp.status === 401 || resp.status === 403) {
      throw new AdpError(
        `ADP plugin returned HTTP ${resp.status} (invalid gateway key).`,
        INVALID_CREDENTIAL,
      )
    }
    if (!resp.ok) {
      throw new AdpError(`The plugin returned HTTP ${resp.status}: ${text.slice(0, 200)}`, `HTTP_${resp.status}`)
    }
    return readBody(text)
  }

  async harvest(result: unknown, signal?: AbortSignal): Promise<unknown> {
    return harvestMedia(result, this.workspaceDir(), signal)
  }

  async describePlugin(pluginId: string, signal?: AbortSignal): Promise<PluginDetail> {
    const data = await this.call('DescribePlugin', { PluginId: pluginId }, signal)
    return normalizePluginDetail(pluginId, data)
  }

  async listPluginSummaries(signal?: AbortSignal): Promise<Array<Record<string, unknown>>> {
    const rows: Array<Record<string, unknown>> = []
    let page = 0
    while (true) {
      const data = await this.call(
        'DescribePluginSummaryList',
        { PageNumber: page, PageSize: 50 },
        signal,
      )
      const batch = (data.PluginList as Array<Record<string, unknown>> | undefined) ?? []
      if (batch.length === 0) break
      rows.push(...batch)
      const total = Number(data.TotalCount ?? 0)
      if (total && rows.length >= total) break
      page += 1
      if (page > 40) break
    }
    return rows
  }

  async usablePlugins(concurrency = 16, signal?: AbortSignal): Promise<PluginDetail[]> {
    const summaries = await this.listPluginSummaries(signal)
    const gate = new Semaphore(Math.max(1, concurrency))
    const found = await Promise.all(summaries.map(async (summary) => {
      const pluginId = String(summary.PluginId ?? '')
      if (!pluginId) return undefined
      await gate.acquire()
      try {
        const detail = await this.describePlugin(pluginId, signal)
        if (!isExternallyCallable(detail)) return undefined
        if (!detail.description) {
          detail.description = String((summary.Profile as Record<string, unknown> | undefined)?.Description ?? '')
        }
        return detail
      } catch {
        return undefined
      } finally {
        gate.release()
      }
    }))
    return found.filter((d): d is PluginDetail => d !== undefined)
  }

  async listModels(scene = MODEL_SCENE_AGENT, signal?: AbortSignal): Promise<Array<{ id: string; name: string; contextWindow?: number }>> {
    try {
      const data = await this.call('DescribeModelList', { ModelScene: scene }, signal)
      const models = normalizeModelList(data)
      if (models.length > 0) return models
    } catch (error) {
      if (error instanceof AdpError && error.code === MISSING_CREDENTIAL) {
        return BUILTIN_MODELS.map((m) => ({ ...m }))
      }
    }
    return BUILTIN_MODELS.map((m) => ({ ...m }))
  }
}

class Semaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []
  constructor(private readonly n: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.n) {
      this.active += 1
      return
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
    this.active += 1
  }
  release(): void {
    this.active -= 1
    this.waiters.shift()?.()
  }
}

function paramDecl(raw: Record<string, unknown>): ParamDecl {
  return {
    name: String(raw.Name ?? ''),
    description: String(raw.Description ?? ''),
    type: typeof raw.Type === 'number' ? raw.Type : undefined,
    required: Boolean(raw.IsRequired),
    subParams: Array.isArray(raw.SubParams)
      ? (raw.SubParams as Array<Record<string, unknown>>).filter((s) => s && typeof s === 'object').map(paramDecl)
      : [],
  }
}

export function normalizePluginDetail(pluginId: string, data: Record<string, unknown>): PluginDetail {
  const plugin = (data.Plugin ?? data) as Record<string, unknown>
  const config = (plugin.Config ?? {}) as Record<string, unknown>
  const mcp = (config.MCPPluginConfig ?? undefined) as Record<string, unknown> | undefined
  const operation = (plugin.Operation ?? {}) as Record<string, unknown>
  const profile = (plugin.Profile ?? {}) as Record<string, unknown>
  const mcpUrl = String(mcp?.ExternalMCPServerUrl ?? mcp?.MCPServerUrl ?? '')
  const transport = mcp?.MCPTransport === 1 ? 'streamable-http' : 'sse'
  const apiTools: ApiToolInfo[] = []
  for (const tool of (plugin.ToolList as Array<Record<string, unknown>> | undefined) ?? []) {
    const api = ((tool.ToolConfig as Record<string, unknown> | undefined)?.ApiToolConfig ?? {}) as Record<string, unknown>
    const endpoint = String(api.ExternalApiUrl ?? api.Url ?? '')
    if (!endpoint) continue
    apiTools.push({
      toolId: String(tool.ToolId ?? ''),
      name: String(tool.Name ?? ''),
      description: String(tool.Description ?? ''),
      url: endpoint,
      method: String(api.Method || 'POST'),
      streamMode: Number(api.StreamMode ?? 0),
      body: Array.isArray(api.Body) ? (api.Body as Array<Record<string, unknown>>).map(paramDecl) : [],
    })
  }
  const headers = ((mcp?.PluginHeader as Array<Record<string, unknown>> | undefined) ?? [])
    .concat(((config.PluginHeader as Array<Record<string, unknown>> | undefined) ?? []))
  const needsHeaders = headers
    .filter((h) => h.IsRequired && !h.Value)
    .map((h) => ({ name: String(h.Name ?? '') }))
    .filter((h) => h.name)

  return {
    pluginId,
    name: String(profile.Name ?? plugin.Name ?? pluginId),
    description: String(profile.Description ?? ''),
    kind: typeof plugin.PluginKind === 'number' ? plugin.PluginKind : typeof plugin.Kind === 'number' ? plugin.Kind : undefined,
    mcpUrl,
    mcpTransport: transport,
    apiTools,
    needsHeaders,
    allowExternalAccess: Boolean(operation.AllowExternalAccess),
  }
}

/** Availability is decided by detail URLs + headers, never the list AllowExternalAccess flag. */
export function isExternallyCallable(detail: PluginDetail): boolean {
  if (detail.needsHeaders.length > 0) return false
  return Boolean(detail.mcpUrl) || detail.apiTools.length > 0
}

export const name = 'adp-core'
export const inject = ['credentials']

export function apply(ctx: Context, config: AdpConfig): void {
  ctx.plugin(AdpService, config)
}

export default AdpService
