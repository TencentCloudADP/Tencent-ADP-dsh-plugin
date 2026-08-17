export const HOST_ADP = 'capi.adp.tencent.com'
export const HOST_CLOUD = 'adp.tencentcloudapi.com'
export const HOST_INTL = 'adp.intl.tencentcloudapi.com'
export const HOST_LKE = 'lke.tencentcloudapi.com'

export const GATEWAY_BASE_URL = 'https://api.adp.cloud.tencent.com'
/** Completions path on the ADP model gateway. Not `/v1/chat/completions` — that host returns 401 `not_authorized`. */
export const GATEWAY_CHAT_PATH = '/chat/completions'
export const PLUGIN_API_BASE = 'https://adp.cloud.tencent.com'
export const PLUGIN_API_BASE_STANDALONE = 'https://adp.tencent.com'
export const SSE_URL_CN = 'https://wss.lke.cloud.tencent.com/adp/v2/chat'
export const SSE_URL_STANDALONE = 'https://adp.tencent.com/adp/v2/chat'
export const SSE_URL_INTL = 'https://wss.lke.tencentcloud.com/adp/v2/chat'
export const ACCOUNT_HOST_STANDALONE = 'https://adp.tencent.com'
export const ACCOUNT_HOST_CLOUD = 'https://adp.cloud.tencent.com'

export const HUNYUAN_SEARCH_PLUGIN_ID = 'fbd411cd-dcd8-4351-9fe9-ca9491cc778f'
export const HUNYUAN_SEARCH_TOOL_ID = '16bfcfea-2ed8-4c00-b73d-3c1757d3d843'

export type AdpVendor = 'ChinaTencentADP' | 'ChinaTencentCloud' | 'International'

export const VENDOR_HOST: Record<AdpVendor, string> = {
  ChinaTencentADP: HOST_ADP,
  ChinaTencentCloud: HOST_CLOUD,
  International: HOST_INTL,
}

export function isCloudAksk(secretId: string): boolean {
  return (secretId || '').trim().toUpperCase().startsWith('AKID')
}

export function hostForVendor(vendor: AdpVendor | undefined, secretId: string): string {
  if (vendor && vendor in VENDOR_HOST) return VENDOR_HOST[vendor]
  return isCloudAksk(secretId) ? HOST_CLOUD : HOST_ADP
}

export function chatUrlForVendor(vendor: AdpVendor | undefined): string {
  if (vendor === 'International') return SSE_URL_INTL
  if (vendor === 'ChinaTencentADP') return SSE_URL_STANDALONE
  return SSE_URL_CN
}

export function pluginBaseForVendor(vendor: AdpVendor | undefined): string {
  return vendor === 'ChinaTencentADP' ? PLUGIN_API_BASE_STANDALONE : PLUGIN_API_BASE
}

export function accountHostForVendor(vendor: AdpVendor | undefined): string {
  return vendor === 'ChinaTencentADP' ? ACCOUNT_HOST_STANDALONE : ACCOUNT_HOST_CLOUD
}

/** UI choice: independent site vs Tencent Cloud public console. International stays composition-only. */
export type SiteVendor = 'ChinaTencentADP' | 'ChinaTencentCloud'

export function parseSiteVendor(value: unknown): SiteVendor | undefined {
  if (value === 'ChinaTencentADP' || value === 'ChinaTencentCloud') return value
  return undefined
}

export function siteVendorFromConfig(vendor: AdpVendor | undefined): SiteVendor {
  return vendor === 'ChinaTencentCloud' ? 'ChinaTencentCloud' : 'ChinaTencentADP'
}

export function hunyuanSearchUrl(pluginBase = PLUGIN_API_BASE): string {
  return `${pluginBase.replace(/\/$/, '')}/plugin/api/v1/${HUNYUAN_SEARCH_PLUGIN_ID}/${HUNYUAN_SEARCH_TOOL_ID}`
}
