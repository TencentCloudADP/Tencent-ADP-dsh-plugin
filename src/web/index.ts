import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import type { ToolResult, WebSearchResultView } from '@deepseek-ai/dsh-tools'
import { AdpError, INVALID_CREDENTIAL, MISSING_CREDENTIAL } from '../core/errors.ts'
import { lastSseAnswer } from '../core/sse.ts'
import type { AdpService } from '../core/service.ts'

export const ADP_SEARCH_PROVIDER_ID = 'adp'

export class AdpSearchProvider implements WebSearchProvider {
  readonly id = ADP_SEARCH_PROVIDER_ID

  constructor(private readonly adp: () => AdpService) {}

  available(): boolean {
    return true
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const adp = this.adp()
    let body: unknown
    try {
      body = await adp.pluginFetch(adp.hunyuanSearchUrl(), { Query: request.query }, signal)
    } catch (error) {
      if (error instanceof AdpError && (error.code === MISSING_CREDENTIAL || error.code === INVALID_CREDENTIAL)) {
        throw error
      }
      throw error
    }
    if (!body || typeof body !== 'object') {
      return { sources: [], truncated: false }
    }
    const rec = body as Record<string, unknown>
    if (rec.Code !== 0 && rec.Code !== undefined && rec.Code !== null) {
      throw new AdpError(`ADP search: ${String(rec.Msg ?? rec.Code)}`, 'SEARCH_FAILED')
    }
    const data = (rec.Data && typeof rec.Data === 'object' ? rec.Data : rec) as Record<string, unknown>
    const answer = lastSseAnswer(body) ?? (typeof data.Answer === 'string' ? data.Answer : undefined)
    const refs = Array.isArray(data.References) ? data.References as Array<Record<string, unknown>> : []
    const sources: WebSearchSource[] = refs
      .filter((ref) => ref.Url)
      .map((ref) => ({
        url: String(ref.Url),
        ...ref.Title ? { title: String(ref.Title) } : {},
      }))
    return {
      ...answer ? { content: answer } : {},
      sources,
      truncated: false,
    }
  }
}

/** Replayable web/search card — matches dsh-tool-web presentSearchResult. */
export function presentAdpSearchResult(
  args: { query: string },
  result: ToolResult,
): WebSearchResultView | undefined {
  if (result.isError) return undefined
  const meta = result.meta
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined
  const rec = meta as Record<string, unknown>
  if (!Array.isArray(rec.sources)) return undefined
  return {
    card: 'web',
    kind: 'search',
    title: args.query,
    sources: rec.sources as WebSearchResultView['sources'],
    truncated: Boolean(rec.truncated),
    ...typeof rec.answer === 'string' ? { answer: rec.answer } : {},
  }
}

export const name = 'web-adp'
export const inject = ['web', 'adp']

export interface Config {
  apiKeyEnv?: string
}

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref'),
})

export function apply(ctx: Context, _config: Config): void {
  ctx.web.registerSearchProvider(new AdpSearchProvider(() => ctx.adp))
}
