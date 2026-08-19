import type { Context } from '@deepseek-ai/cordis'
import { ADP_CORE_SETTINGS_NS } from '../core/settings-ns.ts'
import { AdpCredentialsCard, type ConnectionFace } from './AdpCredentialsCard.tsx'
import { ADP_LOCALE_NS, dictionaries, type Translate } from './locales.ts'

export const name = '@tencent/dsh-adp'
export const inject = ['slots', 'connection', 'locale']

type ClientSlots = {
  inject: (slot: string, factory: () => unknown) => void
  register: (
    options: { name: string; key: string; id?: string; locale?: string },
    component: unknown,
  ) => unknown
}

type LocaleFace = {
  register: (ns: string, dicts: typeof dictionaries) => () => void
}

/**
 * Browser half: the Settings → Plugins card. Host `adp-core` already loads this
 * package, so `dsh.client` on package.json is enough — no extra loader row.
 */
export function apply(ctx: Context): void {
  const locale = ctx.get('locale') as LocaleFace | undefined
  if (locale) {
    ctx.effect(() => locale.register(ADP_LOCALE_NS, dictionaries), 'adp: credentials card dictionaries')
  }
  const slots = (ctx as Context & { slots: ClientSlots }).slots
  slots.inject('settings.plugin.item', () =>
    slots.register(
      { name: 'settings.plugin.item', key: ADP_CORE_SETTINGS_NS, id: ADP_CORE_SETTINGS_NS, locale: ADP_LOCALE_NS },
      function AdpCredentialsBound({ t }: { t: Translate }) {
        return <AdpCredentialsCard connection={ctx.get('connection') as ConnectionFace | undefined} t={t} />
      },
    ))
}
