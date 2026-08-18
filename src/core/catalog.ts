export type CatalogEntry = {
  version: string
  region: string
  inject: readonly string[]
  service?: 'adp' | 'lke'
  hostOverride?: 'lke'
}

const A = 'AppKey'
const U = 'UserId'

/**
 * Action → version / region / auto-filled fields.
 * Ported from adpworker `coworker/adp/control.py` CATALOG, plus the official
 * App/Agent/Release pipeline and Skill plaza actions the DSH plugin needs.
 */
export const CATALOG: Record<string, CatalogEntry> = {
  DescribeAgentSummaryList: { version: '2026-05-20', region: '', inject: [] },
  DescribeAgentDetail: { version: '2026-05-20', region: '', inject: [] },
  ModifyAgent: { version: '2026-05-20', region: '', inject: [] },
  CopyAgentFromApp: { version: '2026-05-20', region: '', inject: [] },
  BindAgentTool: { version: '2025-11-12', region: '', inject: [] },
  UnbindAgentTool: { version: '2025-11-12', region: '', inject: [] },
  ModifyAgentToolList: { version: '2025-11-12', region: '', inject: [] },
  CreateAgent: { version: '2026-05-20', region: '', inject: [] },
  DeleteAgent: { version: '2026-05-20', region: '', inject: [] },

  DescribeAppSummaryList: { version: '2026-05-20', region: '', inject: [] },
  DescribeSpaceList: { version: '2026-05-20', region: '', inject: [] },
  DescribeApp: { version: '2026-05-20', region: '', inject: [] },
  CreateApp: { version: '2026-05-20', region: '', inject: [] },
  ModifyApp: { version: '2026-05-20', region: '', inject: [] },
  DeleteApp: { version: '2026-05-20', region: '', inject: [] },
  CreateSpace: { version: '2026-05-20', region: '', inject: [] },
  DescribeRobotBizIDByAppKey: { version: '2023-11-30', region: '', inject: [] },
  DescribeStorageCredential: { version: '2026-05-20', region: '', inject: [] },
  CreateWorkspaceCredential: { version: '2026-05-20', region: '', inject: [] },
  GetAppSecret: {
    version: '2023-11-30',
    region: '',
    inject: [],
    service: 'lke',
    hostOverride: 'lke',
  },

  CreateConversation: { version: '2026-05-20', region: '', inject: [A, U] },
  DescribeConversation: { version: '2026-05-20', region: '', inject: [A, U] },
  DescribeConversationList: { version: '2026-05-20', region: 'ap-guangzhou', inject: [A] },
  DescribeConversationMessageList: { version: '2026-05-20', region: '', inject: [A, U] },
  GetMsgRecord: { version: '2023-11-30', region: '', inject: [] },
  RateMsgRecord: { version: '2023-11-30', region: '', inject: [] },
  CreateWebSocketToken: { version: '2026-05-20', region: '', inject: [] },

  ListReferShareKnowledge: { version: '2023-11-30', region: '', inject: [] },
  GetKBDefaultConfig: { version: '2023-11-30', region: '', inject: [] },
  DescribeRefer: { version: '2023-11-30', region: '', inject: [] },

  DescribePluginSummaryList: { version: '2026-05-20', region: '', inject: [] },
  DescribePlugin: { version: '2026-05-20', region: '', inject: [] },
  DescribeSkillCategoryList: { version: '2026-05-20', region: '', inject: [] },
  DescribeSkillSummaryList: { version: '2026-05-20', region: '', inject: [] },
  DescribeSkillDetail: { version: '2026-05-20', region: '', inject: [] },

  ListModel: { version: '2025-11-12', region: '', inject: [] },
  DescribeModelList: { version: '2026-05-20', region: '', inject: [] },

  CreateChannel: { version: '2026-05-20', region: '', inject: [] },
  DescribeChannel: { version: '2026-05-20', region: '', inject: [] },
  DescribeChannelList: { version: '2026-05-20', region: '', inject: [] },
  ModifyChannel: { version: '2026-05-20', region: '', inject: [] },
  DeleteChannel: { version: '2026-05-20', region: '', inject: [] },

  DescribeTimerTaskSummaryList: { version: '2026-05-20', region: '', inject: [] },
  ChatCompletions: { version: '2024-05-22', region: '', inject: [] },

  CreateRelease: { version: '2026-05-20', region: '', inject: [] },
  DescribeReleaseSummary: { version: '2026-05-20', region: '', inject: [] },
  DescribeLatestRelease: { version: '2026-05-20', region: '', inject: [] },
}

/** Default-denied mutating actions. `config.allowMutating` is the whitelist. */
export const MUTATING = new Set<string>([
  'ModifyAgent',
  'CopyAgentFromApp',
  'BindAgentTool',
  'UnbindAgentTool',
  'ModifyAgentToolList',
  'CreateAgent',
  'DeleteAgent',
  'CreateApp',
  'ModifyApp',
  'DeleteApp',
  'CreateSpace',
  'CreateConversation',
  'RateMsgRecord',
  'CreateChannel',
  'ModifyChannel',
  'DeleteChannel',
  'CreateWorkspaceCredential',
  'CreateRelease',
])

/** Cloud AKSK auto-fills SpaceId except these AppId-scoped actions (they reject SpaceId). */
export const NO_AUTO_SPACE_ID = new Set<string>([
  'DescribeSpaceList',
  'DescribeApp',
  'DeleteApp',
  'ModifyApp',
  'DescribeAgentSummaryList',
  'DescribeAgentDetail',
  'CreateAgent',
  'DeleteAgent',
  'ModifyAgent',
  'CreateRelease',
  'DescribeReleaseSummary',
  'DescribeLatestRelease',
  'GetAppSecret',
  'CopyAgentFromApp',
  'BindAgentTool',
  'UnbindAgentTool',
  'ModifyAgentToolList',
  'CreateConversation',
  'DescribeConversation',
  'DescribeConversationList',
  'DescribeConversationMessageList',
])

/** Never offered on the allowMutating whitelist. */
export const NEVER_WHITELIST = new Set<string>(['CreateSkill', 'DeletePlugin', 'CreatePlugin', 'ModifyPlugin'])

export const APP_AGENT_RELEASE_MUTATING = [
  'CreateApp',
  'CreateAgent',
  'ModifyApp',
  'ModifyAgent',
  'CreateRelease',
  'DeleteAgent',
  'DeleteApp',
] as const

export function catalogList(): Array<{
  action: string
  version: string
  mutating: boolean
  autoFilled: string[]
}> {
  return Object.entries(CATALOG)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([action, entry]) => ({
      action,
      version: entry.version,
      mutating: MUTATING.has(action),
      autoFilled: [...entry.inject],
    }))
}
