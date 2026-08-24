import type { JsonValue } from '@deepseek-ai/dsh-tools'
import { CATALOG, MUTATING, NEVER_WHITELIST, NO_AUTO_SPACE_ID } from '../core/catalog.ts'
import { MODEL_SCENE_AGENT, MODEL_SCENE_CLAW } from '../core/models.ts'

export type ActionContract = {
  required?: string[]
  hint?: string
  example?: JsonValue
  /** Rename payload keys the model commonly swaps. */
  remap?: Record<string, string>
  /** Strip fields the control plane rejects as UnknownParameter. */
  drop?: string[]
  /** Wrap leftover agent fields into `{ Agent: {…} }`. */
  nestAgent?: boolean
  /** Not a real control-plane action; adp_call refuses it. */
  dead?: boolean
}

const AGENT_KEYS = [
  'Profile',
  'Instructions',
  'Model',
  'PluginList',
  'SkillList',
  'KnowledgeList',
  'WorkflowList',
  'ToolList',
] as const

/**
 * Per-action contract used to keep the agent-loop `adp_call` from guessing
 * OpenAPI bodies. Hints are shown on `adp_list_actions`; required/remap/drop
 * run before the signed request.
 */
export const ACTION_CONTRACTS: Record<string, ActionContract> = {
  DescribeModelList: {
    required: ['ModelScene'],
    hint: `ModelScene is required. ${MODEL_SCENE_AGENT}=agent thinking, ${MODEL_SCENE_CLAW}=Claw.`,
    example: { ModelScene: MODEL_SCENE_CLAW },
  },
  DescribeAgentDetail: {
    required: ['AppId', 'AgentId'],
    hint: 'Both AppId and AgentId. AgentId alone returns AppID为空.',
    example: { AppId: '…', AgentId: '…' },
  },
  DescribeAgentSummaryList: {
    required: ['AppId'],
    hint: 'AppId-scoped. Do not send SpaceId.',
    example: { AppId: '…' },
  },
  CreateRelease: {
    required: ['AppId'],
    hint: 'Only AppId. AgentId is UnknownParameter. Prefer adp_provision_agent; 450027 means already published — use DescribeLatestRelease.',
    example: { AppId: '…' },
    drop: ['AgentId'],
  },
  DescribeReleaseSummary: {
    required: ['AppId', 'ReleaseId'],
    hint: 'Polling with only AppId is MissingParameter.',
    example: { AppId: '…', ReleaseId: '…' },
  },
  DescribeLatestRelease: {
    required: ['AppId'],
    example: { AppId: '…' },
  },
  DescribeApp: {
    required: ['AppId'],
    hint: 'AppKey is under SecretInfo; send FieldMask.Paths=["SecretInfo"]. Do not send SpaceId.',
    example: { AppId: '…', FieldMask: { Paths: ['SecretInfo'] } },
  },
  GetAppSecret: {
    required: ['AppBizId'],
    hint: 'Parameter is AppBizId (the AppId value), not AppId. Prefer DescribeApp + FieldMask.',
    example: { AppBizId: '…' },
    remap: { AppId: 'AppBizId' },
  },
  ModifyAgent: {
    required: ['AppId', 'AgentId'],
    hint: 'Nested Agent: { AppId, AgentId, Agent: { Instructions, PluginList:[{PluginId}], SkillList:[{SkillId}], Model:{ModelId} } }. Top-level SkillList is UnknownParameter.',
    example: {
      AppId: '…',
      AgentId: '…',
      Agent: { SkillList: [{ SkillId: '…' }] },
    },
    nestAgent: true,
  },
  CreateAgent: {
    required: ['AppId', 'Agent'],
    hint: 'Nested Agent, not a top-level Name. Prefer adp_provision_agent.',
    example: {
      AppId: '…',
      Kind: 0,
      Agent: { Profile: { Name: '…', Role: 0 }, Instructions: '…', Model: { ModelId: '…' } },
    },
    nestAgent: true,
  },
  CreateWebSocketToken: {
    required: ['Type'],
    hint: 'Needs Type (and usually AppId). Chat is adp_ask / adp_ask_<slug>, not this action.',
  },
  DescribeSkillCategoryList: {
    hint: 'Do not send SpaceId (UnknownParameter). Empty body is fine.',
    example: {},
  },
  DescribeSkillSummaryList: {
    hint: 'Official body is { SpaceId, PageNumber, PageSize }. Do not send FilterList.Perspective on public cloud.',
    example: { PageNumber: 0, PageSize: 20 },
  },
  DescribeSkillDetail: {
    required: ['SkillId'],
    example: { SkillId: '…' },
  },
  ChatCompletions: {
    dead: true,
    hint: 'Not a control-plane action (InvalidAction). Talk to a published app with adp_ask / adp_ask_<slug>; local models use the adp: LLM provider.',
  },
}

/** Actions advertised by list_actions but refused by adp_call. */
export const DEAD_ACTIONS = new Set(
  Object.entries(ACTION_CONTRACTS).filter(([, spec]) => spec.dead).map(([action]) => action),
)

export function nestAgentFields(payload: Record<string, unknown>): Record<string, unknown> {
  const existing = payload.Agent
  const agent: Record<string, unknown> =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...existing as Record<string, unknown> }
      : {}
  const out: Record<string, unknown> = { ...payload }
  for (const key of AGENT_KEYS) {
    if (out[key] !== undefined) {
      if (agent[key] === undefined) agent[key] = out[key]
      delete out[key]
    }
  }
  if (Object.keys(agent).length > 0) out.Agent = agent
  return out
}

export function normalizeCallPayload(action: string, payload: Record<string, unknown>): Record<string, unknown> {
  const spec = ACTION_CONTRACTS[action]
  let out = { ...payload }
  if (spec?.remap) {
    for (const [from, to] of Object.entries(spec.remap)) {
      if (out[from] !== undefined && (out[to] === undefined || out[to] === '')) {
        out[to] = out[from]
        delete out[from]
      }
    }
  }
  if (spec?.drop) {
    for (const key of spec.drop) delete out[key]
  }
  if (spec?.nestAgent) out = nestAgentFields(out)
  return out
}

export function missingRequired(action: string, payload: Record<string, unknown>): string[] {
  const required = ACTION_CONTRACTS[action]?.required ?? []
  return required.filter((key) => {
    const value = payload[key]
    if (value === undefined || value === null) return true
    if (typeof value === 'string' && value.trim() === '') return true
    if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value as object).length === 0) return true
    return false
  })
}

export function contractHint(action: string): string | undefined {
  return ACTION_CONTRACTS[action]?.hint
}

export function catalogRows(): Array<{
  action: string
  version: string
  mutating: boolean
  autoFilled: string[]
  required: string[]
  hint?: string
  example?: JsonValue
  dead: boolean
}> {
  return Object.entries(CATALOG)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([action, entry]) => {
      const spec = ACTION_CONTRACTS[action]
      const autoFilled = [...entry.inject]
      if (!NO_AUTO_SPACE_ID.has(action) && !autoFilled.includes('SpaceId')) autoFilled.push('SpaceId?')
      return {
        action,
        version: entry.version,
        mutating: MUTATING.has(action),
        autoFilled,
        required: spec?.required ?? [],
        ...spec?.hint ? { hint: spec.hint } : {},
        ...spec?.example ? { example: spec.example } : {},
        dead: Boolean(spec?.dead) || NEVER_WHITELIST.has(action),
      }
    })
}
