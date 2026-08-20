import { describe, expect, it } from 'vitest'
import { en, resolveAdpLocale, t, zh } from '../../src/client/locales.ts'

describe('adp locales', () => {
  it('zh and en share the same keys', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })

  it('maps zh-CN and zh_CN to Chinese', () => {
    expect(resolveAdpLocale('zh-CN')).toBe('zh')
    expect(resolveAdpLocale('zh_CN')).toBe('zh')
    expect(t('zh-CN', 'save')).toBe('保存')
    expect(t('zh_CN', 'title')).toBe('腾讯云 ADP')
  })

  it('falls back to English for unknown locales', () => {
    expect(resolveAdpLocale('fr')).toBe('en')
    expect(resolveAdpLocale(undefined)).toBe('en')
    expect(t('ja-JP', 'save')).toBe('Save')
    expect(t(undefined, 'title')).toBe('Tencent Cloud ADP')
  })

  it('keeps OneID copy honest in both languages', () => {
    expect(t('en', 'oneidPopupBlocked')).toMatch(/will not fill the keys/)
    expect(t('zh', 'oneidPopupBlocked')).toMatch(/都不会填入下方钥匙/)
    expect(t('zh', 'siteStandalone')).toBe('独立站')
    expect(t('zh', 'siteCloud')).toBe('公有云')
    expect(t('en', 'siteHintStandalone')).toMatch(/not the 26-character AKSK/)
    expect(t('zh', 'spaceTitle')).toBe('工作空间')
    expect(t('en', 'spaceHint')).toMatch(/4510004/)
  })

  it('interpolates {name} placeholders', () => {
    expect(t('zh', 'expandAria', { name: '腾讯云 ADP' })).toBe('展开：{name}'.replace('{name}', '腾讯云 ADP'))
    expect(t('en', 'envLocked', { ref: 'ADP_API_KEY' })).toContain('ADP_API_KEY')
  })

  it('field help copy names the real console paths in both languages', () => {
    expect(t('zh', 'helpApiKey')).toContain('DeepSeek API')
    expect(t('en', 'helpApiKey')).toContain('DeepSeek API')
    expect(t('zh', 'helpSecretIdStandalone')).toContain('26')
    expect(t('en', 'helpSecretIdCloud')).toContain('AKID')
    expect(t('zh', 'helpSecretKeyCloud')).toContain('仅展示一次')
    expect(t('en', 'helpAppKey')).toMatch(/API Management/)
  })
})
