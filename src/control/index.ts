import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import { APP_AGENT_RELEASE_MUTATING, CATALOG, MUTATING, NEVER_WHITELIST, catalogList } from '../core/catalog.ts'
import { AdpError } from '../core/errors.ts'

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
    description: 'List ADP control-plane actions this plugin can call, with API version and whether they mutate state.',
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
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value.actions, null, 2) }],
    },
    execute() {
      return Promise.resolve({
        actions: catalogList().map((row) => ({
          ...row,
          allowed: !row.mutating || allow.has(row.action),
        })),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'adp_call',
    description:
      'Call one ADP control-plane action by name. Mutating actions (Create/Modify/Delete App+Agent+Release, etc.) require approval and must appear on allowMutating. CreateSkill and DeletePlugin are never allowed. Unknown parameters surface as ADP\'s own error.',
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
      if (NEVER_WHITELIST.has(args.action)) {
        throw new AdpError(`${args.action} is not exposed.`, 'DENIED')
      }
      if (MUTATING.has(args.action) && !allow.has(args.action)) {
        throw new AdpError(`${args.action} is mutating and not on allowMutating.`, 'DENIED')
      }
      const payload = asCallPayload(args.payload)
      return ctx.adp.call(args.action, payload, exec.signal) as Promise<JsonValue>
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
