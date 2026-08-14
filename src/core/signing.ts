import { createHmac, createHash } from 'node:crypto'

export const ALGORITHM = 'TC3-HMAC-SHA256'
export const CONTENT_TYPE = 'application/json; charset=utf-8'

function hmacSha256(key: Buffer, msg: string): Buffer {
  return createHmac('sha256', key).update(msg, 'utf8').digest()
}

function sha256Hex(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

export interface SignRequestInput {
  secretId: string
  secretKey: string
  payload: string
  timestamp: number
  host: string
  service: string
  action: string
}

/** Canonical request string — exported so tests can pin host/vendor switches. */
export function canonicalRequest(input: Pick<SignRequestInput, 'payload' | 'host' | 'action'>): string {
  const canonicalHeaders =
    `content-type:${CONTENT_TYPE}\nhost:${input.host}\nx-tc-action:${input.action.toLowerCase()}\n`
  const signedHeaders = 'content-type;host;x-tc-action'
  return ['POST', '/', '', canonicalHeaders, signedHeaders, sha256Hex(input.payload)].join('\n')
}

export function stringToSign(input: SignRequestInput & { date: string }): string {
  const credentialScope = `${input.date}/${input.service}/tc3_request`
  return [ALGORITHM, String(input.timestamp), credentialScope, sha256Hex(canonicalRequest(input))].join('\n')
}

export function signRequest(input: SignRequestInput): string {
  const date = new Date(input.timestamp * 1000).toISOString().slice(0, 10)
  const credentialScope = `${date}/${input.service}/tc3_request`
  const toSign = stringToSign({ ...input, date })
  const secretDate = hmacSha256(Buffer.from(`TC3${input.secretKey}`, 'utf8'), date)
  const secretService = hmacSha256(secretDate, input.service)
  const secretSigning = hmacSha256(secretService, 'tc3_request')
  const signature = createHmac('sha256', secretSigning).update(toSign, 'utf8').digest('hex')
  return (
    `${ALGORITHM} Credential=${input.secretId}/${credentialScope}, ` +
    `SignedHeaders=content-type;host;x-tc-action, Signature=${signature}`
  )
}

export interface BuildHeadersInput extends SignRequestInput {
  version: string
  region?: string
}

export function buildHeaders(input: BuildHeadersInput): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: signRequest(input),
    'Content-Type': CONTENT_TYPE,
    Host: input.host,
    'X-TC-Action': input.action,
    'X-TC-Version': input.version,
    'X-TC-Timestamp': String(input.timestamp),
  }
  if (input.region) headers['X-TC-Region'] = input.region
  return headers
}
