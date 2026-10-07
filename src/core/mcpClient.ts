import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { discoverWorkspaceCapabilities, type MCPManifest } from './capabilityRuntime'
import { safeJoinUnder } from './workspace'
import type { WorkspaceBinding } from './types'

export type DynamicMcpTool = {
  runtimeName: string
  serverId: string
  toolName: string
  description: string
  inputSchema: Record<string, unknown>
}

function normalizeName(value: string) {
  return value.replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'tool'
}

function substitutedEnv(manifest: MCPManifest, workspace: WorkspaceBinding) {
  return Object.fromEntries(
    Object.entries(manifest.env ?? {}).map(([key, value]) => [
      key,
      String(value).replaceAll('${workspaceRoot}', workspace.root),
    ]),
  )
}

function jsonRpcUrl(manifest: MCPManifest) {
  if (!manifest.url) throw new Error(`MCP ${manifest.id} requires url for ${manifest.transport} transport`)
  return manifest.url
}

async function parseHttpMcpResponse(response: Response) {
  const text = await response.text()
  const contentType = response.headers.get('content-type') ?? ''
  if (!response.ok) {
    throw new Error(`MCP HTTP request returned ${response.status}: ${text.slice(0, 500)}`)
  }

  if (/text\/event-stream/i.test(contentType) || text.includes('\ndata:')) {
    const dataLine = text
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim())
      .find(line => line && line !== '[DONE]')
    if (!dataLine) return {}
    return JSON.parse(dataLine) as Record<string, unknown>
  }

  return text.trim() ? JSON.parse(text) as Record<string, unknown> : {}
}

async function httpMcpRequest(
  manifest: MCPManifest,
  workspace: WorkspaceBinding,
  method: string,
  params?: Record<string, unknown>,
) {
  const env = substitutedEnv(manifest, workspace)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: manifest.transport === 'sse' ? 'application/json, text/event-stream' : 'application/json',
  }
  const authorization = env.AUTHORIZATION || env.MCP_AUTHORIZATION || env.COG_CLAW_MCP_AUTHORIZATION
  if (authorization) headers.authorization = authorization.startsWith('Bearer ') ? authorization : `Bearer ${authorization}`

  const response = await fetch(jsonRpcUrl(manifest), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params: params ?? {},
    }),
  })
  const message = await parseHttpMcpResponse(response)
  if (message.error && typeof message.error === 'object') {
    const error = message.error as { message?: string }
    throw new Error(error.message || 'MCP HTTP request failed')
  }
  return (message.result ?? message) as Record<string, unknown>
}

function parseMcpFrames(buffer: Buffer) {
  const messages: Array<Record<string, unknown>> = []
  let rest = buffer
  while (true) {
    const headerEnd = rest.indexOf('\r\n\r\n')
    if (headerEnd < 0) break
    const header = rest.subarray(0, headerEnd).toString('utf-8')
    const match = /Content-Length:\s*(\d+)/i.exec(header)
    if (!match) break
    const length = Number(match[1])
    const start = headerEnd + 4
    if (rest.length < start + length) break
    const raw = rest.subarray(start, start + length).toString('utf-8')
    messages.push(JSON.parse(raw) as Record<string, unknown>)
    rest = rest.subarray(start + length)
  }
  return { messages, rest }
}

class StdioMcpSession {
  private nextId = 1
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  private pending = new Map<number, {
    resolve: (value: Record<string, unknown>) => void
    reject: (error: Error) => void
  }>()
  private readonly process

  constructor(
    private readonly manifest: MCPManifest,
    private readonly workspace: WorkspaceBinding,
  ) {
    const manifestEnv = substitutedEnv(this.manifest, this.workspace)
    this.process = spawn(this.manifest.command ?? 'node', this.manifest.args ?? [], {
      cwd: this.workspace.root,
      env: {
        ...process.env,
        ...manifestEnv,
        COG_CLAW_WORKSPACE: manifestEnv.COG_CLAW_WORKSPACE || this.workspace.root,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
  }

  async start() {
    this.process.stdout.on('data', chunk => {
      this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)])
      const parsed = parseMcpFrames(this.buffer)
      this.buffer = parsed.rest
      for (const message of parsed.messages) {
        const id = typeof message.id === 'number' ? message.id : undefined
        if (id === undefined) continue
        const pending = this.pending.get(id)
        if (!pending) continue
        this.pending.delete(id)
        if (message.error && typeof message.error === 'object') {
          const error = message.error as { message?: string }
          pending.reject(new Error(error.message || 'MCP request failed'))
        } else {
          pending.resolve((message.result ?? {}) as Record<string, unknown>)
        }
      }
    })
    this.process.stderr.on('data', () => {
      // stderr is surfaced by request timeout/errors; avoid noisy live logs.
    })
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'cogclaw-runtime', version: '2.0.0' },
    })
  }

  request(method: string, params?: Record<string, unknown>, timeoutMs = 15_000) {
    const id = this.nextId++
    const raw = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} })
    const framed = `Content-Length: ${Buffer.byteLength(raw)}\r\n\r\n${raw}`
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP request timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve(value) {
          clearTimeout(timer)
          resolve(value)
        },
        reject(error) {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.process.stdin.write(framed)
    })
  }

  close() {
    this.process.kill()
  }
}

