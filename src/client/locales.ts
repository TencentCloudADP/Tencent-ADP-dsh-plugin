/** Dictionary namespace registered on DSH `ctx.locale` for the ADP credentials card. */
export const ADP_LOCALE_NS = 'settings.plugins.adp'

/** Locale ids DSH ships (`LocaleId`); `zh-CN` / `zh_CN` normalize to `zh`. */
export type AdpLocaleId = 'zh' | 'en'

export type AdpLocaleKey = keyof typeof en

export type Translate = (key: AdpLocaleKey, params?: Record<string, unknown>) => string

/** English copy. */
export const en = {
  title: 'Tencent Cloud ADP',
  description: 'Gateway, AKSK, and optional AppKey',
  unsaved: 'Unsaved',
  expandAria: 'Expand: {name}',
  collapseAria: 'Collapse: {name}',
  oneidTitle: 'OneID',
  oneidStart: 'Open ADP console',
  oneidStarting: 'Opening ADP console…',
  oneidPopupBlocked:
    'The browser blocked the new tab. After the console link appears, use that instead. Either way, OneID will not fill the keys below.',
  siteTitle: 'Site',
  siteStandalone: 'Independent site',
  siteCloud: 'Tencent Cloud',
  siteHintStandalone:
    'Control plane: capi.adp.tencent.com (ADP console SecretId/SecretKey). Chat SSE: adp.tencent.com. The model gateway is still api.adp.cloud.tencent.com and needs a gateway API key (usually sk-), not the 26-character AKSK.',
  siteHintCloud:
    'Control plane: adp.tencentcloudapi.com (CAM AKID SecretId/SecretKey). Chat SSE: wss.lke.cloud.tencent.com. Gateway sk- still goes to api.adp.cloud.tencent.com.',
  siteSaving: 'Switching site…',
  manualTitle: 'Manual keys',
  loopbackHint: 'Credential writes are loopback-only. Open this UI on 127.0.0.1 to save keys.',
  optionalSuffix: ' (optional)',
  stateMissing: 'missing',
  stateEnv: 'from env',
  stateSaved: 'saved',
  clear: 'Clear',
  placeholderKeep: 'leave blank to keep the stored key',
  placeholderPaste: 'paste a new value',
  envLocked: '{ref} is set in the environment, so this field is not writable.',
  hintApiKey: 'Gateway sk- key. Drives models, Hunyuan search, and API/MCP plugin calls.',
  hintSecretId: 'Control-plane SecretId (AKSK). Needed to list plugins, apps, and models.',
  hintSecretKey: 'Control-plane SecretKey. Pair with SecretId; it cannot replace the gateway sk-.',
  hintAppKey: 'Optional default AppKey for SSE ask tools. Per-app keys still bind on agents-adp.',
  discard: 'Discard',
  save: 'Save',
  saving: 'Saving…',
} as const satisfies Record<string, string>

/** Simplified Chinese copy (DSH language id `zh`). */
export const zh = {
  title: '腾讯云 ADP',
  description: '网关、AKSK，以及可选的 AppKey',
  unsaved: '未保存',
  expandAria: '展开：{name}',
  collapseAria: '收起：{name}',
  oneidTitle: 'OneID',
  oneidStart: '打开 ADP 控制台',
  oneidStarting: '正在打开 ADP 控制台…',
  oneidPopupBlocked:
    '浏览器拦截了新标签页。等控制台链接出现后请点那个链接。无论标签页是否打开，OneID 都不会填入下方钥匙。',
  siteTitle: '站点',
  siteStandalone: '独立站',
  siteCloud: '公有云',
  siteHintStandalone:
    '控制面走 capi.adp.tencent.com（ADP 控制台的 SecretId/SecretKey）。对话 SSE 走 adp.tencent.com。模型网关仍是 api.adp.cloud.tencent.com，需要网关 API Key（一般是 sk-），不是 26 位 AKSK。',
  siteHintCloud:
    '控制面走 adp.tencentcloudapi.com（CAM 的 AKID SecretId/SecretKey）。对话 SSE 走 wss.lke.cloud.tencent.com。网关 sk- 仍打 api.adp.cloud.tencent.com。',
  siteSaving: '正在切换站点…',
  manualTitle: '手动填写钥匙',
  loopbackHint: '只有本机回环地址可以写入钥匙。请在 127.0.0.1 打开此界面再保存。',
  optionalSuffix: '（可选）',
  stateMissing: '未配置',
  stateEnv: '来自环境变量',
  stateSaved: '已保存',
  clear: '清除',
  placeholderKeep: '留空表示保持已保存的钥匙',
  placeholderPaste: '粘贴新值',
  envLocked: '{ref} 已在环境变量中设置，此栏不可改。',
  hintApiKey: '网关 sk- 钥匙。模型、混元搜索，以及 API/MCP 插件调用都走它。',
  hintSecretId: '控制面 SecretId（AKSK）。列出插件、应用和模型时需要。',
  hintSecretKey: '控制面 SecretKey。与 SecretId 成对使用；不能代替网关 sk-。',
  hintAppKey: '可选的默认 AppKey，供 SSE 问答工具使用。按应用的钥匙仍在 agents-adp 上绑定。',
  discard: '放弃修改',
  save: '保存',
  saving: '保存中…',
} as const satisfies Record<AdpLocaleKey, string>

const DICTS: Record<AdpLocaleId, Record<AdpLocaleKey, string>> = { en, zh }

const PARAM = /\{(\w+)\}/g

/**
 * Map a language tag onto DSH's `zh` / `en`. Unknown tags fall back to English.
 * `zh-CN`, `zh_CN`, and `zh-Hans` all resolve to `zh`.
 */
export function resolveAdpLocale(tag: string | undefined | null): AdpLocaleId {
  if (!tag) return 'en'
  const primary = tag.trim().toLowerCase().replaceAll('_', '-').split('-')[0]
  if (primary === 'zh') return 'zh'
  return 'en'
}

function interpolate(template: string, params?: Record<string, unknown>): string {
  if (!params) return template
  return template.replace(PARAM, (match, name: string) => (name in params ? String(params[name]) : match))
}

/**
 * Catalog lookup used in tests and as a fallback when the host has not injected
 * `t`. Live DSH web uses `ctx.locale.bind` / the slot `t` seat instead.
 */
export function t(locale: string | undefined | null, key: AdpLocaleKey, params?: Record<string, unknown>): string {
  const dict = DICTS[resolveAdpLocale(locale)]
  return interpolate(dict[key] ?? en[key] ?? key, params)
}

export const dictionaries: Record<AdpLocaleId, Record<AdpLocaleKey, string>> = DICTS
