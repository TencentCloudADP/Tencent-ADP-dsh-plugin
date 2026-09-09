/** Session-backed proxy run: ADP remains remote while DSH sees a native child. */

import { randomUUID } from 'node:crypto'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  childSessionMeta,
  resolveChildAgentOptions,
  resolveChildDepth,
  type ResolvedSubagentStartRequest,
  type SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import { startAdpRun, type AdpRunSpec } from './client.ts'
import { AdpNativeTranscript } from './transcript.ts'

/** Create one real child Agent whose session mirrors an ADP SSE conversation. */
export async function startAdpProxyRun(
  request: ResolvedSubagentStartRequest,
  spec: AdpRunSpec,
  provider: string,
  maxTraceChars: number,
): Promise<SubagentRun> {
  if (request.signal.aborted) {
    throw new Error('subagent request was aborted before the ADP proxy child started')
  }

  const childId = SessionId(randomUUID())
  const childDepth = resolveChildDepth(request.parent, request.maxDepth)
  let handle: AgentHandle | undefined
  try {
    handle = await request.parent.ctx.agents.create({
      sessionId: childId,
      meta: childSessionMeta(request.parent, childDepth, 0),
      agentOptions: resolveChildAgentOptions(request.parent, request.agentOptions, childDepth),
      signal: request.signal,
    })
  } catch (error: unknown) {
    throw error
  }

  const transcript = new AdpNativeTranscript(handle.agent.session, {
    provider,
    model: spec.modelName ?? spec.agentId ?? 'tencent-adp',
    maxTraceChars,
  })
  try {
    transcript.start(request.prompt, request.descriptor)
  } catch (error: unknown) {
    await handle.dispose().catch(() => {})
    throw error
  }

  let remote: SubagentRun
  let runFailure: Error | undefined
  try {
    remote = await startAdpRun(request, {
      ...spec,
      runId: childId,
      onEvent: (eventName, data) => { transcript.accept(eventName, data) },
      onError: (error, stopReason) => {
        runFailure = error
        spec.onError?.(error, stopReason)
      },
    })
  } catch (error: unknown) {
    transcript.finish(
      { output: [], stopReason: 'error' },
      error instanceof Error ? error : new Error(String(error)),
    )
    await handle.dispose().catch(() => {})
    throw error
  }

  const result = remote.result.then((settled) => {
    transcript.finish(settled, runFailure)
    return settled
  }, (error: unknown) => {
    transcript.finish(
      { output: [], stopReason: 'error' },
      error instanceof Error ? error : new Error(String(error)),
    )
    throw error
  })

  let disposal: Promise<void> | undefined
  return {
    id: childId,
    localAgent: handle.agent,
    result,
    dispose(): Promise<void> {
      disposal ??= (async () => {
        const remoteSettlements = await Promise.allSettled([remote.dispose(), result])
        const childDisposal = await Promise.allSettled([handle.dispose()])
        const failure = remoteSettlements[0].status === 'rejected'
          ? remoteSettlements[0].reason
          : childDisposal[0].status === 'rejected' ? childDisposal[0].reason : undefined
        if (failure !== undefined) throw failure
      })()
      return disposal
    },
  }
}
