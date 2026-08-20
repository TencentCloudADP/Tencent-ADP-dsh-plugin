import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Button, IconChevronDownOutline14, Input, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { AdpIcon } from './AdpIcon.tsx'
import { t as catalogT, type AdpLocaleKey, type Translate } from './locales.ts'
import { fetchLoginUrlProxy } from './loginUrl.ts'
import { fetchSiteVendor, saveSiteSettings, type SiteSpace, type SiteVendor } from './site.ts'

const STYLE_ID = 'adp-dsh-credentials-card'
const CSS = `
.adp-dsh-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}
.adp-dsh-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.adp-dsh-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.adp-dsh-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.adp-dsh-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.adp-dsh-mark{flex:none;display:flex}
.adp-dsh-headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.adp-dsh-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.adp-dsh-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.adp-dsh-pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.adp-dsh-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}
.adp-dsh-chevronOpen{transform:rotate(180deg)}
.adp-dsh-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding:12px 0 8px;display:flex;flex-direction:column;gap:16px}
.adp-dsh-sectionTitle{color:var(--dsw-alias-label-primary);margin:0;font-size:13px;font-weight:600;line-height:1.5}
.adp-dsh-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}
.adp-dsh-error{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}
.adp-dsh-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}
.adp-dsh-field+.adp-dsh-field{border-top:1px solid var(--dsw-alias-border-l2)}
.adp-dsh-fieldHead{align-items:center;gap:8px;display:flex}
.adp-dsh-labelGroup{min-width:0;flex:1;display:flex;align-items:center;gap:6px}
.adp-dsh-label{min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}
.adp-dsh-badges{align-items:center;gap:8px;display:inline-flex}
.adp-dsh-badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px;display:inline-flex;align-items:center;gap:6px}
.adp-dsh-footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}
.adp-dsh-oneid{display:flex;flex-direction:column;gap:8px}
.adp-dsh-oneidAnchor{align-self:flex-start;display:inline-flex;align-items:center;justify-content:center;text-decoration:none;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);background:transparent;border-radius:8px;padding:5px 10px;font:inherit;font-size:13px;line-height:1.4;cursor:pointer}
.adp-dsh-oneidAnchor:hover{border-color:var(--dsw-alias-label-dimmed)}
.adp-dsh-oneidAnchor:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.adp-dsh-site{display:flex;flex-direction:column;gap:8px}
.adp-dsh-siteRow{display:flex;gap:8px}
.adp-dsh-siteBtn{appearance:none;font:inherit;cursor:pointer;flex:1;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:8px 10px;font-size:13px;line-height:1.4}
.adp-dsh-siteBtn:hover{border-color:var(--dsw-alias-label-dimmed)}
.adp-dsh-siteBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.adp-dsh-siteBtnActive{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-module-platform)}
.adp-dsh-siteBtn:disabled{cursor:default;opacity:.7}
.adp-dsh-spaceSelect,.adp-dsh-spaceInput{appearance:none;font:inherit;color:inherit;width:100%;border:1px solid var(--dsw-alias-border-l2);background:transparent;border-radius:8px;padding:8px 10px;font-size:13px;line-height:1.4}
.adp-dsh-spaceSelect:focus-visible,.adp-dsh-spaceInput:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.adp-dsh-spaceRow{display:flex;gap:8px;align-items:center}
.adp-dsh-helpWrap{position:relative;display:inline-flex;flex:none;padding:6px;margin:-6px}
.adp-dsh-helpBtn{appearance:none;font:inherit;cursor:pointer;width:16px;height:16px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:14px;padding:0;display:inline-flex;align-items:center;justify-content:center;flex:none}
.adp-dsh-helpBtn:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.adp-dsh-helpBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.adp-dsh-helpBubble{position:absolute;top:calc(100% + 6px);left:0;z-index:10;width:280px;max-width:min(280px,calc(100vw - 48px));background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px 12px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);box-shadow:0 4px 12px rgba(0,0,0,.12);white-space:normal;text-align:left}
.adp-dsh-helpBubble::before{content:'';position:absolute;top:-10px;left:0;right:0;height:10px}
.adp-dsh-helpBubble a{color:var(--dsw-alias-brand-primary);text-decoration:none;font-weight:500;display:inline-block;margin-top:6px}
.adp-dsh-helpBubble a:hover{text-decoration:underline}
`

