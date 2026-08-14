import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Context } from '@deepseek-ai/cordis'
import { AdpError } from '../core/errors.ts'
import { MODEL_SCENE_CLAW } from '../core/models.ts'
import { agentToolName, kebab } from '../core/names.ts'
import type { AdpService } from '../core/service.ts'

export interface ProvisionInput {
  name: string
  instructions: string
  appMode?: number
  modelId?: string
  skillIds?: string[]
  pluginIds?: string[]
  spaceId?: string
}

export interface ProvisionReady {
  kind: 'ready'
  appId: string
  agentId: string
  askTool: string
  appKeyRef: string
}

export interface ProvisionNeedsKey {
  kind: 'needs_appkey'
  appId: string
  agentId: string
  message: string
}

export type ProvisionResult = ProvisionReady | ProvisionNeedsKey

export async function provisionAgent(
  ctx: Context,
  input: ProvisionInput,
  signal?: AbortSignal,
): Promise<ProvisionResult> {
  const adp: AdpService = ctx.adp
  const spaceId = input.spaceId || adp.spaceId()
  const appMode = input.appMode ?? 4
  const createApp = await adp.call('CreateApp', {
    SpaceId: spaceId,
    AppMode: appMode,
    Name: input.name,
  }, signal)
  const appId = String(createApp.AppId ?? '')
  if (!appId) throw new AdpError('CreateApp returned no AppId', 'PROVISION_FAILED')

  const agentPayload: Record<string, unknown> = {
    AppId: appId,
    Kind: 0,
    Name: input.name,
    Instructions: input.instructions,
  }
  if (input.modelId) agentPayload.Model = input.modelId
  if (input.pluginIds?.length) agentPayload.PluginList = input.pluginIds
  if (input.skillIds?.length) agentPayload.SkillList = input.skillIds
  const createAgent = await adp.call('CreateAgent', agentPayload, signal)
  const agentId = String(createAgent.AgentId ?? '')
  if (!agentId) throw new AdpError('CreateAgent returned no AgentId', 'PROVISION_FAILED')

  await adp.call('CreateRelease', { AppId: appId }, signal)
  await pollRelease(adp, appId, signal)

  const appKey = await fetchAppKey(adp, appId, signal)
  const slug = kebab(input.name) || agentToolName(input.name).replace(/^adp_ask_/, '')
  const askTool = `adp_ask_${slug}`.slice(0, 60)
  if (!appKey) {
    return {
      kind: 'needs_appkey',
      appId,
      agentId,
      message:
        'Release succeeded but AppKey was not returned. DescribeApp needs FieldMask.Paths=["SecretInfo"]; if that is still empty, copy the AppKey from the console and bind it with agents-adp agents[].appKeyEnv. A fake ask tool was not registered.',
    }
  }
  const appKeyRef = `ADP_APP_KEY_${slug.replace(/-/g, '_').toUpperCase()}`.replace(/[^A-Z0-9_]/g, '_')
  await ctx.credentials.set(credentialRef(appKeyRef), appKey)
  return { kind: 'ready', appId, agentId, askTool, appKeyRef }
}

export async function pollRelease(adp: AdpService, appId: string, signal?: AbortSignal): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    const data = await adp.call('DescribeReleaseSummary', { AppId: appId }, signal)
    const status = Number(
      data.Status
      ?? (data.Release as Record<string, unknown> | undefined)?.Status
      ?? (data.ReleaseSummary as Record<string, unknown> | undefined)?.Status
      ?? 0,
    )
    if (status === 3) return
    if (status === 4) throw new AdpError('CreateRelease failed (Status=4)', 'RELEASE_FAILED')
    await sleep(500, signal)
  }
  throw new AdpError('CreateRelease timed out waiting for Status=3', 'RELEASE_TIMEOUT')
}

export async function fetchAppKey(adp: AdpService, appId: string, signal?: AbortSignal): Promise<string | undefined> {
  const withMask = await adp.call('DescribeApp', {
    AppId: appId,
    FieldMask: { Paths: ['SecretInfo'] },
  }, signal)
  const fromMask = secretFromApp(withMask)
  if (fromMask) return fromMask
  try {
    const secret = await adp.call('GetAppSecret', { AppBizId: appId }, signal)
    const key = String(secret.AppKey ?? secret.SecretKey ?? (secret.SecretInfo as Record<string, unknown> | undefined)?.AppKey ?? '')
    if (key) return key
  } catch {
    // GetAppSecret is best-effort; absence is a documented platform gap.
  }
  return undefined
}

export function secretFromApp(data: Record<string, unknown>): string | undefined {
  const app = (data.App ?? data) as Record<string, unknown>
  const info = (app.SecretInfo ?? data.SecretInfo) as Record<string, unknown> | undefined
  const key = info?.AppKey ?? info?.SecretKey
  return key ? String(key) : undefined
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(signal.reason ?? new Error('aborted'))
    }, { once: true })
  })
}

export { MODEL_SCENE_CLAW }
