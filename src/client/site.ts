export const PROXY_SITE_PATH = '/adp/site'

export type SiteVendor = 'ChinaTencentADP' | 'ChinaTencentCloud'

export type SiteResult =
  | { ok: true; vendor: SiteVendor }
  | { ok: false; error: string }

export function parseSiteBody(status: number, text: string): SiteResult {
  const trimmed = text.trim()
  if (!trimmed) {
    return { ok: false, error: `Site proxy returned HTTP ${status} with an empty body.` }
  }
  try {
    const parsed = JSON.parse(trimmed) as { ok?: boolean; vendor?: string; error?: string }
    if (parsed.ok === true && (parsed.vendor === 'ChinaTencentADP' || parsed.vendor === 'ChinaTencentCloud')) {
      return { ok: true, vendor: parsed.vendor }
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

export async function saveSiteVendor(vendor: SiteVendor): Promise<SiteResult> {
  try {
    const response = await fetch(PROXY_SITE_PATH, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ vendor }),
    })
    return await readSiteResponse(response)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
