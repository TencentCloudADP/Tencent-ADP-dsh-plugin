export const PROXY_SITE_PATH = '/adp/site'

export type SiteVendor = 'ChinaTencentADP' | 'ChinaTencentCloud'

export type SiteSpace = { id: string; name: string }

export type SiteResult =
  | { ok: true; vendor: SiteVendor; spaceId: string; spaces: SiteSpace[] }
  | { ok: false; error: string }

function parseSpaces(raw: unknown): SiteSpace[] {
  if (!Array.isArray(raw)) return []
  const out: SiteSpace[] = []
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const rec = row as Record<string, unknown>
    const id = String(rec.id ?? '').trim()
    if (!id) continue
    out.push({ id, name: String(rec.name ?? id) })
  }
  return out
}

export function parseSiteBody(status: number, text: string): SiteResult {
  const trimmed = text.trim()
  if (!trimmed) {
    return { ok: false, error: `Site proxy returned HTTP ${status} with an empty body.` }
  }
  try {
    const parsed = JSON.parse(trimmed) as {
      ok?: boolean
      vendor?: string
      spaceId?: unknown
      spaces?: unknown
      error?: string
    }
    if (parsed.ok === true && (parsed.vendor === 'ChinaTencentADP' || parsed.vendor === 'ChinaTencentCloud')) {
      return {
        ok: true,
        vendor: parsed.vendor,
        spaceId: typeof parsed.spaceId === 'string' ? parsed.spaceId : '',
        spaces: parseSpaces(parsed.spaces),
      }
    }
    return { ok: false, error: parsed.error || `Site proxy returned HTTP ${status}.` }
  } catch {
    return { ok: false, error: `Site proxy returned HTTP ${status} with non-JSON content.` }
  }
}

export async function readSiteResponse(response: Response): Promise<SiteResult> {
  return parseSiteBody(response.status, await response.text())
}

export async function fetchSiteVendor(): Promise<SiteResult> {
  try {
    const response = await fetch(PROXY_SITE_PATH, { method: 'GET', headers: { accept: 'application/json' } })
    return await readSiteResponse(response)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function saveSiteSettings(patch: { vendor?: SiteVendor; spaceId?: string }): Promise<SiteResult> {
  const body: Record<string, string> = {}
  if (patch.vendor) body.vendor = patch.vendor
  if (patch.spaceId !== undefined) body.spaceId = patch.spaceId
  try {
    const response = await fetch(PROXY_SITE_PATH, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return await readSiteResponse(response)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function saveSiteVendor(vendor: SiteVendor): Promise<SiteResult> {
  return saveSiteSettings({ vendor })
}
