import { createHash } from 'node:crypto'

export function slugAscii(name: string): string {
  const trimmed = (name || '').trim()
  if (!trimmed || /[^A-Za-z0-9 _-]/.test(trimmed)) return ''
  return trimmed.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_|_$/g, '').toLowerCase()
}

export function shortHash(seed: string, n = 6): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, n)
}

export function pluginToolName(toolName: string, toolId: string, suffix = ''): string {
  let slug = toolName.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').toLowerCase()
  if (slug.replace(/_/g, '').length < 3) slug = `t${shortHash(toolId || toolName)}`
  const base = `adp_p__${slug}${suffix ? `_${suffix}` : ''}`
  return base.slice(0, 60)
}

/**
 * Stable ask-tool slug. Prefer kebab of remaining ASCII so CJK display names
 * ("Claw Demo 应用") become `adp_ask_claw-demo`, matching what provision
 * advertises. slugAscii used to return '' on any non-ASCII and fall back to a
 * hash, so the registered tool never matched the advertised name.
 */
export function askSlug(name: string): string {
  const fromKebab = kebab(name)
  if (fromKebab) return fromKebab.slice(0, 50)
  const ascii = slugAscii(name)
  if (ascii) return ascii.slice(0, 50)
  return `a${shortHash(name)}`
}

export function agentToolName(name: string): string {
  return `adp_ask_${askSlug(name)}`.slice(0, 60)
}

export function appKeyRefForSlug(slug: string): string {
  return `ADP_APP_KEY_${slug.replace(/-/g, '_').toUpperCase()}`.replace(/[^A-Z0-9_]/g, '_')
}

export function skillKebab(name: string, id: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (/^[a-z][a-z0-9-]*[a-z0-9]$/.test(slug) || /^[a-z]$/.test(slug)) return slug.slice(0, 64)
  return `adp-${shortHash(id || name, 8)}`
}

export function kebab(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}
