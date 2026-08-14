export type LoginUrlClientResult =
  | { ok: true; login_url: string; landing_host?: string; cookie_name?: string }
  | { ok: false; error: string }

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** Parse the host proxy body without throwing on empty or non-JSON responses. */
export function parseLoginUrlBody(status: number, body: string): LoginUrlClientResult {
  const trimmed = body.trim()
  if (!trimmed) {
    return { ok: false, error: `Login proxy returned HTTP ${status} with an empty body.` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { ok: false, error: `Login proxy returned HTTP ${status} with non-JSON content.` }
  }
  const data = asRecord(parsed)
  if (!data) {
    return { ok: false, error: `Login proxy returned HTTP ${status} with an unexpected payload.` }
  }
  const loginUrl = typeof data.login_url === 'string' ? data.login_url : ''
  if (data.ok === true && loginUrl) {
    return {
      ok: true,
      login_url: loginUrl,
      ...typeof data.landing_host === 'string' ? { landing_host: data.landing_host } : {},
      ...typeof data.cookie_name === 'string' ? { cookie_name: data.cookie_name } : {},
    }
  }
  const error = typeof data.error === 'string' && data.error
    ? data.error
    : `Could not start OneID login (HTTP ${status}).`
  return { ok: false, error }
}

export async function readLoginUrlResponse(res: Response): Promise<LoginUrlClientResult> {
  return parseLoginUrlBody(res.status, await res.text())
}

export async function fetchLoginUrlProxy(): Promise<LoginUrlClientResult> {
  try {
    const res = await fetch('/adp/account/login-url', {
      method: 'POST',
      headers: { accept: 'application/json' },
    })
    return await readLoginUrlResponse(res)
  } catch (caught) {
    return { ok: false, error: caught instanceof Error ? caught.message : String(caught) }
  }
}
