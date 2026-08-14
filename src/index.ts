import type { Context } from '@deepseek-ai/cordis'
import { registerAdpWebRoutes } from './account.ts'
import { registerSiteSettings } from './site.ts'
import { AdpService, apply as applyCore, type AdpConfig } from './core/service.ts'
export { AdpService, Config, name, inject, isExternallyCallable, normalizePluginDetail } from './core/service.ts'
export type { AdpConfig, AdpVendor, PluginDetail, ApiToolInfo, ParamDecl } from './core/service.ts'
export { AdpError, MISSING_CREDENTIAL, INVALID_CREDENTIAL } from './core/errors.ts'
export { signRequest, buildHeaders, canonicalRequest, stringToSign } from './core/signing.ts'
export { readBody, lastSseAnswer, unwrapAccountPayload } from './core/sse.ts'
export { harvestMedia, extractUrls, looksLikeMedia } from './core/media.ts'
export { CATALOG, MUTATING, NEVER_WHITELIST, APP_AGENT_RELEASE_MUTATING, catalogList } from './core/catalog.ts'
export {
  HOST_ADP,
  HOST_CLOUD,
  HOST_INTL,
  GATEWAY_BASE_URL,
  hunyuanSearchUrl,
  hostForVendor,
  chatUrlForVendor,
  pluginBaseForVendor,
  accountHostForVendor,
  parseSiteVendor,
  siteVendorFromConfig,
  isCloudAksk,
} from './core/hosts.ts'
export { BUILTIN_MODELS, MODEL_SCENE_AGENT, MODEL_SCENE_CLAW } from './core/models.ts'
export {
  ACCOUNT_HOST,
  COOKIE_TOKEN,
  LOGIN_PLATFORM,
  fetchLoginUrl,
  landingHost,
  registerAdpWebRoutes,
} from './account.ts'
export type { LoginUrlResult } from './account.ts'
export {
  PROXY_SITE_PATH,
  ADP_SITE_SETTINGS_NS,
  SiteConfig,
  handleSite,
  applySiteVendor,
  registerSiteSettings,
} from './site.ts'

/**
 * Core service plus optional same-origin account/icon routes when `webServer`
 * is present. This module must not default-export the `AdpService` class:
 * `Loader.unwrapExports` would pick the class, Cordis would construct it, and
 * this `apply` (which registers `/adp/account/login-url`) would never run.
 */
export function apply(ctx: Context, config: AdpConfig): void {
  applyCore(ctx, config)
  ctx.inject(['settings'], (settingsCtx) => {
    registerSiteSettings(settingsCtx, config.vendor)
  })
  ctx.inject(['webServer'], (webCtx) => {
    registerAdpWebRoutes(webCtx)
  })
}
