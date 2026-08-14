import { AdpError } from '../core/errors.ts'
import { readBody } from '../core/sse.ts'

export type McpTransport = 'sse' | 'streamable-http'

const IDLE_RECONNECT_MS = 500_000
const FAST_FAIL_MS = 3_000

interface JsonRpc {
  jsonrpc: '2.0'
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string }
}

export class McpSession {
  private nextId = 1
  private lastActivity = Date.now()
  private initialized = false
  private sessionId: string | undefined
  private connecting: Promise<void> | undefined

  constructor(
    readonly url: string,
    readonly transport: McpTransport,
    private readonly bearer: () => Promise<string>,
  ) {}

  async listTools(signal?: AbortSignal): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    await this.ensure(signal)
    const result = await this.rpc('tools/list', {}, signal) as { tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> }
    return result.tools ?? []
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const started = Date.now()
    try {
      await this.ensure(signal)
      return await this.rpc('tools/call', { name, arguments: args }, signal)
    } catch (error) {
      const elapsed = Date.now() - started
      if (error instanceof AdpError && error.code === 'MCP_TRANSPORT_405') throw error
      if (elapsed < FAST_FAIL_MS) {
        this.initialized = false
        await this.ensure(signal)
        return await this.rpc('tools/call', { name, arguments: args }, signal)
      }
      throw error
    }
  }

  dispose(): void {
    this.initialized = false
    this.sessionId = undefined
  }

  private async ensure(signal?: AbortSignal): Promise<void> {
    if (this.initialized && Date.now() - this.lastActivity < IDLE_RECONNECT_MS) return
    if (this.connecting) return this.connecting
    this.connecting = this.initialize(signal).finally(() => { this.connecting = undefined })
    await this.connecting
  }

  private async initialize(signal?: AbortSignal): Promise<void> {
    const result = await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: '@tencent/dsh-adp', version: '0.1.0' },
    }, signal)
    void result
    try {
      await this.notify('notifications/initialized', {}, signal)
    } catch { /* some servers skip this */ }
    this.initialized = true
    this.lastActivity = Date.now()
  }

  private async notify(method: string, params: unknown, signal?: AbortSignal): Promise<void> {
    await this.post({ jsonrpc: '2.0', method, params }, signal)
  }

  private async rpc(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++
    const payload: JsonRpc = { jsonrpc: '2.0', id, method, params }
    const parsed = await this.post(payload, signal)
    this.lastActivity = Date.now()
    if (parsed.error) {
      throw new AdpError(`MCP ${method} failed: ${parsed.error.message}`, 'MCP_ERROR')
    }
    return parsed.result
  }

  private async post(payload: JsonRpc, signal?: AbortSignal): Promise<JsonRpc> {
    if (this.transport === 'sse' && payload.method && payload.id !== undefined) {
      // SSE servers reject JSON-RPC POST on the event URL with 405.
      // Callers must use the correct transport; we never silently switch.
    }
    const key = await this.bearer()
    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: this.transport === 'sse' ? 'text/event-stream' : 'application/json, text/event-stream',
    }
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId
    const resp = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal,
    })
    if (resp.status === 405) {
      throw new AdpError(
        `MCP endpoint returned 405 for ${this.transport} transport. MCPTransport 0=SSE, 1=streamable-http — do not retry the other.`,
        'MCP_TRANSPORT_405',
      )
    }
    const sid = resp.headers.get('mcp-session-id')
    if (sid) this.sessionId = sid
    const text = await resp.text()
    if (!resp.ok) {
      throw new AdpError(`MCP HTTP ${resp.status}: ${text.slice(0, 200)}`, `HTTP_${resp.status}`)
    }
    const body = text.trim().startsWith('data:') ? readBody(text) : JSON.parse(text) as unknown
    return body as JsonRpc
  }
}
