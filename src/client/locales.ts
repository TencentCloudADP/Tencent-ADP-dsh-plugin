/** Dictionary namespace registered on DSH `ctx.locale` for the ADP credentials card. */
export const ADP_LOCALE_NS = 'settings.plugins.adp'

/** Locale ids DSH ships (`LocaleId`); `zh-CN` / `zh_CN` normalize to `zh`. */
export type AdpLocaleId = 'zh' | 'en'

export type AdpLocaleKey = keyof typeof en

export type Translate = (key: AdpLocaleKey, params?: Record<string, unknown>) => string

/** English copy. */
export const en = {
  title: 'Tencent Cloud ADP',
  description: 'Tool Key, API key, and optional AppKey',
  unsaved: 'Unsaved',
  expandAria: 'Expand: {name}',
  collapseAria: 'Collapse: {name}',
  siteTitle: 'Site',
  siteStandalone: 'Independent site',
  siteCloud: 'Tencent Cloud',
  spaceTitle: 'Workspace',
  spaceHint:
    'Public-cloud apps and marketplace plugins need a real SpaceId. The patch default default_space is not a workspace on most accounts (control-plane 4510004).',
  spaceEmpty: 'No workspaces listed. Paste a SpaceId from the ADP console.',
  spacePlaceholder: 'SpaceId',
  spaceApply: 'Use this workspace',
  loopbackHint: 'Credential writes are loopback-only. Open this UI on 127.0.0.1 to save keys.',
  optionalSuffix: ' (optional)',
  stateMissing: 'missing',
  stateEnv: 'from env',
  stateSaved: 'saved',
  clear: 'Clear',
  placeholderKeep: 'leave blank to keep the stored key',
  placeholderPaste: 'paste a new value',
  envLocked: '{ref} is set in the environment, so this field is not writable.',
  hintApiKey: 'Tool key for models, Hunyuan search, and API/MCP plugin calls.',
  hintSecretId: 'Control-plane SecretId (AKSK). Needed to list plugins, apps, and models.',
  hintSecretKey: 'Control-plane SecretKey. Pair it with SecretId.',
  hintAppKey: 'Optional default AppKey for SSE ask tools. Per-app keys still bind on agents-adp.',
  discard: 'Discard',
  save: 'Save',
  saving: 'Saving…',
  helpAria: 'How to get {ref}',
  helpGo: 'Go get it',
  helpApiKeyStandalone: 'Open Key Management and create a Tool Key in the upper section.',
  helpApiKeyCloud: 'Open Key Management and click Create Tool Key in the upper section.',
  helpSecretIdStandalone: 'Open Key Management and create an API Key in the lower section; copy its Secret_ID.',
  helpSecretIdCloud: 'Open CAM → API Key Management → Create: copy the AKID… SecretId.',
  helpSecretKeyStandalone: 'Open Key Management and create an API Key in the lower section; copy its Secret_Key.',
  helpSecretKeyCloud: 'Open CAM → API Key Management → Create: copy the SecretKey shown once at creation.',
  helpAppKey: 'Publish the app first, then App Publish → Service Status → API Management: copy the AppKey.',
} as const satisfies Record<string, string>

/** Simplified Chinese copy (DSH language id `zh`). */
export const zh = {
  title: '腾讯云 ADP',
  description: '工具密钥、API 密钥，以及可选的 AppKey',
  unsaved: '未保存',
  expandAria: '展开：{name}',
  collapseAria: '收起：{name}',
  siteTitle: '站点',
  siteStandalone: '独立站',
  siteCloud: '公有云',
  spaceTitle: '工作空间',
  spaceHint:
    '公有云的应用和插件市场需要真实的 SpaceId。补丁默认的 default_space 在多数账号上不是工作空间（控制面 4510004）。',
  spaceEmpty: '没有列出工作空间。请粘贴 ADP 控制台里的 SpaceId。',
  spacePlaceholder: 'SpaceId',
  spaceApply: '使用此工作空间',
  loopbackHint: '只有本机回环地址可以写入钥匙。请在 127.0.0.1 打开此界面再保存。',
  optionalSuffix: '（可选）',
  stateMissing: '未配置',
  stateEnv: '来自环境变量',
  stateSaved: '已保存',
  clear: '清除',
  placeholderKeep: '留空表示保持已保存的钥匙',
  placeholderPaste: '粘贴新值',
  envLocked: '{ref} 已在环境变量中设置，此栏不可改。',
  hintApiKey: '工具密钥，用于模型、混元搜索以及 API/MCP 插件调用。',
  hintSecretId: '控制面 SecretId（AKSK）。列出插件、应用和模型时需要。',
  hintSecretKey: '控制面 SecretKey，与 SecretId 成对使用。',
  hintAppKey: '可选的默认 AppKey，供 SSE 问答工具使用。按应用的钥匙仍在 agents-adp 上绑定。',
  discard: '放弃修改',
  save: '保存',
  saving: '保存中…',
  helpAria: '如何获取 {ref}',
  helpGo: '前往获取',
  helpApiKeyStandalone: '打开密钥管理，在上方新建“工具密钥”。',
  helpApiKeyCloud: '打开密钥管理，在上方点击“新建工具密钥”。',
  helpSecretIdStandalone: '打开密钥管理，在下方新建“API 密钥”，复制其中的 Secret_ID。',
  helpSecretIdCloud: '打开 CAM → API密钥管理 → 新建密钥：复制 AKID 开头的 SecretId。',
  helpSecretKeyStandalone: '打开密钥管理，在下方新建“API 密钥”，复制其中的 Secret_Key。',
  helpSecretKeyCloud: '打开 CAM → API密钥管理 → 新建密钥：复制创建时仅展示一次的 SecretKey。',
  helpAppKey: '先发布应用，再打开 应用发布 → 服务状态 → API管理：复制 AppKey。',
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