function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`)) return
  const tag = document.createElement('style')
  tag.dataset.plugin = '@tencent/dsh-adp'
  tag.dataset.pluginCss = STYLE_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}

export interface CredentialView {
  configured: boolean
  writable: boolean
  source?: string
}

export interface CredentialsApi {
  describe(payload: { refs: string[] }): Promise<{
    result:
      | { ok: true; value: { credentials: Record<string, CredentialView> } }
      | { ok: false; error: { code: string; message: string } }
  }>
  set(payload: { ref: string; value: string }): Promise<{
    result: { ok: true; value: Record<string, never> } | { ok: false; error: { code: string; message: string } }
  }>
  unset(payload: { ref: string }): Promise<{
    result: { ok: true; value: Record<string, never> } | { ok: false; error: { code: string; message: string } }
  }>
}

export interface ConnectionFace {
  api: { credentials: CredentialsApi }
  isLoopback: boolean
}

const REFS = ['ADP_API_KEY', 'ADP_SECRET_ID', 'ADP_SECRET_KEY', 'ADP_APP_KEY'] as const
type CredRef = (typeof REFS)[number]

const FIELDS: Array<{
  ref: CredRef
  hintKey: AdpLocaleKey
  helpKeys?: { standalone: AdpLocaleKey; cloud: AdpLocaleKey }
  helpUrl?: (vendor: SiteVendor, spaceId?: string) => string
  optional?: boolean
}> = [
  {
    ref: 'ADP_API_KEY',
    hintKey: 'hintApiKey',
    helpKeys: { standalone: 'helpApiKey', cloud: 'helpApiKey' },
    helpUrl: () => 'https://console.cloud.tencent.com/lkeap/api',
  },
  {
    ref: 'ADP_SECRET_ID',
    hintKey: 'hintSecretId',
    helpKeys: { standalone: 'helpSecretIdStandalone', cloud: 'helpSecretIdCloud' },
    helpUrl: (vendor) => vendor === 'ChinaTencentADP'
      ? 'https://adp.tencent.com/adp#/key-manage'
      : 'https://console.cloud.tencent.com/cam/capi',
  },
  {
    ref: 'ADP_SECRET_KEY',
    hintKey: 'hintSecretKey',
    helpKeys: { standalone: 'helpSecretKeyStandalone', cloud: 'helpSecretKeyCloud' },
    helpUrl: (vendor) => vendor === 'ChinaTencentADP'
      ? 'https://adp.tencent.com/adp#/key-manage'
      : 'https://console.cloud.tencent.com/cam/capi',
  },
  {
    ref: 'ADP_APP_KEY',
    hintKey: 'hintAppKey',
    helpKeys: { standalone: 'helpAppKey', cloud: 'helpAppKey' },
    helpUrl: (vendor, spaceId) => vendor === 'ChinaTencentADP'
      ? (spaceId ? `https://adp.tencent.com/adp/#/app/home?spaceId=${encodeURIComponent(spaceId)}` : 'https://adp.tencent.com/adp/#/app/home')
      : (spaceId && spaceId !== 'default_space'
          ? `https://adp.cloud.tencent.com/adp/#/app/home?spaceId=${encodeURIComponent(spaceId)}`
          : 'https://adp.cloud.tencent.com/app'),
    optional: true,
  },
]

const EMPTY_VIEWS: Record<CredRef, CredentialView> = {
  ADP_API_KEY: { configured: false, writable: true },
  ADP_SECRET_ID: { configured: false, writable: true },
  ADP_SECRET_KEY: { configured: false, writable: true },
  ADP_APP_KEY: { configured: false, writable: true },
}

function emptyDrafts(): Record<CredRef, string> {
  return { ADP_API_KEY: '', ADP_SECRET_ID: '', ADP_SECRET_KEY: '', ADP_APP_KEY: '' }
}

function stateLabel(view: CredentialView): { key: AdpLocaleKey; state: 'done' | 'warning' | 'error' } {
  if (!view.configured) return { key: 'stateMissing', state: 'warning' }
  if (!view.writable) return { key: 'stateEnv', state: 'done' }
  return { key: 'stateSaved', state: 'done' }
}

