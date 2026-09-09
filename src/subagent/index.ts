/**
 * DeepSeek Harness Service Provider for Tencent Cloud ADP HTTP SSE. The plugin
 * registers one named, text-only, one-shot provider on `ctx.subagents`. Each
 * remote ADP request is represented by a real DSH child Agent/session, while
 * `@deepseek-ai/dsh-tool-subagent` remains the model-facing Consumer.
 * @module @tencentcloudadp/dsh-adp/subagent
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import z from '@deepseek-ai/schemastery'
import {
  NO_START_CAPABILITIES,
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import {
  DEFAULT_ADP_ENDPOINT,
  DEFAULT_MAX_EVENT_CHARS,
  DEFAULT_MAX_OUTPUT_CHARS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  type AdpRunSpec,
} from './client.ts'
import { startAdpProxyRun } from './proxy.ts'
import { DEFAULT_MAX_TRACE_CHARS } from './transcript.ts'

export {
  DEFAULT_ADP_ENDPOINT,
  DEFAULT_MAX_EVENT_CHARS,
  DEFAULT_MAX_OUTPUT_CHARS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  consumeAdpStream,
  startAdpRun,
  toAdpContents,
} from './client.ts'
export { startAdpProxyRun } from './proxy.ts'
export { AdpNativeTranscript, DEFAULT_MAX_TRACE_CHARS } from './transcript.ts'
export type { AdpRunSpec } from './client.ts'
export {
  AdpApiError,
  AdpProtocolError,
  AdpResponseFold,
} from './protocol.ts'
export type { AdpChatRequest, AdpTextContent } from './protocol.ts'

/** Cordis plugin name. */
export const name = 'subagent-adp'
/** Provider registration needs subagents; ADP core is reused when already loaded. */
export const inject = ['subagents']

/** Maximum portable `setTimeout` delay. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/** ADP provider deployment configuration. */
export interface Config {
  /** Provider name registered on `ctx.subagents` (default `adp`). */
  providerName?: string
  /** ADP HTTP SSE endpoint; defaults to adp-core's vendor-aware chat URL. */
  endpoint?: string
  /** Credential reference resolved per run (default `TENCENT_ADP_APP_KEY`). */
  appKeyEnv?: string
  /** ADP visitor identity; defaults to the delegating parent session id. */
  visitorId?: string
  /** Optional ADP Agent configuration id. */
  agentId?: string
  /** Optional model override accepted by the ADP application. */
  modelName?: string
  /** Optional deployment-wide ADP system role. */
  systemRole?: string
  /** Optional network-search override. */
  searchNetwork?: 'enable' | 'disable'
  /** Optional workflow override. */
  workflowStatus?: 'enable' | 'disable'
  /** Optional multi-intent switch. */
  enableMultiIntent?: boolean
  /** Characters accumulated by ADP between streamed packets (0 follows ADP configuration). */
  streamingThrottle?: number
  /** Whole-request timeout in milliseconds, including the response stream. */
  requestTimeoutMs?: number
  /** Maximum characters buffered for one SSE event. */
  maxEventChars?: number
  /** Maximum response text retained in memory. */
  maxOutputChars?: number
  /** Maximum ADP reasoning/procedure characters copied to the child session. */
  maxTraceChars?: number
}

/** Schemastery configuration exposed to the Cordis Loader. */
export const Config: z<Config> = z.object({
  providerName: z.string().default('adp'),
  endpoint: z.string(),
  appKeyEnv: z.string().role('credential-ref').default('TENCENT_ADP_APP_KEY'),
  visitorId: z.string(),
  agentId: z.string(),
  modelName: z.string(),
  systemRole: z.string(),
  searchNetwork: z.union(['enable', 'disable'] as const),
  workflowStatus: z.union(['enable', 'disable'] as const),
  enableMultiIntent: z.boolean(),
  streamingThrottle: z.natural().max(100).default(5),
  requestTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_REQUEST_TIMEOUT_MS),
  maxEventChars: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_EVENT_CHARS),
  maxOutputChars: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_OUTPUT_CHARS),
  maxTraceChars: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TRACE_CHARS),
})

