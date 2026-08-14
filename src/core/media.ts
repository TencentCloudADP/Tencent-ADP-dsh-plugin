import { mkdir, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_BYTES = 256 * 1024 * 1024
const MAX_FILES = 8
const MEDIA_EXT = new Set([
  '.mp4', '.mov', '.webm', '.m4v', '.gif',
  '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.svg',
  '.mp3', '.wav', '.m4a', '.aac', '.flac',
  '.glb', '.gltf', '.obj', '.fbx', '.usdz',
  '.pdf', '.docx', '.xlsx', '.pptx', '.zip',
])
const MEDIA_TYPES = ['video/', 'image/', 'audio/', 'model/', 'application/pdf']
const URL_RE = /https?:\/\/[^\s"'<>)\\]+/g

export function extractUrls(value: unknown): string[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.match(URL_RE) ?? []) {
    const url = raw.replace(/[.,;)】)]+$/, '')
    if (!seen.has(url)) {
      seen.add(url)
      out.push(url)
    }
  }
  return out
}

export function looksLikeMedia(url: string): boolean {
  try {
    const path = new URL(url).pathname
    return MEDIA_EXT.has(extname(path).toLowerCase())
  } catch {
    return false
  }
}

function nameFor(url: string, contentType: string, index: number): string {
  let base = 'adp-media'
  try {
    base = decodeURIComponent(basename(new URL(url).pathname)) || base
  } catch {
    base = `adp-${index}`
  }
  const ext = extname(base)
  const stem = (ext ? base.slice(0, -ext.length) : base).replace(/[^\w.\-]+/g, '_').slice(0, 60) || `adp-${index}`
  let suffix = ext
  if (!suffix) {
    const mime = contentType.split(';')[0]?.trim() ?? ''
    if (mime === 'image/png') suffix = '.png'
    else if (mime === 'image/jpeg') suffix = '.jpg'
    else if (mime === 'application/pdf') suffix = '.pdf'
    else suffix = '.bin'
  }
  return `${stem}${suffix}`
}

async function uniquePath(directory: string, name: string): Promise<string> {
  const { existsSync } = await import('node:fs')
  const parsed = extname(name)
  const stem = parsed ? name.slice(0, -parsed.length) : name
  let candidate = name
  let n = 2
  while (existsSync(join(directory, candidate))) {
    candidate = `${stem}-${n}${parsed}`
    n += 1
  }
  return candidate
}

export interface HarvestResult {
  result: unknown
  saved_files?: string[]
  note?: string
  download_problems?: string[]
}

export async function harvestMedia(
  result: unknown,
  workspace: string | undefined,
  signal?: AbortSignal,
): Promise<HarvestResult | unknown> {
  if (!workspace) return result
  const candidates = extractUrls(result).filter(looksLikeMedia).slice(0, MAX_FILES)
  if (candidates.length === 0) return result

  await mkdir(workspace, { recursive: true })
  const saved: string[] = []
  const notes: string[] = []

  for (const [index, url] of candidates.entries()) {
    try {
      const resp = await fetch(url, { signal, redirect: 'follow' })
      if (!resp.ok) {
        notes.push(`${basename(fileURLToPath(`file://${new URL(url).pathname}`))}: HTTP ${resp.status}`)
        continue
      }
      const contentType = resp.headers.get('content-type') ?? ''
      if (!MEDIA_TYPES.some((t) => contentType.startsWith(t)) && !looksLikeMedia(url)) continue
      const declared = Number(resp.headers.get('content-length') ?? 0)
      if (declared > MAX_BYTES) {
        notes.push(`skipped — exceeds cap`)
        continue
      }
      const buf = Buffer.from(await resp.arrayBuffer())
      if (buf.byteLength > MAX_BYTES) {
        notes.push('skipped — larger than the cap')
        continue
      }
      const name = await uniquePath(workspace, nameFor(url, contentType, index))
      await writeFile(join(workspace, name), buf)
      saved.push(name)
    } catch (error) {
      if (signal?.aborted) throw error
      notes.push(`could not download (${error instanceof Error ? error.name : 'error'})`)
    }
  }

  if (saved.length === 0 && notes.length === 0) return result
  const out: HarvestResult = typeof result === 'object' && result !== null && !Array.isArray(result)
    ? { ...(result as object), result } as HarvestResult
    : { result }
  if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
    Object.assign(out, result)
    delete (out as { result?: unknown }).result
  }
  if (saved.length > 0) {
    out.saved_files = saved
    out.note = 'Already downloaded into the workspace — refer to these files, not the links; the links expire.'
  }
  if (notes.length > 0) out.download_problems = notes
  return out
}

/** Strip remote media URLs from a model-facing projection when local copies exist. */
export function withoutBareMediaUrls(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value
  const rec = value as Record<string, unknown>
  if (!Array.isArray(rec.saved_files) || rec.saved_files.length === 0) return value
  return value
}