function FieldHelp({
  fieldRef,
  helpKeys,
  helpUrl,
  vendor,
  spaceId,
  t,
}: {
  fieldRef: CredRef
  helpKeys?: { standalone: AdpLocaleKey; cloud: AdpLocaleKey }
  helpUrl?: (vendor: SiteVendor, spaceId?: string) => string
  vendor: SiteVendor
  spaceId?: string
  t: Translate
}): JSX.Element | null {
  const [show, setShow] = useState(false)
  const hideTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(hideTimer.current), [])
  if (!helpKeys || !helpUrl) return null
  const key = vendor === 'ChinaTencentADP' ? helpKeys.standalone : helpKeys.cloud
  const url = helpUrl(vendor, spaceId)
  const cancelHide = (): void => {
    window.clearTimeout(hideTimer.current)
  }
  const scheduleHide = (): void => {
    cancelHide()
    hideTimer.current = window.setTimeout(() => setShow(false), 200)
  }
  return (
    <span
      className="adp-dsh-helpWrap"
      onMouseEnter={() => {
        cancelHide()
        setShow(true)
      }}
      onMouseLeave={scheduleHide}
      onFocus={() => {
        cancelHide()
        setShow(true)
      }}
      onBlur={scheduleHide}
    >
      <button
        type="button"
        className="adp-dsh-helpBtn"
        aria-label={t('helpAria', { ref: fieldRef })}
        aria-expanded={show}
        onClick={() => setShow((value) => !value)}
      >
        ?
      </button>
      {show ? (
        <span className="adp-dsh-helpBubble" role="tooltip">
          {t(key)}
          <a href={url} target="_blank" rel="noopener noreferrer">{t('helpGo')} →</a>
        </span>
      ) : null}
    </span>
  )
}

