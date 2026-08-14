import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveRetryPolicy, type RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { AdpAdapter, resolveGatewayApiKey } from './adapter.ts'
import { BUILTIN_MODELS } from '../core/models.ts'

export const name = 'llm-adp'
export const inject = ['llm', 'adp']

export interface Config {
  providers?: string[]
  defaultModel?: string
  apiKeyEnv?: string
  retryPolicy?: RetryPolicyConfig
  streamIdleTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  providers: z.array(z.string()).default(['adp']),
  defaultModel: z.string().default('Hunyuan/hy3'),
  apiKeyEnv: z.string().role('credential-ref'),
  streamIdleTimeoutMs: z.number().min(1).default(300_000),
})

export function apply(ctx: Context, config: Config): void {
  const providers = config.providers?.length ? config.providers : ['adp']
  const adapter = new AdpAdapter({
    adp: () => ctx.adp,
    models: () => ctx.adp.listModels(),
    resolveApiKey: () => resolveGatewayApiKey(ctx.adp, 'llm-adp'),
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-adp: retryPolicy'),
    streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? 300_000,
  })
  ctx.llm.registerAdapter(providers, adapter)
  try {
    ctx.llm.registerConfigurableProviders(providers.map((provider) => ({
      provider,
      displayName: 'Tencent Cloud ADP',
      settingsNs: 'llm-adp',
      settingsPath: [],
    })))
  } catch {
    // Directory registration is optional when settings are absent.
  }
  void BUILTIN_MODELS
}
