import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../fixtures')

export function loadFixture(rel: string): string {
  return readFileSync(join(FIXTURES, rel), 'utf8')
}

export interface MockCall {
  method: string
  url: string
  action?: string
  body: string
  headers: Record<string, string | string[] | undefined>
}

export interface MockAdpServer {
  origin: string
  host: string
  calls: MockCall[]
  releaseStatus: number
  describeAppWithMask: boolean
  skillHasMarkdown: boolean
  close(): Promise<void>
}

function header(req: IncomingMessage, name: string): string {
  const raw = req.headers[name.toLowerCase()]
  return Array.isArray(raw) ? raw[0] ?? '' : raw ?? ''
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

export async function startMockAdp(options: { workspace?: string } = {}): Promise<MockAdpServer> {
  void options
  const calls: MockCall[] = []
  const state: MockAdpServer = {
    origin: '',
    host: '',
    calls,
    releaseStatus: 3,
    describeAppWithMask: true,
    skillHasMarkdown: true,
    close: async () => undefined,
  }

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/'
    const method = req.method ?? 'GET'
    const body = method === 'GET' || method === 'HEAD' ? '' : await readBody(req)
    const action = header(req, 'x-tc-action')
    calls.push({ method, url, action: action || undefined, body, headers: { ...req.headers } })

    const send = (status: number, payload: unknown, contentType = 'application/json') => {
      res.statusCode = status
      res.setHeader('content-type', contentType)
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload))
    }
    const sse = (status: number, text: string) => {
      res.statusCode = status
      res.setHeader('content-type', 'text/event-stream')
      const body = text.endsWith('\n\n') ? text : `${text.replace(/\s+$/, '')}\n\n`
      res.end(body)
    }

    try {
      if (url === '/' || url === '/?') {
        return send(200, controlResponse(action, body, state))
      }
      if (url.startsWith('/chat/completions')) {
        const auth = header(req, 'authorization')
        if (auth.includes('sk-bad')) {
          res.statusCode = 401
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ error: { message: 'invalid api key' } }))
          return
        }
        return sse(200, loadFixture('gateway/tool-call.sse'))
      }
      if (url.includes('/plugin/api/v1/')) {
        if (url.includes('16bfcfea')) return sse(200, loadFixture('plugin/search-cumulative.sse'))
        return sse(200, loadFixture('plugin/api-cumulative.sse'))
      }
      if (url.startsWith('/adp/v2/chat')) {
        const payload = JSON.parse(body || '{}') as { Contents?: Array<{ Text?: string }> }
        const text = JSON.stringify(payload.Contents ?? [])
        if (text.includes('file-please')) {
          return sse(200, loadFixture('chat/file.sse').replaceAll('COS/', `${state.origin}/cos/`))
        }
        return sse(200, loadFixture('chat/thought-reply.sse'))
      }
      if (url.startsWith('/mcp/sse')) {
        res.statusCode = 405
        res.end('method not allowed')
        return
      }
      if (url.startsWith('/mcp/streamable')) {
        const rpc = JSON.parse(body || '{}') as { method?: string; id?: number }
        if (rpc.method === 'initialize') {
          return send(200, { jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock' } } })
        }
        if (rpc.method === 'notifications/initialized') return send(200, {})
        if (rpc.method === 'tools/list') {
          return send(200, {
            jsonrpc: '2.0',
            id: rpc.id,
            result: { tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object', properties: {} } }] },
          })
        }
        if (rpc.method === 'tools/call') {
          return send(200, { jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: 'pong' }] } })
        }
        return send(200, { jsonrpc: '2.0', id: rpc.id, result: {} })
      }
      if (url.startsWith('/cos/')) {
        res.statusCode = 200
        res.setHeader('content-type', 'image/png')
        res.end(Buffer.from('89504e470d0a1a0a', 'hex'))
        return
      }
      if (url.startsWith('/skills/hello.md')) {
        res.statusCode = 200
        res.setHeader('content-type', 'text/markdown')
        res.end('# Hello Skill\n\nDo the thing.\n')
        return
      }
      if (url.startsWith('/account/login-url')) {
        const payload = (() => {
          try { return JSON.parse(body || '{}') as { login_platform?: string } } catch { return {} }
        })()
        if (payload.login_platform !== 'oneid') {
          return send(200, { reqId: 'x', code: 19000, message: 'RemoteServerError', data: {} })
        }
        return send(200, JSON.parse(loadFixture('account/login-url.json')))
      }
      send(404, { error: 'not found', url })
    } catch (error) {
      send(500, { error: String(error) })
    }
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('mock server failed to bind')
  state.origin = `http://127.0.0.1:${addr.port}`
  state.host = `127.0.0.1:${addr.port}`
  state.close = () => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
  return state
}