export function AdpCredentialsCard({
  connection,
  t = (key, params) => catalogT('en', key, params),
}: {
  connection: ConnectionFace | undefined
  t?: Translate
}) {
  const baseId = useId()
  const [open, setOpen] = useState(false)
  const [views, setViews] = useState<Record<CredRef, CredentialView>>(EMPTY_VIEWS)
  const [drafts, setDrafts] = useState<Record<CredRef, string>>(emptyDrafts)
  const [saving, setSaving] = useState(false)
  const [loginBusy, setLoginBusy] = useState(false)
  const [loginUrl, setLoginUrl] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [loginError, setLoginError] = useState<string | undefined>()
  const [vendor, setVendor] = useState<SiteVendor>('ChinaTencentADP')
  const [spaceId, setSpaceId] = useState('default_space')
  const [spaces, setSpaces] = useState<SiteSpace[]>([])
  const [spaceDraft, setSpaceDraft] = useState('')
  const [siteBusy, setSiteBusy] = useState(false)
  const [siteError, setSiteError] = useState<string | undefined>()

  useEffect(() => {
    ensureStyles()
  }, [])

  const refresh = useCallback(async () => {
    const api = connection?.api.credentials
    if (!api) return
    try {
      const response = await api.describe({ refs: [...REFS] })
      if (!response.result.ok) {
        setError(response.result.error.message)
        return
      }
      const next = { ...EMPTY_VIEWS }
      for (const ref of REFS) {
        const view = response.result.value.credentials[ref]
        next[ref] = {
          configured: view?.configured ?? false,
          writable: view?.writable ?? true,
          ...view?.source ? { source: view.source } : {},
        }
      }
      setViews(next)
      setError(undefined)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [connection])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoginBusy(true)
    void fetchLoginUrlProxy().then((data) => {
      if (cancelled) return
      setLoginBusy(false)
      if (data.ok) {
        setLoginUrl(data.login_url)
        setLoginError(undefined)
        return
      }
      setLoginError(data.error)
    })
    void fetchSiteVendor().then((data) => {
      if (cancelled) return
      if (data.ok) {
        setVendor(data.vendor)
        setSpaceId(data.spaceId)
        setSpaces(data.spaces)
        setSpaceDraft('')
        setSiteError(undefined)
        return
      }
      setSiteError(data.error)
    })
    return () => {
      cancelled = true
    }
  }, [open])

  const loopback = connection?.isLoopback === true
  const dirty = REFS.some((ref) => drafts[ref].length > 0)

  async function onSave(event?: FormEvent): Promise<void> {
    event?.preventDefault()
    const api = connection?.api.credentials
    if (!api || !loopback || !dirty || saving) return
    setSaving(true)
    setError(undefined)
    try {
      for (const ref of REFS) {
        const value = drafts[ref]
        if (!value) continue
        if (!views[ref].writable) continue
        const response = await api.set({ ref, value })
        if (!response.result.ok) {
          setError(response.result.error.message)
          return
        }
      }
      setDrafts(emptyDrafts())
      await refresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSaving(false)
    }
  }

  function onDiscard(): void {
    setDrafts(emptyDrafts())
    setError(undefined)
  }

  async function onClear(ref: CredRef): Promise<void> {
    const api = connection?.api.credentials
    if (!api || !loopback || !views[ref].writable) return
    setError(undefined)
    try {
      const response = await api.unset({ ref })
      if (!response.result.ok) {
        setError(response.result.error.message)
        return
      }
      setDrafts((prev) => ({ ...prev, [ref]: '' }))
      await refresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  async function onSite(next: SiteVendor): Promise<void> {
    if (next === vendor || siteBusy) return
    setSiteBusy(true)
    setSiteError(undefined)
    try {
      const data = await saveSiteSettings({ vendor: next })
      if (!data.ok) {
        setSiteError(data.error)
        return
      }
      setVendor(data.vendor)
      setSpaceId(data.spaceId)
      setSpaces(data.spaces)
      setLoginUrl(undefined)
      const login = await fetchLoginUrlProxy()
      if (login.ok) {
        setLoginUrl(login.login_url)
        setLoginError(undefined)
      } else {
        setLoginError(login.error)
      }
    } catch (caught) {
      setSiteError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSiteBusy(false)
    }
  }

  async function onSpace(next: string): Promise<void> {
    const value = next.trim()
    if (!value || value === spaceId || siteBusy) return
    setSiteBusy(true)
    setSiteError(undefined)
    try {
      const data = await saveSiteSettings({ spaceId: value })
      if (!data.ok) {
        setSiteError(data.error)
        return
      }
      setSpaceId(data.spaceId)
      setSpaces(data.spaces)
      setSpaceDraft('')
    } catch (caught) {
      setSiteError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSiteBusy(false)
    }
  }

  async function onOneId(): Promise<void> {
    setLoginError(undefined)
    // Open in the click handler. `window.open` after `await fetch` is treated as a
    // popup and blocked. Do not pass `noopener` in windowFeatures: that makes open()
    // return null even when the tab opened, which falsely showed oneidPopupBlocked.
    const tab = window.open('about:blank', '_blank')
    if (!tab) {
      setLoginError(t('oneidPopupBlocked'))
      return
    }
    setLoginBusy(true)
    try {
      const data = await fetchLoginUrlProxy()
      if (!data.ok) {
        tab.close()
        setLoginError(data.error)
        return
      }
      setLoginUrl(data.login_url)
      tab.location.replace(data.login_url)
    } catch (caught) {
      tab.close()
      setLoginError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoginBusy(false)
    }
  }

  return (
    <li className={`adp-dsh-card${open ? ' adp-dsh-cardOpen' : ''}`}>
      <button
        type="button"
        className="adp-dsh-header"
        aria-expanded={open}
        aria-label={t(open ? 'collapseAria' : 'expandAria', { name: t('title') })}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="adp-dsh-mark">
          <AdpIcon />
        </span>
        <span className="adp-dsh-headText">
          <span className="adp-dsh-name">{t('title')}</span>
          <span className="adp-dsh-description">{t('description')}</span>
        </span>
        {dirty ? <span className="adp-dsh-pending">{t('unsaved')}</span> : null}
        <IconChevronDownOutline14 className={`adp-dsh-chevron${open ? ' adp-dsh-chevronOpen' : ''}`} />
      </button>
      {open ? (
        <form className="adp-dsh-body" onSubmit={(event) => void onSave(event)}>
          <div className="adp-dsh-site">
            <p className="adp-dsh-sectionTitle">{t('siteTitle')}</p>
            <div className="adp-dsh-siteRow" role="group" aria-label={t('siteTitle')}>
              <button
                type="button"
                className={`adp-dsh-siteBtn${vendor === 'ChinaTencentADP' ? ' adp-dsh-siteBtnActive' : ''}`}
                aria-pressed={vendor === 'ChinaTencentADP'}
                disabled={siteBusy}
                onClick={() => void onSite('ChinaTencentADP')}
              >
                {t('siteStandalone')}
              </button>
              <button
                type="button"
                className={`adp-dsh-siteBtn${vendor === 'ChinaTencentCloud' ? ' adp-dsh-siteBtnActive' : ''}`}
                aria-pressed={vendor === 'ChinaTencentCloud'}
                disabled={siteBusy}
                onClick={() => void onSite('ChinaTencentCloud')}
              >
                {t('siteCloud')}
              </button>
            </div>
            <p className="adp-dsh-hint">
              {siteBusy
                ? t('siteSaving')
                : t(vendor === 'ChinaTencentADP' ? 'siteHintStandalone' : 'siteHintCloud')}
            </p>
            {siteError ? <p className="adp-dsh-error" role="status">{siteError}</p> : null}
          </div>
          <div className="adp-dsh-site">
            <p className="adp-dsh-sectionTitle">{t('spaceTitle')}</p>
            {spaces.length > 0 ? (
              <select
                className="adp-dsh-spaceSelect"
                aria-label={t('spaceTitle')}
                disabled={siteBusy}
                value={spaces.some((space) => space.id === spaceId) ? spaceId : ''}
                onChange={(event) => void onSpace(event.target.value)}
              >
                {spaces.some((space) => space.id === spaceId) ? null : (
                  <option value="">{spaceId || t('spacePlaceholder')}</option>
                )}
                {spaces.map((space) => (
                  <option key={space.id} value={space.id}>
                    {space.name && space.name !== space.id ? `${space.name} (${space.id})` : space.id}
                  </option>
                ))}
              </select>
            ) : (
              <div className="adp-dsh-spaceRow">
                <input
                  className="adp-dsh-spaceInput"
                  aria-label={t('spaceTitle')}
                  disabled={siteBusy}
                  value={spaceDraft}
                  placeholder={spaceId && spaceId !== 'default_space' ? spaceId : t('spacePlaceholder')}
                  onChange={(event) => setSpaceDraft(event.target.value)}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={siteBusy || !spaceDraft.trim()}
                  onClick={() => void onSpace(spaceDraft)}
                >
                  {t('spaceApply')}
                </Button>
              </div>
            )}
            <p className="adp-dsh-hint">
              {siteBusy ? t('spaceSaving') : spaces.length > 0 ? t('spaceHint') : t('spaceEmpty')}
            </p>
          </div>
          <div className="adp-dsh-oneid">
            <p className="adp-dsh-sectionTitle">{t('oneidTitle')}</p>
            {loginUrl ? (
              <a
                className="adp-dsh-oneidAnchor"
                href={loginUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t('oneidStart')}
              </a>
            ) : (
              <Button type="button" variant="outline" size="sm" disabled={loginBusy} onClick={() => void onOneId()}>
                {loginBusy ? t('oneidStarting') : t('oneidStart')}
              </Button>
            )}
            {loginError ? <p className="adp-dsh-error" role="status">{loginError}</p> : null}
          </div>
          <div>
            <p className="adp-dsh-sectionTitle">{t('manualTitle')}</p>
            {!loopback ? (
              <p className="adp-dsh-hint" role="status">
                {t('loopbackHint')}
              </p>
            ) : null}
            {FIELDS.map((field) => {
              const view = views[field.ref]
              const writable = loopback && view.writable
              const badge = stateLabel(view)
              const fieldId = `${baseId}-${field.ref}`
              return (
                <div className="adp-dsh-field" key={field.ref}>
                  <div className="adp-dsh-fieldHead">
                    <span className="adp-dsh-labelGroup">
                      <label className="adp-dsh-label" htmlFor={fieldId}>
                        {field.ref}
                        {field.optional ? t('optionalSuffix') : ''}
                      </label>
                      <FieldHelp fieldRef={field.ref} helpKeys={field.helpKeys} helpUrl={field.helpUrl} vendor={vendor} spaceId={spaceId} t={t} />
                    </span>
                    <span className="adp-dsh-badges">
                      <span className="adp-dsh-badge">
                        <StateDot state={badge.state} size={8} />
                        {t(badge.key)}
                      </span>
                      {view.configured && writable ? (
                        <Button type="button" variant="ghost" size="sm" onClick={() => void onClear(field.ref)}>
                          {t('clear')}
                        </Button>
                      ) : null}
                    </span>
                  </div>
                  <Input
                    id={fieldId}
                    type="password"
                    autoComplete="off"
                    value={drafts[field.ref]}
                    disabled={!writable}
                    placeholder={view.configured ? t('placeholderKeep') : t('placeholderPaste')}
                    onChange={(event) => {
                      const value = event.target.value
                      setDrafts((prev) => ({ ...prev, [field.ref]: value }))
                    }}
                  />
                  <p className="adp-dsh-hint">
                    {!view.writable
                      ? t('envLocked', { ref: field.ref })
                      : t(field.hintKey)}
                  </p>
                </div>
              )
            })}
          </div>
          <div className="adp-dsh-footer">
            {error ? <p className="adp-dsh-error" role="status">{error}</p> : null}
            <Button type="button" variant="ghost" size="sm" disabled={!dirty || saving} onClick={onDiscard}>
              {t('discard')}
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={!dirty || saving || !loopback}>
              {saving ? t('saving') : t('save')}
            </Button>
          </div>
        </form>
      ) : null}
    </li>
  )
}
