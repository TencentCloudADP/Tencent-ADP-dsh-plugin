export const BUILTIN_MODELS = [
  { id: 'Hunyuan/hy3', name: 'Hunyuan hy3', contextWindow: 256_000 },
  { id: 'Deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 1_000_000 },
  { id: 'Deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 1_000_000 },
  { id: 'TCADP/glm-5.1', name: 'GLM-5.1', contextWindow: 200_000 },
  { id: 'TCADP/kimi-k2.6', name: 'Kimi K2.6', contextWindow: 200_000 },
  { id: 'TCADP/minimax-m2.5', name: 'MiniMax M2.5', contextWindow: 200_000 },
] as const

/** Agent thinking catalog. Claw uses ModelScene=18. */
export const MODEL_SCENE_AGENT = 3
export const MODEL_SCENE_CLAW = 18

export function normalizeModelList(data: Record<string, unknown>): Array<{ id: string; name: string; contextWindow?: number }> {
  const lists = [
    data.ModelList,
    data.Models,
    data.ModelInfoList,
    data.List,
  ]
  const rows = lists.find((v) => Array.isArray(v)) as Array<Record<string, unknown>> | undefined
  if (!rows) return []
  const out: Array<{ id: string; name: string; contextWindow?: number }> = []
  for (const row of rows) {
    const id = String(row.ModelId ?? row.Model ?? row.Id ?? row.Name ?? '')
    if (!id) continue
    const name = String(row.ModelName ?? row.Name ?? id)
    const ctx = Number(row.ContextWindow ?? row.MaxTokens ?? row.ContextLength ?? 0)
    out.push({
      id,
      name,
      ...Number.isFinite(ctx) && ctx > 0 ? { contextWindow: ctx } : {},
    })
  }
  return out
}
