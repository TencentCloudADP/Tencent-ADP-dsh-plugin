import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SkillCandidate, SkillDefinition, SkillLookupOptions, SkillProvider } from '@deepseek-ai/dsh-skill'
import { unzipSync, strFromU8 } from 'fflate'
import { skillKebab } from '../core/names.ts'
import { AdpError } from '../core/errors.ts'

export const name = 'skills-adp'
export const inject = ['skills', 'adp']

export interface Config {
  allowElevatedRisk?: boolean
  maxRiskLevel?: number
}

export const Config: z<Config> = z.object({
  allowElevatedRisk: z.boolean().default(false),
  maxRiskLevel: z.number().default(1),
})

interface Locator {
  skillId: string
  name: string
  description: string
}

export function apply(ctx: Context, config: Config): void {
  const provider: SkillProvider = {
    name: 'adp',
    async list(_options: SkillLookupOptions) {
      let page = 0
      const candidates: SkillCandidate[] = []
      while (page < 20) {
        const data = await ctx.adp.call('DescribeSkillSummaryList', {
          PageNumber: page,
          PageSize: 50,
          FilterList: [{ Name: 'Perspective', Values: ['USER'] }],
        }, _options.signal)
        const batch = (data.SkillList ?? data.SkillSummaryList ?? data.List) as Array<Record<string, unknown>> | undefined
        if (!Array.isArray(batch) || batch.length === 0) break
        for (const row of batch) {
          const candidate = toCandidate(row, config)
          if (candidate) candidates.push(candidate)
        }
        const total = Number(data.TotalCount ?? 0)
        if (total && candidates.length >= total) break
        if (batch.length < 50) break
        page += 1
      }
      return candidates
    },
    async get(candidate: SkillCandidate, options: SkillLookupOptions) {
      const locator = candidate.locator as Locator
      const data = await ctx.adp.call('DescribeSkillDetail', { SkillId: locator.skillId }, options.signal)
      const version = currentVersion(data)
      const mdUrl = String(version?.SkillMarkdownUrl ?? '')
      const zipUrl = String(version?.SkillUrl ?? '')
      if (!mdUrl && !zipUrl) return undefined
      const content = mdUrl
        ? await fetchText(mdUrl, options.signal)
        : await fetchSkillMarkdownFromZip(zipUrl, options.signal)
      if (!content) return undefined
      const definition: SkillDefinition = {
        name: candidate.name,
        description: candidate.description,
        invocation: candidate.invocation,
        source: candidate.source,
        provider: candidate.provider,
        content,
        ...candidate.whenToUse ? { whenToUse: candidate.whenToUse } : {},
      }
      return definition
    },
  }
  ctx.skills.registerProvider(() => provider)
}

function toCandidate(row: Record<string, unknown>, config: Config): SkillCandidate | undefined {
  const skillId = String(row.SkillId ?? row.Id ?? '')
  if (!skillId) return undefined
  const profile = (row.Profile ?? row.SkillProfile ?? row) as Record<string, unknown>
  const status = String(row.SkillStatus ?? row.Status ?? profile.SkillStatus ?? '')
  const analysis = String(row.AnalysisStatus ?? profile.AnalysisStatus ?? 'AVAILABLE')
  if (status && status !== 'RELEASED' && status !== '2') return undefined
  if (analysis && analysis !== 'AVAILABLE') return undefined
  const risk = Number(row.RiskLevel ?? profile.RiskLevel ?? 0)
  const max = config.allowElevatedRisk ? 3 : (config.maxRiskLevel ?? 1)
  if (risk >= 2 && risk > max) return undefined
  const rawName = String(profile.Name ?? row.Name ?? skillId)
  const description = String(profile.Description ?? row.Description ?? '')
  return {
    name: skillKebab(rawName, skillId),
    description: description || rawName,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'custom',
    provider: 'adp',
    rank: 400,
    locator: { skillId, name: rawName, description } satisfies Locator,
  }
}

function currentVersion(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const detail = (data.SkillDetail ?? data.Skill ?? data) as Record<string, unknown>
  const versions = (detail.VersionList ?? data.VersionList) as Array<Record<string, unknown>> | undefined
  if (Array.isArray(versions) && versions.length > 0) {
    return versions.find((v) => v.IsCurrent || v.Current) ?? versions[0]
  }
  return detail
}

async function fetchText(url: string, signal?: AbortSignal): Promise<string | undefined> {
  const resp = await fetch(url, { signal })
  if (!resp.ok) return undefined
  return resp.text()
}

export async function fetchSkillMarkdownFromZip(url: string, signal?: AbortSignal): Promise<string | undefined> {
  const resp = await fetch(url, { signal })
  if (!resp.ok) return undefined
  const buf = new Uint8Array(await resp.arrayBuffer())
  try {
    const files = unzipSync(buf)
    const names = Object.keys(files)
    const skill = names.find((n) => n.replace(/\\/g, '/').toLowerCase().endsWith('skill.md'))
    if (!skill) return undefined
    return strFromU8(files[skill]!)
  } catch (error) {
    throw new AdpError(`Could not unzip SkillUrl (${error instanceof Error ? error.message : 'error'})`, 'SKILL_ZIP')
  }
}
