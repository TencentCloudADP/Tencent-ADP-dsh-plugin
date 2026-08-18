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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function pickString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

/** Public-cloud `DescribeModelList` nests ids under `ModelBasic`; independent-site rows are flat. */
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
    const basic = asRecord(row.ModelBasic)
    const id = pickString(basic?.ModelId, basic?.Model, basic?.Id, row.ModelId, row.Model, row.ModelName, row.Id, row.Name)
    if (!id) continue
    const name = pickString(basic?.ModelName, basic?.Name, row.ModelName, row.Name, id)
    const ctx = Number(
      basic?.ContextWindow ?? basic?.MaxTokens ?? basic?.ContextLength
      ?? row.ContextWindow ?? row.MaxTokens ?? row.ContextLength ?? 0,
    )
    out.push({
      id,
      name,
      ...Number.isFinite(ctx) && ctx > 0 ? { contextWindow: ctx } : {},
    })
  }
  return out
}