async function stdioListTools(manifest: MCPManifest, workspace: WorkspaceBinding): Promise<DynamicMcpTool[]> {
  const session = new StdioMcpSession(manifest, workspace)
  try {
    await session.start()
    const result = await session.request('tools/list', {})
    const tools = Array.isArray(result.tools) ? result.tools : []
    return tools
      .map(tool => {
        if (!tool || typeof tool !== 'object') return null
        const item = tool as Record<string, unknown>
        const name = typeof item.name === 'string' ? item.name : ''
        if (!name) return null
        return {
          runtimeName: `mcp_${normalizeName(manifest.id)}_${normalizeName(name)}`,
          serverId: manifest.id,
          toolName: name,
          description: typeof item.description === 'string' ? item.description : `${manifest.name} ${name}`,
          inputSchema: item.inputSchema && typeof item.inputSchema === 'object'
            ? item.inputSchema as Record<string, unknown>
            : { type: 'object', properties: {}, additionalProperties: true },
        }
      })
      .filter((tool): tool is DynamicMcpTool => Boolean(tool))
  } finally {
    session.close()
  }
}

async function httpListTools(manifest: MCPManifest, workspace: WorkspaceBinding): Promise<DynamicMcpTool[]> {
  const result = await httpMcpRequest(manifest, workspace, 'tools/list', {})
  const tools = Array.isArray(result.tools) ? result.tools : []
  return tools
    .map(tool => {
      if (!tool || typeof tool !== 'object') return null
      const item = tool as Record<string, unknown>
      const name = typeof item.name === 'string' ? item.name : ''
      if (!name) return null
      return {
        runtimeName: `mcp_${normalizeName(manifest.id)}_${normalizeName(name)}`,
        serverId: manifest.id,
        toolName: name,
        description: typeof item.description === 'string' ? item.description : `${manifest.name} ${name}`,
        inputSchema: item.inputSchema && typeof item.inputSchema === 'object'
          ? item.inputSchema as Record<string, unknown>
          : { type: 'object', properties: {}, additionalProperties: true },
      }
    })
    .filter((tool): tool is DynamicMcpTool => Boolean(tool))
}

export async function discoverDynamicMcpTools(workspace: WorkspaceBinding): Promise<DynamicMcpTool[]> {
  const discovery = await discoverWorkspaceCapabilities(workspace)
  const tools: DynamicMcpTool[] = []
  for (const manifest of discovery.mcpServers) {
    try {
      if (manifest.transport === 'stdio' && manifest.command) {
        tools.push(...await stdioListTools(manifest, workspace))
      } else if ((manifest.transport === 'http' || manifest.transport === 'sse') && manifest.url) {
        tools.push(...await httpListTools(manifest, workspace))
      }
    } catch {
      for (const toolName of manifest.tools ?? []) {
        tools.push({
          runtimeName: `mcp_${normalizeName(manifest.id)}_${normalizeName(toolName)}`,
          serverId: manifest.id,
          toolName,
          description: `${manifest.name} ${toolName}`,
          inputSchema: { type: 'object', properties: {}, additionalProperties: true },
        })
      }
    }
  }
  return tools
}

export async function executeDynamicMcpTool(args: {
  workspace: WorkspaceBinding
  runtimeName: string
  input: Record<string, unknown>
}) {
  const discovery = await discoverWorkspaceCapabilities(args.workspace)
  const manifests = discovery.mcpServers
  for (const manifest of manifests) {
    const prefix = `mcp_${normalizeName(manifest.id)}_`
    if (!args.runtimeName.startsWith(prefix)) continue
    const toolName = args.runtimeName.slice(prefix.length)
    const listed = await discoverDynamicMcpTools(args.workspace)
    const tool = listed.find(item => item.runtimeName === args.runtimeName)
    const callName = tool?.toolName ?? manifest.tools.find(name => normalizeName(name) === toolName) ?? toolName
    if ((manifest.transport === 'http' || manifest.transport === 'sse') && manifest.url) {
      return httpMcpRequest(manifest, args.workspace, 'tools/call', {
        name: callName,
        arguments: args.input,
      })
    }
    if (manifest.transport !== 'stdio' || !manifest.command) continue
    const session = new StdioMcpSession(manifest, args.workspace)
    try {
      await session.start()
      return await session.request('tools/call', {
        name: callName,
        arguments: args.input,
      }, 60_000)
    } finally {
      session.close()
    }
  }
  throw new Error(`No MCP tool registered for ${args.runtimeName}`)
}

export async function readMcpManifestFromPath(workspace: WorkspaceBinding, path: string) {
  const target = safeJoinUnder(workspace.root, path)
  const parsed = JSON.parse(await readFile(target, 'utf-8')) as Partial<MCPManifest>
  return {
    id: parsed.id || basename(path).replace(/\.json$/i, ''),
    name: parsed.name || parsed.id || basename(path),
    transport: parsed.transport || 'stdio',
    command: parsed.command,
    args: parsed.args ?? [],
    url: parsed.url,
    env: parsed.env ?? {},
    tools: parsed.tools ?? [],
    permissions: parsed.permissions ?? ['read'],
    path: target,
    status: parsed.status || 'installed',
  } satisfies MCPManifest
}
