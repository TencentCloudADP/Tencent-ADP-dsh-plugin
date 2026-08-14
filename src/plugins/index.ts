import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue, ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import { AdpError, INVALID_CREDENTIAL, MISSING_CREDENTIAL } from '../core/errors.ts'
import { pluginToolName } from '../core/names.ts'
import type { ApiToolInfo, PluginDetail } from '../core/service.ts'
import { isExternallyCallable } from '../core/service.ts'
import { McpSession } from './mcp.ts'
import { schemaFor } from './schema.ts'

export const name = 'plugins-adp'
export const inject = ['tools', 'adp']

export interface Config {
  enabledPluginIds?: string[]
  harvestMedia?: boolean
  workspaceDir?: string
}

export const Config: z<Config> = z.object({
  enabledPluginIds: z.array(z.string()).default([]),
  harvestMedia: z.boolean().default(true),
  workspaceDir: z.string(),
})

export function apply(ctx: Context, config: Config): void {
  const enabled = new Set<string>(config.enabledPluginIds ?? [])
  const sessions = new Map<string, McpSession>()

  ctx.effect(() => () => {
    for (const session of sessions.values()) session.dispose()
    sessions.clear()
    enabled.clear()
  })

  ctx.tools.register(defineTool({
    name: 'adp_plugin_list',
    description:
      'List ADP marketplace plugins that can be called from this machine (API or MCP with an external URL). Availability comes from DescribePlugin, not the catalogue AllowExternalAccess flag.',
    parameters: {
      query: { type: 'string', description: 'Optional fuzzy search.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          plugins: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                pluginId: { type: 'string', required: true },
                name: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                enabled: { type: 'boolean', required: true },
                description: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value.plugins, null, 2) }],
    },
    async execute(args, exec) {
      const usable = await ctx.adp.usablePlugins(16, exec.signal)
      const q = args.query?.toLowerCase() ?? ''
      const plugins = usable
        .filter((p) => !q || p.name.toLowerCase().includes(q) || p.pluginId.includes(q))
        .map((p) => ({
          pluginId: p.pluginId,
          name: p.name,
          kind: p.mcpUrl ? 'mcp' : 'api',
          enabled: enabled.has(p.pluginId),
          ...p.description ? { description: p.description } : {},
        }))
      return { plugins }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'adp_plugin_enable',
    description:
      'Enable an ADP API/MCP plugin for this session so its tools are registered. Pass pluginId from adp_plugin_list. Does not persist across restarts; put the id in plugins-adp enabledPluginIds for that.',
    parameters: {
      pluginId: { type: 'string', required: true, description: 'ADP PluginId to enable.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pluginId: { type: 'string', required: true },
          registered: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `enabled ${value.pluginId}: ${value.registered.join(', ') || 'no tools'}` }],
    },
    async execute(args, exec) {
      const detail = await ctx.adp.describePlugin(args.pluginId, exec.signal)
      if (!isExternallyCallable(detail)) {
        throw new AdpError(
          `Plugin ${args.pluginId} has no external API/MCP URL (or needs a plugin-owned header). Code and app plugins are not registered as HTTP tools.`,
          'PLUGIN_UNUSABLE',
        )
      }
      enabled.add(args.pluginId)
      const registered = await registerPluginTools(ctx, detail, sessions)
      return { pluginId: args.pluginId, registered }
    },
  }))

  void (async () => {
    for (const id of enabled) {
      try {
        const detail = await ctx.adp.describePlugin(id)
        if (isExternallyCallable(detail)) await registerPluginTools(ctx, detail, sessions)
      } catch (error) {
        ctx.logger.warn('plugins-adp: failed to enable %s', id)
        ctx.logger.warn(error)
      }
    }
  })()

  if (config.harvestMedia !== false) {
    ctx.on('tools/post-execute', async (exec, result, next) => {
      if (!exec.name.startsWith('adp_p__') && !exec.name.startsWith('adp_mcp__')) return next()
      const accepted = await next()
      if (accepted.kind !== 'accept') return accepted
      const value = 'value' in accepted && accepted.value !== undefined
        ? accepted.value
        : !result.isError ? result.value : undefined
      if (value === undefined) return accepted
      const harvested = await ctx.adp.harvest(value, exec.signal)
      if (harvested === value) return accepted
      return { kind: 'accept', value: harvested as never }
    })
  }
}

