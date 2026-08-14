import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AdpError, MISSING_CREDENTIAL } from '../core/errors.ts'
import { agentToolName } from '../core/names.ts'
import { looksLikeMedia } from '../core/media.ts'
import { fetchAppKey, provisionAgent, secretFromApp } from './provision.ts'
import { buildChatRequest, newConversationId, streamChat } from './chat.ts'

export const name = 'agents-adp'
export const inject = ['tools', 'adp', 'credentials']

export interface BoundAgent {
  name?: string
  appId?: string
  appKeyEnv?: string
  description?: string
}

export interface Config {
  agents?: BoundAgent[]
  defaultAppMode?: number
  visitorId?: string
}

export const Config: z<Config> = z.object({
  agents: z.array(z.object({
    name: z.string(),
    appId: z.string(),
    appKeyEnv: z.string().role('credential-ref'),
    description: z.string(),
  })).default([]),
  defaultAppMode: z.number().default(4),
  visitorId: z.string().default('adp-dsh'),
})

const MAX_CONTEXT_CHARS = 60_000

export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'adp_provision_agent',
    description:
      'Create a Tencent Cloud ADP application + agent + release from one request (CreateApp → CreateAgent → CreateRelease). Default AppMode=4 (Claw). Does not become a DSH subagent: the cloud agent cannot call local tools. On success stores the AppKey as a credential reference and registers adp_ask_<slug>. Release polling happens here so the model does not sleep.',
    parameters: {
      name: { type: 'string', required: true, description: 'Application / agent display name.' },
      instructions: { type: 'string', required: true, description: 'Agent instructions.' },
      appMode: { type: 'integer', description: '1 standard / 2 agent / 3 workflow / 4 Claw (default).' },
      modelId: { type: 'string', description: 'Cloud model id. Claw catalog is ModelScene=18.' },
      skillIds: { type: 'array', items: { type: 'string' }, description: 'Optional Skill ids to bind.' },
      pluginIds: { type: 'array', items: { type: 'string' }, description: 'Optional Plugin ids to bind.' },
      spaceId: { type: 'string', description: 'Workspace id; defaults to adp-core spaceId.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true },
          appId: { type: 'string', required: true },
          agentId: { type: 'string', required: true },
          askTool: { type: 'string' },
          appKeyRef: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const result = await provisionAgent(ctx, {
        name: args.name,
        instructions: args.instructions,
        appMode: args.appMode ?? config.defaultAppMode ?? 4,
        modelId: args.modelId,
        skillIds: args.skillIds,
        pluginIds: args.pluginIds,
        spaceId: args.spaceId,
      }, exec.signal)
      if (result.kind === 'ready') {
        registerAskTool(ctx, config, {
          name: args.name,
          appId: result.appId,
          appKeyEnv: result.appKeyRef,
        })
      }
      return result
    },
  }))

  ctx.tools.register(defineTool({
    name: 'adp_ask',
    description:
      'Ask a bound ADP cloud application over SSE chat. Requires AppKey (not AKSK). Only reply text is returned; thought/tool_call traces are omitted from the answer. Optional conversationId continues a thread. This is one-way ask, not a DSH subagent.',
    parameters: {
      question: { type: 'string', required: true },
      appKeyEnv: { type: 'string', description: 'Credential reference for the AppKey when not using a bound adp_ask_* tool.' },
      conversationId: { type: 'string' },
      files: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative files whose text is sent as context.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          answer: { type: 'string', required: true },
          conversation_id: { type: 'string', required: true },
          saved_files: { type: 'array', items: { type: 'string' } },
          context_notes: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.answer }],
    },
    async execute(args, exec) {
      const ref = args.appKeyEnv
      if (!ref) throw new AdpError('adp_ask needs appKeyEnv or a bound adp_ask_<slug> tool.', MISSING_CREDENTIAL)
      return askBound(ctx, config, { appKeyEnv: ref, name: 'adp' }, args.question, args.conversationId, args.files, exec.signal)
    },
  }))

  for (const agent of config.agents ?? []) {
    if (agent.appKeyEnv) registerAskTool(ctx, config, agent)
  }
}

