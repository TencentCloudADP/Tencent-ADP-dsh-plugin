export class AdpError extends Error {
  readonly code: string
  override readonly cause?: unknown

  constructor(message: string, code: string, cause?: unknown) {
    super(message)
    this.name = 'AdpError'
    this.code = code
    this.cause = cause
  }
}

export const MISSING_CREDENTIAL = 'MISSING_CREDENTIAL'
export const INVALID_CREDENTIAL = 'INVALID_CREDENTIAL'

export function redactSecret(value: string): string {
  if (value.length <= 8) return '***'
  return `${value.slice(0, 4)}…${value.slice(-2)}`
}

export function errorWithoutSecret(message: string, secret?: string): string {
  if (!secret) return message
  return message.split(secret).join(redactSecret(secret))
}
