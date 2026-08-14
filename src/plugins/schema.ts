import type { ParameterPropertySpec, ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { ParamDecl } from '../core/service.ts'

const TYPES: Record<number, 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array'> = {
  0: 'string',
  1: 'integer',
  2: 'number',
  3: 'boolean',
  4: 'object',
  5: 'array',
  6: 'array',
  9: 'array',
}

const ARRAY_ITEM: Record<number, 'string' | 'integer'> = { 5: 'string', 6: 'integer' }

export function paramToSpec(param: ParamDecl): ParameterPropertySpec {
  const kind = TYPES[param.type ?? -1] ?? 'string'
  const description = param.description.trim() || undefined
  const required = param.required ? { required: true as const } : {}
  if (kind === 'object') {
    const properties: ParameterSchemaSpec = {}
    for (const sub of param.subParams) {
      if (!sub.name) continue
      properties[sub.name] = paramToSpec(sub)
    }
    return {
      type: 'object',
      additionalProperties: false,
      ...Object.keys(properties).length ? { properties } : {},
      ...description ? { description } : {},
      ...required,
    }
  }
  if (kind === 'array') {
    const items = param.subParams.length > 0
      ? {
          type: 'object' as const,
          additionalProperties: false,
          properties: Object.fromEntries(
            param.subParams.filter((s) => s.name).map((s) => [s.name, paramToSpec(s)]),
          ) as ParameterSchemaSpec,
        }
      : { type: ARRAY_ITEM[param.type ?? 5] ?? 'string' as const }
    return {
      type: 'array',
      items,
      ...description ? { description } : {},
      ...required,
    }
  }
  return {
    type: kind,
    ...description ? { description } : {},
    ...required,
  }
}

export function schemaFor(body: ParamDecl[]): ParameterSchemaSpec {
  const properties: ParameterSchemaSpec = {}
  for (const param of body) {
    if (!param.name) continue
    properties[param.name] = paramToSpec(param)
  }
  return properties
}