function registerAskTool(ctx: Context, config: Config, agent: BoundAgent): void {
  const toolName = agentToolName(agent.name || agent.appId || agent.appKeyEnv || 'agent')
  ctx.tools.register(defineTool({
    name: toolName,
    description:
      `Ask the ADP cloud agent “${agent.name || toolName}”. ${agent.description ?? ''} It runs on Tencent's side and cannot see this machine — pass files for local context. Not a DSH subagent.`,
    parameters: {
      question: { type: 'string', required: true },
      conversationId: { type: 'string' },
      files: { type: 'array', items: { type: 'string' } },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          answer: { type: 'string', required: true },
          conversation_id: { type: 'string', required: true },
          saved_files: { type: 'array', items: { type: 'string' } },
          context_notes: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.answer }],
    },
    async execute(args, exec) {
      return askBound(ctx, config, agent, args.question, args.conversationId, args.files, exec.signal)
    },
  }))
}

async function askBound(
  ctx: Context,
  config: Config,
  agent: BoundAgent,
  question: string,
  conversationId: string | undefined,
  files: string[] | undefined,
  signal?: AbortSignal,
) {
  const refName = agent.appKeyEnv
  if (!refName) throw new AdpError('This agent has no appKeyEnv.', MISSING_CREDENTIAL)
  const hit = await ctx.credentials.resolve(credentialRef(refName))
  if (!hit?.value) {
    throw new AdpError(`No AppKey for ${refName}. AKSK cannot drive SSE chat.`, MISSING_CREDENTIAL)
  }
  const appKey = hit.value
  let thread = conversationId?.trim() || ''
  if (!thread) {
    thread = await createConversation(ctx, appKey, agent.appId, signal)
  }
  const { context, notes } = files?.length
    ? await gatherContext(files, ctx.adp.workspaceDir())
    : { context: '', notes: [] as string[] }
  const q = context
    ? `Here is context from the user's local workspace:\n\n${context}\n\n--- end of context ---\n\n${question}`
    : question
  const payload = buildChatRequest({
    appKey,
    conversationId: thread,
    question: q,
    visitorId: config.visitorId || ctx.adp.userId(),
  })
  const reply = await streamChat(ctx.adp.chatUrl(), payload, signal)
  if (!reply.answer) {
    throw new AdpError(
      `The agent finished without an answer${reply.trace.length ? ` (saw: ${reply.trace.join(', ')})` : ''}`,
      'EMPTY_REPLY',
    )
  }
  const out: {
    answer: string
    conversation_id: string
    saved_files?: string[]
    context_notes?: string[]
  } = {
    answer: reply.answer,
    conversation_id: reply.conversationId,
  }
  if (notes.length) out.context_notes = notes
  const media = reply.files.filter((f) => looksLikeMedia(f.url))
  if (media.length) {
    const harvested = await ctx.adp.harvest({ files: media }, signal) as { saved_files?: string[] }
    if (harvested.saved_files?.length) out.saved_files = harvested.saved_files
  }
  return out
}

async function createConversation(
  ctx: Context,
  appKey: string,
  appId: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const data = await ctx.adp.call('CreateConversation', {
      Type: 5,
      AppKey: appKey,
      UserId: ctx.adp.userId(),
      ...appId ? { AppId: appId } : {},
    }, signal)
    const id = String(data.ConversationId ?? '')
    if (id) return id
  } catch {
    // Official path first; fall back to a client UUID as adpworker did.
  }
  return newConversationId()
}

async function gatherContext(paths: string[], root: string | undefined): Promise<{ context: string; notes: string[] }> {
  const notes: string[] = []
  const chunks: string[] = []
  let budget = MAX_CONTEXT_CHARS
  const base = root ? resolve(root) : undefined
  for (const raw of paths.slice(0, 20)) {
    const path = resolve(base ?? '', raw)
    if (base) {
      const rel = relative(base, path)
      if (rel.startsWith('..') || isAbsolute(rel)) {
        notes.push(`${raw}: refused — outside the session workspace`)
        continue
      }
    }
    try {
      const body = await readFile(path, 'utf8')
      const clipped = body.length > budget ? `${body.slice(0, budget)}\n…[truncated]` : body
      if (body.length > budget) notes.push(`${raw}: truncated to fit`)
      budget -= clipped.length
      chunks.push(`--- ${raw} ---\n${clipped}`)
      if (budget <= 0) {
        notes.push('context budget reached; later files were skipped')
        break
      }
    } catch (error) {
      notes.push(`${raw}: could not read (${error instanceof Error ? error.name : 'error'})`)
    }
  }
  return { context: chunks.join('\n\n'), notes }
}

export { fetchAppKey, secretFromApp }