async function registerPluginTools(
  ctx: Context,
  detail: PluginDetail,
  sessions: Map<string, McpSession>,
): Promise<string[]> {
  const names: string[] = []
  if (detail.mcpUrl) {
    const session = getSession(ctx, detail, sessions)
    const tools = await session.listTools()
    for (const tool of tools) {
      const toolName = `adp_mcp__${pluginToolName(tool.name, tool.name).replace(/^adp_p__/, '')}`.slice(0, 60)
      names.push(toolName)
      ctx.tools.register(defineTool({
        name: toolName,
        description: `${detail.name} · ${tool.name}. ${tool.description ?? ''}`.trim(),
        parameters: jsonSchemaToParams(tool.inputSchema),
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(args, exec) {
          try {
            return await session.callTool(tool.name, args as Record<string, unknown>, exec.signal) as JsonValue
          } catch (error) {
            if (error instanceof AdpError && (error.code === MISSING_CREDENTIAL || error.code === INVALID_CREDENTIAL)) throw error
            throw error
          }
        },
      }))
    }
    return names
  }

  const seen = new Map<string, number>()
  for (const tool of detail.apiTools) {
    const bare = pluginToolName(tool.name, tool.toolId)
    seen.set(bare, (seen.get(bare) ?? 0) + 1)
  }
  for (const tool of detail.apiTools) {
    const bare = pluginToolName(tool.name, tool.toolId)
    const toolName = (seen.get(bare) ?? 0) > 1
      ? pluginToolName(tool.name, tool.toolId, detail.pluginId.slice(0, 4))
      : bare
    names.push(toolName)
    ctx.tools.register(defineApiTool(ctx, detail, tool, toolName))
  }
  return names
}

function defineApiTool(ctx: Context, detail: PluginDetail, tool: ApiToolInfo, toolName: string) {
  return defineTool({
    name: toolName,
    description: `${detail.name} · ${tool.name}. ${tool.description}`.trim(),
    parameters: schemaFor(tool.body),
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      return ctx.adp.pluginFetch(tool.url, args, exec.signal) as Promise<JsonValue>
    },
  })
}

function getSession(ctx: Context, detail: PluginDetail, sessions: Map<string, McpSession>): McpSession {
  const existing = sessions.get(detail.pluginId)
  if (existing) return existing
  const session = new McpSession(detail.mcpUrl, detail.mcpTransport, () => ctx.adp.resolveGatewayKey())
  sessions.set(detail.pluginId, session)
  ctx.effect(() => () => {
    session.dispose()
    sessions.delete(detail.pluginId)
  })
  return session
}

function jsonSchemaToParams(schema: unknown): ParameterSchemaSpec {
  if (!schema || typeof schema !== 'object') return {}
  const rec = schema as { properties?: Record<string, Record<string, unknown>>; required?: string[] }
  const required = new Set(rec.required ?? [])
  const out: ParameterSchemaSpec = {}
  for (const [key, prop] of Object.entries(rec.properties ?? {})) {
    const type = String(prop.type ?? 'string')
    const description = typeof prop.description === 'string' ? prop.description : undefined
    const req = required.has(key) ? { required: true as const } : {}
    if (type === 'object') {
      out[key] = { type: 'object', additionalProperties: false, ...description ? { description } : {}, ...req }
    } else if (type === 'array') {
      out[key] = { type: 'array', ...description ? { description } : {}, ...req }
    } else if (type === 'integer' || type === 'number' || type === 'boolean') {
      out[key] = { type: type as 'integer' | 'number' | 'boolean', ...description ? { description } : {}, ...req }
    } else {
      out[key] = { type: 'string', ...description ? { description } : {}, ...req }
    }
  }
  return out
}