function controlResponse(action: string, body: string, state: MockAdpServer): { Response: Record<string, unknown> } {
  const origin = state.origin
  const payload = (() => {
    try { return JSON.parse(body || '{}') as Record<string, unknown> } catch { return {} }
  })()

  switch (action) {
    case 'DescribePluginSummaryList': {
      const page = Number(payload.PageNumber ?? 0)
      if (page === 0) return json(loadFixture('control/plugin-summary-page0.json'), origin)
      if (page === 1) return json(loadFixture('control/plugin-summary-page1.json'), origin)
      return { Response: { PluginList: [], TotalCount: 3, RequestId: 'empty' } }
    }
    case 'DescribePlugin': {
      const id = String(payload.PluginId ?? '')
      if (id === 'plugin-usable-listed-false') return json(loadFixture('control/plugin-detail-usable.json'), origin)
      if (id === 'plugin-no-url') return json(loadFixture('control/plugin-detail-no-url.json'), origin)
      if (id === 'plugin-empty-header') return json(loadFixture('control/plugin-detail-empty-header.json'), origin)
      if (id === 'plugin-mcp') return json(loadFixture('control/plugin-detail-mcp.json'), origin)
      if (id === 'plugin-api') return json(loadFixture('control/plugin-detail-api.json'), origin)
      return json(loadFixture('control/plugin-detail-usable.json'), origin)
    }
    case 'DescribeModelList':
      return json(loadFixture('control/model-list.json'))
    case 'DescribeSpaceList':
      return { Response: { RequestId: 'spaces', SpaceList: [{ SpaceId: 'space-1', Name: 'Mock space' }] } }
    case 'DescribeApp': {
      const mask = payload.FieldMask as { Paths?: string[] } | undefined
      const paths = mask?.Paths ?? []
      if (paths.includes('SecretInfo') && state.describeAppWithMask) {
        return json(loadFixture('control/describe-app-with-mask.json'))
      }
      return json(loadFixture('control/describe-app-no-mask.json'))
    }
    case 'GetAppSecret':
      return state.describeAppWithMask
        ? { Response: { RequestId: 'x', AppKey: 'appkey-from-lke' } }
        : { Response: { RequestId: 'x' } }
    case 'CreateApp':
      return { Response: { RequestId: 'x', AppId: 'app-1' } }
    case 'CreateAgent':
      return { Response: { RequestId: 'x', AgentId: 'agent-1' } }
    case 'CreateRelease':
      return { Response: { RequestId: 'x', ReleaseId: 'rel-1' } }
    case 'DescribeReleaseSummary':
      if (!payload.ReleaseId) {
        return {
          Response: {
            Error: {
              Code: 'MissingParameter',
              Message: 'The request is missing the required parameter `ReleaseId`.',
            },
            RequestId: 'x',
          },
        }
      }
      return {
        Response: {
          RequestId: 'x',
          ReleaseSummary: { ReleaseId: payload.ReleaseId, Status: state.releaseStatus },
        },
      }
    case 'CreateConversation':
      return { Response: { RequestId: 'x', ConversationId: 'conv-official' } }
    case 'DescribeSkillSummaryList':
      return json(loadFixture('control/skill-summary.json'))
    case 'DescribeSkillDetail': {
      const id = String(payload.SkillId ?? '')
      if (id === 'skill-empty' || !state.skillHasMarkdown) return json(loadFixture('control/skill-detail-empty.json'), origin)
      return json(loadFixture('control/skill-detail-md.json'), origin)
    }
    case 'DeleteApp':
      return { Response: { RequestId: 'deleted' } }
    default:
      return { Response: { RequestId: 'ok' } }
  }
}

function json(text: string, origin?: string): { Response: Record<string, unknown> } {
  const rewritten = origin
    ? text.replaceAll('PLUGIN', origin).replaceAll('SKILL_MD', `${origin}/skills/hello.md`)
    : text
  return JSON.parse(rewritten) as { Response: Record<string, unknown> }
}
