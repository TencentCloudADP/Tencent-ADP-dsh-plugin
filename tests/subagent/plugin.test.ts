import { Context } from '@deepseek-ai/cordis'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import * as adp from '../../src/subagent/index.ts'
import * as adpTool from '../../src/subagent/tool.ts'

describe('subagent-adp plugin', () => {
  it('registers an HMR-safe one-shot provider with no parent-enforced capabilities', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    const handle = await ctx.plugin(adp, {})

    expect(ctx.subagents.getProvider('adp')).toMatchObject({
      name: 'adp',
      capabilities: {
        outputSchema: false,
        depthLimit: false,
        toolFilter: false,
        persona: false,
      },
      inheritsParentContext: false,
    })

    await handle.dispose()
    expect(ctx.subagents.getProvider('adp')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('fails loud for invalid endpoint and credential reference config', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)

    await expect(ctx.plugin(adp, { endpoint: 'ftp://example.test/chat' })).rejects.toThrow('protocol must be http or https')
    await expect(ctx.plugin(adp, { appKeyEnv: 'not a valid ref' })).rejects.toThrow('credential ref')
    await ctx.fiber.dispose()
  })

  it('shows the configured external agent name and description to the main agent', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(adp, {})
    const handle = await ctx.plugin(adpTool, {
      provider: 'adp',
      toolName: 'ask_policy_expert',
      agentName: '企业制度专家',
      agentDescription: '查询企业制度和审批流程；不处理代码开发。',
      maxDepth: 'provider-managed',
      enableRunInBackground: false,
    })

    expect(ctx.tools.get('ask_policy_expert')).toBeDefined()
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.find(section => section.name === 'tool:ask_policy_expert:agent-identity')?.text)
      .toContain('Name: 企业制度专家')
    expect(assembly.sections.find(section => section.name === 'tool:ask_policy_expert:agent-identity')?.text)
      .toContain('Description: 查询企业制度和审批流程；不处理代码开发。')

    await handle.dispose()
    expect(ctx.tools.get('ask_policy_expert')).toBeUndefined()
    expect((await ctx.systemPrompt.assemble()).sections.map(section => section.name))
      .not.toContain('tool:ask_policy_expert:agent-identity')
    await ctx.fiber.dispose()
  })

  it('rejects blank model-visible agent identity', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(SubagentRuntime)

    await expect(ctx.plugin(adpTool, {
      provider: 'adp',
      agentName: ' ',
      agentDescription: 'description',
      maxDepth: 'provider-managed',
    })).rejects.toThrow('agentName must not be blank')
    await ctx.fiber.dispose()
  })
})
