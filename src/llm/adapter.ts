import {
  LlmAdapter,
  LlmError,
  assertUsableApiKey,
  attributionHeaders,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { AdpError, INVALID_CREDENTIAL, MISSING_CREDENTIAL } from '../core/errors.ts'
import { BUILTIN_MODELS } from '../core/models.ts'
import type { AdpService } from '../core/service.ts'
import { httpErrorCode, serializeRequest } from './serialize.ts'
import { parseSse, translate } from './sse.ts'

const STREAM_IDLE = 'LLM_STREAM_IDLE_TIMEOUT'
const DEFAULT_IDLE_MS = 300_000
const DEFAULT_CONTEXT = 256_000

export interface AdpAdapterHooks {
  adp: () => AdpService
  models: () => Promise<Array<{ id: string; name: string; contextWindow?: number }>>
  resolveApiKey: () => Promise<string>
  retryPolicy: ResolvedRetryPolicy
  streamIdleTimeoutMs: number
}

export class AdpAdapter extends LlmAdapter {
  constructor(private readonly hooks: AdpAdapterHooks) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Tencent Cloud ADP' }
  }

  override providerRetryPolicy(): ResolvedRetryPolicy {
    return this.hooks.retryPolicy
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await this.hooks.models()
    const list = models.length > 0 ? models : BUILTIN_MODELS
    return list.map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: ['text' as const],
    }))
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const models = await this.hooks.models().catch(() => [...BUILTIN_MODELS])
    const configured = models.find((m) => m.id === model)
    return {
      provider,
      id: model,
      name: configured?.name ?? model,
      inputModalities: ['text'],
      context: { contextWindow: configured?.contextWindow ?? DEFAULT_CONTEXT },
    }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const apiKey = await this.hooks.resolveApiKey()
    const adp = this.hooks.adp()
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(upstream, this.hooks.streamIdleTimeoutMs, STREAM_IDLE)
    const iterator = this.request(options, watchdog.signal, adp, apiKey, () => watchdog.pulse())[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        const result = await watchdog.next(iterator)
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE) !== undefined) {
        throw new LlmError(`ADP stream idle timeout after ${this.hooks.streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error })
      }
      if (options.signal?.aborted) {
        throw new LlmError('ADP request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(`ADP API stream from ${adp.gatewayBaseURL()} failed`, 'TRANSPORT', { cause: error })
    } finally {
      consumer.abort('ADP stream consumer stopped')
      if (!exhausted && iterator.return) {
        try { await iterator.return() } catch { /* teardown */ }
      }
    }
  }

  private async * request(
    options: GenerateOptions,
    signal: AbortSignal,
    adp: AdpService,
    apiKey: string,
    onComment: () => void,
  ): AsyncIterable<StreamChunk> {
    const payload = JSON.stringify(serializeRequest(options))
    const headers = {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...attributionHeaders(),
    }
    let response: Response
    try {
      response = await fetch(`${adp.gatewayBaseURL()}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: payload,
        signal,
      })
    } catch (error: unknown) {
      if (signal.aborted) throw error
      throw new LlmError(`ADP API request to ${adp.gatewayBaseURL()} failed`, 'TRANSPORT', { cause: error })
    }
    if (!response.ok) {
      let message = `ADP API error (HTTP ${response.status})`
      try {
        const parsed = await response.json() as { error?: { message?: string } }
        if (parsed.error?.message) message = parsed.error.message.replace(apiKey, '***')
      } catch { /* status is enough */ }
      throw new LlmError(message, httpErrorCode(response.status), { status: response.status })
    }
    if (!response.body) throw new LlmError('ADP API returned no response body', 'EMPTY_RESPONSE')
    yield* translate(parseSse(response.body, onComment))
  }
}

export async function resolveGatewayApiKey(
  adp: AdpService,
  pkg: string,
): Promise<string> {
  try {
    const raw = await adp.resolveGatewayKey()
    return assertUsableApiKey(raw, pkg, adp.gatewayKeyRef())
  } catch (error) {
    if (error instanceof AdpError && error.code === MISSING_CREDENTIAL) {
      throw new LlmError(error.message, MISSING_CREDENTIAL)
    }
    if (error instanceof AdpError && error.code === INVALID_CREDENTIAL) {
      throw new LlmError(error.message, INVALID_CREDENTIAL)
    }
    if (error instanceof LlmError) throw error
    throw error
  }
}

export { resolveRetryPolicy }