type ResolvedConfig = Required<Omit<Config, 'endpoint' | 'visitorId' | 'agentId' | 'modelName' | 'systemRole' | 'searchNetwork' | 'workflowStatus' | 'enableMultiIntent'>>
  & Pick<Config, 'endpoint' | 'visitorId' | 'agentId' | 'modelName' | 'systemRole' | 'searchNetwork' | 'workflowStatus' | 'enableMultiIntent'>
  & { appKeyEnv: string }

interface ValidatedConfig extends ResolvedConfig {
  readonly appKeyRef: CredentialRef
}

async function resolveAppKey(ctx: Context, ref: CredentialRef): Promise<string> {
  const credentials = ctx.get('credentials')
  const value = credentials === undefined
    ? process.env[ref]
    : (await credentials.resolve(ref))?.value
  if (value === undefined || value.length === 0) {
    throw new Error(
      `subagent-adp: no AppKey for ${ref}; store it through the credentials service or export ${ref}`,
    )
  }
  return value
}

class AdpSubagentProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false

  constructor(
    readonly name: string,
    private readonly ctx: Context,
    private readonly config: ValidatedConfig,
  ) {}

  async start(request: ResolvedSubagentStartRequest) {
    const appKey = await resolveAppKey(this.ctx, this.config.appKeyRef)
    if (request.signal.aborted) {
      throw new Error('subagent request was aborted before the ADP request started')
    }
    const spec: AdpRunSpec = {
      endpoint: validateEndpoint(this.config.endpoint ?? this.ctx.get('adp')?.chatUrl() ?? DEFAULT_ADP_ENDPOINT),
      appKey,
      visitorId: this.config.visitorId ?? request.parent.session.id,
      streamingThrottle: this.config.streamingThrottle,
      requestTimeoutMs: this.config.requestTimeoutMs,
      maxEventChars: this.config.maxEventChars,
      maxOutputChars: this.config.maxOutputChars,
      ...(this.config.agentId === undefined ? {} : { agentId: this.config.agentId }),
      ...(this.config.modelName === undefined ? {} : { modelName: this.config.modelName }),
      ...(this.config.systemRole === undefined ? {} : { systemRole: this.config.systemRole }),
      ...(this.config.searchNetwork === undefined ? {} : { searchNetwork: this.config.searchNetwork }),
      ...(this.config.workflowStatus === undefined ? {} : { workflowStatus: this.config.workflowStatus }),
      ...(this.config.enableMultiIntent === undefined ? {} : { enableMultiIntent: this.config.enableMultiIntent }),
      onError: (error, stopReason) => {
        this.ctx.logger.warn(`subagent-adp "${this.name}": remote run failed (${stopReason}): ${error.message}`)
      },
    }
    return startAdpProxyRun(request, spec, this.name, this.config.maxTraceChars)
  }
}

function validateEndpoint(endpoint: string): string {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new TypeError(`subagent-adp: endpoint must be an absolute URL: ${endpoint}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError('subagent-adp: endpoint protocol must be http or https')
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('subagent-adp: endpoint must not contain credentials')
  }
  if (url.hash !== '') throw new TypeError('subagent-adp: endpoint must not contain a fragment')
  return url.href
}

/**
 * Register the ADP provider.
 * @param ctx - Cordis context carrying `ctx.subagents` and optional credentials.
 * @param config - provider, endpoint, ADP request options, and response bounds.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  if (resolved.providerName.length === 0) throw new TypeError('subagent-adp: providerName must not be empty')
  if (resolved.visitorId === '') throw new TypeError('subagent-adp: visitorId must not be empty')
  const validated: ValidatedConfig = {
    ...resolved,
    ...(resolved.endpoint === undefined ? {} : { endpoint: validateEndpoint(resolved.endpoint) }),
    appKeyRef: credentialRef(resolved.appKeyEnv),
  }
  ctx.subagents.registerProvider(new AdpSubagentProvider(validated.providerName, ctx, validated))
}
