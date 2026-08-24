import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import { APP_AGENT_RELEASE_MUTATING, CATALOG, MUTATING, NEVER_WHITELIST } from '../core/catalog.ts'
import { AdpError } from '../core/errors.ts'
import {
  ACTION_CONTRACTS,
  DEAD_ACTIONS,
  catalogRows,
  contractHint,
  missingRequired,
  normalizeCallPayload,
} from './contracts.ts'

export const name = 'control-adp'
export const inject = ['tools', 'adp']

export interface Config {
  allowMutating?: string[]
}

export const Config: z<Config> = z.object({
  allowMutating: z.array(z.string()).default([...APP_AGENT_RELEASE_MUTATING]),
})

export function apply(ctx: Context, config: Config): void {
  const allow = new Set((config.allowMutating ?? []).filter((a) => !NEVER_WHITELIST.has(a)))

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'adp_call') return next()
    const action = String((exec.arguments as { action?: string } | undefined)?.action ?? '')
    if (!action) return next()
    if (!MUTATING.has(action)) return next()
    if (NEVER_WHITELIST.has(action) || !allow.has(action)) {
      return { kind: 'deny', reason: `${action} is mutating and not on control-adp allowMutating.` }
    }
    return {
      kind: 'ask',
      reason: action.startsWith('Delete')
        ? `${action} permanently deletes ADP resources.`
        : `${action} changes ADP account state.`,
    }
  })

  ctx.tools.register(defineTool({
    name: 'adp_list_actions',
    description:
      'List ADP control-plane actions this plugin can call. Read required/hint/example before adp_call. Prefer adp_provision_agent / adp_ask / adp_plugin_* over raw CreateApp/CreateAgent/CreateRelease/ChatCompletions.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          actions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                action: { type: 'string', required: true },
                version: { type: 'string', required: true },
                mutating: { type: 'boolean', required: true },
                allowed: { type: 'boolean', required: true },
                autoFilled: { type: 'array', items: { type: 'string' } },
                required: { type: 'array', items: { type: 'string' } },
                hint: { type: 'string' },
                example: { type: 'json' },
                dead: { type: 'boolean' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value.actions, null, 2) }],
    },
    execute() {
      return Promise.resolve({
        actions: catalogRows().map((row) => ({
          ...row,
          allowed: !row.dead && (!row.mutating || allow.has(row.action)),
        })),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'adp_call',
    description:
      'Call one ADP control-plane action by name. Pass payload as a JSON object (a JSON string is also accepted). Check adp_list_actions for required fields and hints — missing ModelScene / AppId, top-level SkillList on ModifyAgent, AgentId on CreateRelease, and ChatCompletions all fail at the API. Mutating actions need approval and allowMutating. Prefer adp_provision_agent to create+publish and adp_ask to talk to a published app.',
    parameters: {
      action: { type: 'string', required: true, description: 'Catalog action name, e.g. DescribeApp.' },
      payload: {
        type: 'json',
        description: 'Request fields as a JSON object (not a JSON string). Example: {"AppId":"…"}.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (!CATALOG[args.action]) {
        throw new AdpError(`Unknown action ${args.action}. Call adp_list_actions.`, 'UNKNOWN_ACTION')
      }
      if (NEVER_WHITELIST.has(args.action) || DEAD_ACTIONS.has(args.action)) {
        throw new AdpError(
          ACTION_CONTRACTS[args.action]?.hint
            ?? `${args.action} is not exposed.`,
          'DENIED',
        )
      }
      if (MUTATING.has(args.action) && !allow.has(args.action)) {
        throw new AdpError(`${args.action} is mutating and not on allowMutating.`, 'DENIED')
      }
      const payload = normalizeCallPayload(args.action, asCallPayload(args.payload))
      const missing = missingRequired(args.action, payload)
      if (missing.length) {
        const hint = contractHint(args.action)
        const example = ACTION_CONTRACTS[args.action]?.example
        throw new AdpError(
          `${args.action} is missing ${missing.map((k) => `\`${k}\``).join(', ')}.${hint ? ` ${hint}` : ''}${example !== undefined ? ` Example: ${JSON.stringify(example)}` : ''}`,
          'BAD_PAYLOAD',
        )
      }
      return await callControlAction(ctx.adp, args.action, payload, exec.signal) as JsonValue
    },
  }))
}

/** Models often stringify `type: json` args; empty/non-object payloads become `{}`. */
export function asCallPayload(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string') return {}
  const trimmed = raw.trim()
  if (!trimmed) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    throw new AdpError('adp_call payload must be a JSON object, not a string of invalid JSON.', 'BAD_PAYLOAD')
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  throw new AdpError('adp_call payload must be a JSON object.', 'BAD_PAYLOAD')
}

function isAlreadyPublished(action: string, error: unknown): boolean {
  if (action !== 'CreateRelease' || !(error instanceof Error)) return false
  return error.message.includes('450027')
}

export async function callControlAction(
  adp: { call(action: string, payload?: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> },
  action: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  try {
    return await adp.call(action, payload, signal)
  } catch (error) {
    if (isAlreadyPublished(action, error) && typeof payload.AppId === 'string' && payload.AppId) {
      const latest = await adp.call('DescribeLatestRelease', { AppId: payload.AppId }, signal)
      return {
        alreadyPublished: true,
        message: 'CreateRelease 450027: nothing new to publish. Returning DescribeLatestRelease.',
        ...latest,
      }
    }
    throw error
  }
}

export {
  ACTION_CONTRACTS,
  DEAD_ACTIONS,
  catalogRows,
  nestAgentFields,
  normalizeCallPayload,
} from './contracts.ts'
