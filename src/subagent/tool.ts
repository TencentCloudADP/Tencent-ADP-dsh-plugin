/**
 * Model-facing ADP subagent Consumer. It delegates execution and lifecycle to
 * the official `@deepseek-ai/dsh-tool-subagent` plugin, then contributes the
 * external agent's business identity to the system prompt so the coordinator
 * knows which specialist the tool reaches and when to use it.
 * @module @tencentcloudadp/dsh-adp/subagent/tool
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-system-prompt'
import {
  Config as BaseConfig,
  apply as applyBaseTool,
  type Config as BaseToolConfig,
} from '@deepseek-ai/dsh-tool-subagent'

/** Prompt order immediately before the generic subagent scheduling guidance. */
const ADP_AGENT_IDENTITY_ORDER = 116.4

/** Model-visible identity plus the official subagent tool configuration. */
export interface Config extends BaseToolConfig {
  /** Business name of the external ADP agent shown to the main agent. */
  agentName: string
  /** Capabilities, task scope, and intended delegation cases shown to the main agent. */
  agentDescription: string
}

/** Schemastery config combining the official tool schema with ADP identity. */
export const Config = z.intersect([
  BaseConfig,
  z.object({
    agentName: z.string().required(),
    agentDescription: z.string().required(),
  }),
]) as z<Config>

/** Cordis plugin name. */
export const name = 'tool-subagent-adp'
/** Same required services as the official subagent tool. */
export const inject = ['tools', 'subagents', 'systemPrompt']

function assertNonBlank(label: string, value: string): void {
  if (value.trim().length === 0) throw new TypeError(`tool-subagent-adp: ${label} must not be blank`)
}

/**
 * Mount the official delegation tool and its model-visible ADP agent identity.
 * @param ctx - context carrying tools, subagents, and system-prompt services.
 * @param config - official tool routing plus external agent name and description.
 */
export function apply(ctx: Context, config: Config): void {
  assertNonBlank('agentName', config.agentName)
  assertNonBlank('agentDescription', config.agentDescription)
  applyBaseTool(ctx, config)

  const toolName = config.toolName ?? 'subagent'
  ctx.systemPrompt.section({
    name: `tool:${toolName}:agent-identity`,
    order: ADP_AGENT_IDENTITY_ORDER,
    text: context => ctx.tools.get(toolName, context.scope) === undefined
      ? ''
      : [
          `The tool \`${toolName}\` delegates to one specific external agent:`,
          `- Name: ${config.agentName}`,
          `- Description: ${config.agentDescription}`,
          `Use \`${toolName}\` when the task matches this agent's described specialty. `,
          'Give it a complete, standalone task because it does not inherit this conversation. ',
          'Do not assume capabilities outside the description.',
        ].join('\n'),
  })
}
