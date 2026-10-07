import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { createCapabilityManifest } from './capabilities'
import { safeJoinUnder, sanitizePathSegment } from './workspace'
import type { CapabilityManifest, WorkspaceBinding } from './types'

export type SkillManifest = {
  id: string
  name: string
  description: string
  whenToUse?: string
  allowedTools: string[]
  path: string
  source: 'workspace' | 'built-in'
  version?: string
  userInvocable: boolean
}

export type MCPManifest = {
  id: string
  name: string
  transport: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  tools: string[]
  permissions: Array<'read' | 'write' | 'network' | 'execute'>
  path: string
  status: 'configured' | 'installed' | 'planned'
}

export type CapabilityDiscovery = {
  capabilities: CapabilityManifest[]
  skills: SkillManifest[]
  mcpServers: MCPManifest[]
  roots: {
    skills: string
    mcp: string
    capabilities: string
  }
}

type SkillRegistry = {
  disabled?: string[]
  versions?: Record<string, string>
  notes?: Record<string, string>
}

function parseFrontmatter(markdown: string) {
  if (!markdown.startsWith('---')) return { frontmatter: {}, body: markdown }
  const end = markdown.indexOf('\n---', 3)
  if (end < 0) return { frontmatter: {}, body: markdown }
  const raw = markdown.slice(3, end).trim()
  const body = markdown.slice(end + 4).trim()
  const frontmatter: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const index = line.indexOf(':')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '')
    frontmatter[key] = value
  }
  return { frontmatter, body }
}

function csv(value?: string) {
  return (value ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
}

export function workspaceCapabilityRoots(binding?: WorkspaceBinding) {
  const root = resolve(binding?.root ?? process.cwd())
  return {
    skills: safeJoinUnder(root, '.cogclaw', 'skills'),
    mcp: safeJoinUnder(root, '.cogclaw', 'mcp'),
    capabilities: safeJoinUnder(root, 'artifacts', 'capabilities'),
  }
}

async function readSkillFile(skillDir: string): Promise<SkillManifest | null> {
  const skillPath = join(skillDir, 'SKILL.md')
  try {
    const markdown = await readFile(skillPath, 'utf-8')
    const { frontmatter, body } = parseFrontmatter(markdown)
    const name = frontmatter.name || basename(skillDir)
    return {
      id: sanitizePathSegment(basename(skillDir)).toLowerCase(),
      name,
      description:
        frontmatter.description ||
        body
          .split(/\r?\n/)
          .find(line => line.trim() && !line.startsWith('#'))
          ?.trim() ||
        `${name} skill`,
      whenToUse: frontmatter.when_to_use || frontmatter.whenToUse,
      allowedTools: csv(frontmatter.allowed_tools || frontmatter['allowed-tools']),
      path: skillPath,
      source: 'workspace',
      version: frontmatter.version,
      userInvocable: frontmatter.user_invocable !== 'false' && frontmatter['user-invocable'] !== 'false',
    }
  } catch {
    return null
  }
}

async function readSkillRegistry(root: string): Promise<SkillRegistry> {
  try {
    return JSON.parse(await readFile(join(root, 'registry.json'), 'utf-8')) as SkillRegistry
  } catch {
    return {}
  }
}

export async function discoverWorkspaceCapabilities(binding?: WorkspaceBinding): Promise<CapabilityDiscovery> {
  const roots = workspaceCapabilityRoots(binding)
  const skills: SkillManifest[] = []
  if (existsSync(roots.skills)) {
    const entries = await readdir(roots.skills, { withFileTypes: true }).catch(() => [])
    const loaded = await Promise.all(
      entries
        .filter(entry => entry.isDirectory())
        .map(entry => readSkillFile(join(roots.skills, entry.name))),
    )
    const registry = await readSkillRegistry(roots.skills)
    const disabled = new Set((registry.disabled ?? []).map(id => sanitizePathSegment(id).toLowerCase()))
    skills.push(...loaded
      .filter((item): item is SkillManifest => Boolean(item))
      .map(skill => ({
        ...skill,
        version: registry.versions?.[skill.id] ?? skill.version,
        userInvocable: skill.userInvocable && !disabled.has(skill.id),
      })))
  }

  const mcpServers: MCPManifest[] = []
  if (existsSync(roots.mcp)) {
    const entries = await readdir(roots.mcp, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.filter(item => item.isFile() && item.name.endsWith('.json'))) {
      const path = join(roots.mcp, entry.name)
      try {
        const parsed = JSON.parse(await readFile(path, 'utf-8')) as Partial<MCPManifest>
        mcpServers.push({
          id: parsed.id || entry.name.replace(/\.json$/i, ''),
          name: parsed.name || entry.name.replace(/\.json$/i, ''),
          transport: parsed.transport || 'stdio',
          command: parsed.command,
          args: parsed.args ?? [],
          url: parsed.url,
          env: parsed.env ?? {},
          tools: parsed.tools ?? [],
          permissions: parsed.permissions ?? ['read'],
          path,
          status: parsed.status || 'installed',
        })
      } catch {
        // Broken MCP manifests are ignored by discovery and surfaced by install/test commands.
      }
    }
  }

  return {
    roots,
    skills,
    mcpServers,
    capabilities: [
      ...createCapabilityManifest(),
      ...skills.map(skill => ({
        id: `skill-${skill.id}`,
        kind: 'skill' as const,
        name: skill.name,
        status: 'installed' as const,
        trigger: skill.whenToUse || skill.description,
        purpose: skill.description,
        autonomy: 'automatic' as const,
        inputs: ['conversation', 'workspace', 'artifacts'],
        outputs: ['skill prompt', 'tool policy', 'workflow contract'],
        safety: ['workspace-scoped', 'loaded from SKILL.md', 'observable invocation'],
        installable: false,
      })),
      ...mcpServers.map(server => ({
        id: `mcp-${server.id}`,
        kind: 'mcp' as const,
        name: server.name,
        status: 'installed' as const,
        trigger: `When ${server.tools.join(', ') || server.name} is needed.`,
        purpose: `Expose ${server.tools.join(', ') || 'declared MCP tools'} through ${server.transport}.`,
        autonomy: 'approval-required' as const,
        inputs: ['MCP tool request'],
        outputs: server.tools,
        safety: [`permissions: ${server.permissions.join('+')}`, 'credentials stay in env'],
        installable: false,
      })),
    ],
  }
}

export async function installSkillInstallerSkill(binding?: WorkspaceBinding) {
  const roots = workspaceCapabilityRoots(binding)
  const dir = safeJoinUnder(roots.skills, 'skill-installer')
  await mkdir(dir, { recursive: true })
  const path = safeJoinUnder(dir, 'SKILL.md')
  const contents = `---
name: Skill Installer
description: Install, author, validate and register COG-CLAW skills from a local folder or reusable skill spec.
when_to_use: A task requires a missing reusable workflow, asks to install a skill, or should turn repeated behavior into a durable capability.
allowed_tools: Read, Write, Edit, Grep, Glob, Bash
version: 1.0.0
---

# Skill Installer

Use this skill to make COG-CLAW self-extensible without leaving the workspace.

## Workflow

1. Inspect the user request, current workspace and existing skills.
2. Decide whether an existing skill is enough; avoid duplicate capabilities.
3. Create \`.cogclaw/skills/<skill-id>/SKILL.md\` with trigger, inputs, outputs, allowed tools, safety rules and smoke checks.
4. Keep scripts/assets under the skill directory when needed.
5. Register the new skill in the capability manifest and record the artifact path.

## Safety

- Skills are workspace-scoped by default.
- Do not execute new skill code silently after installation.
- Treat skill markdown as instructions only after it is selected by trigger and reviewed by the controller.
`
  await writeFile(path, contents)
  return { id: 'skill-installer', path, contents }
}

export async function installMcpInstallerServer(binding?: WorkspaceBinding) {
  const roots = workspaceCapabilityRoots(binding)
  await mkdir(roots.mcp, { recursive: true })
  const path = safeJoinUnder(roots.mcp, 'mcp-installer.json')
  const manifest: MCPManifest = {
    id: 'mcp-installer',
    name: 'MCP Installer',
    transport: 'stdio',
    command: 'node',
    args: ['.cogclaw/mcp/mcp-installer-server.cjs'],
    env: {
      COG_CLAW_WORKSPACE: '${workspaceRoot}',
    },
    tools: ['discover_mcp', 'install_mcp_manifest', 'validate_mcp_manifest', 'audit_mcp_permissions'],
    permissions: ['read', 'write', 'execute'],
    path,
    status: 'installed',
  }
  const manifestOnDisk = {
    id: manifest.id,
    name: manifest.name,
    transport: manifest.transport,
    command: manifest.command,
    args: manifest.args,
    env: manifest.env,
    tools: manifest.tools,
    permissions: manifest.permissions,
    status: manifest.status,
  }
  await writeFile(path, JSON.stringify(manifestOnDisk, null, 2))

  const serverPath = safeJoinUnder(dirname(path), 'mcp-installer-server.cjs')
  const server = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')

const workspace = path.resolve(process.env.COG_CLAW_WORKSPACE || process.cwd())
const mcpRoot = path.join(workspace, '.cogclaw', 'mcp')
const tools = ${JSON.stringify(manifest.tools)}

function inside(base, target) {
  const rel = path.relative(path.resolve(base), path.resolve(target))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function safeJoin(...segments) {
  const target = path.resolve(mcpRoot, ...segments)
  if (!inside(mcpRoot, target)) throw new Error('path escapes MCP root')
  return target
}

function sanitizeId(value) {
  return String(value || 'unnamed').replace(/[<>:"/\\\\|?*\\x00-\\x1F]/g, '_').replace(/^\\.+$/g, '_').trim() || 'unnamed'
}

function readManifests() {
  if (!fs.existsSync(mcpRoot)) return []
  return fs.readdirSync(mcpRoot, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => {
      const file = safeJoin(entry.name)
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
        return { ...parsed, path: path.relative(workspace, file) }
      } catch (error) {
        return { id: entry.name.replace(/\\.json$/i, ''), status: 'invalid', error: error.message, path: path.relative(workspace, file) }
      }
    })
}

function normalizeManifest(raw, fallbackId) {
  const manifest = typeof raw === 'string' ? JSON.parse(raw) : raw
  if (!manifest || typeof manifest !== 'object') throw new Error('manifest must be a JSON object')
  const id = sanitizeId(manifest.id || fallbackId)
  const transport = manifest.transport || 'stdio'
  if (!['stdio', 'http', 'sse'].includes(transport)) throw new Error('transport must be stdio, http or sse')
  if (transport === 'stdio' && !manifest.command) throw new Error('stdio MCP manifest requires command')
  if ((transport === 'http' || transport === 'sse') && !manifest.url) throw new Error('http/sse MCP manifest requires url')
  return {
    id,
    name: manifest.name || id,
    transport,
    command: manifest.command,
    args: Array.isArray(manifest.args) ? manifest.args : [],
    url: manifest.url,
    env: manifest.env && typeof manifest.env === 'object' ? manifest.env : {},
    tools: Array.isArray(manifest.tools) ? manifest.tools : [],
    permissions: Array.isArray(manifest.permissions) && manifest.permissions.length ? manifest.permissions : ['read'],
    status: manifest.status || 'installed',
  }
}

function content(payload) {
  return { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }] }
}

function callTool(name, args = {}) {
  if (name === 'discover_mcp') {
    return content({ workspace, mcpRoot: path.relative(workspace, mcpRoot), servers: readManifests() })
  }
  if (name === 'validate_mcp_manifest') {
    return content({ ok: true, manifest: normalizeManifest(args.manifest_json || args.manifest, args.id) })
  }
  if (name === 'install_mcp_manifest') {
    const manifest = normalizeManifest(args.manifest_json || args.manifest, args.id)
    fs.mkdirSync(mcpRoot, { recursive: true })
    const file = safeJoin(sanitizeId(manifest.id) + '.json')
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2))
    return content({ ok: true, id: manifest.id, path: path.relative(workspace, file), manifest })
  }
  if (name === 'audit_mcp_permissions') {
    const manifest = args.manifest_json || args.manifest
      ? normalizeManifest(args.manifest_json || args.manifest, args.id)
      : readManifests().find(item => item.id === args.id)
    if (!manifest) throw new Error('manifest not found')
    const permissions = manifest.permissions || []
    const risky = permissions.filter(permission => ['write', 'execute', 'network'].includes(permission))
    return content({
      id: manifest.id,
      permissions,
      risky,
      approvalRequired: risky.length > 0,
      notes: risky.length
        ? ['Non-read permissions must pass the active COG-CLAW permission policy before execution.']
        : ['Read-only MCP manifest can be discovered automatically.'],
    })
  }
  throw new Error('unknown tool: ' + name)
}

function toolSchemas() {
  return tools.map(name => ({
    name,
    description: {
      discover_mcp: 'List workspace-scoped MCP manifests.',
      install_mcp_manifest: 'Install a validated MCP manifest under .cogclaw/mcp.',
      validate_mcp_manifest: 'Validate and normalize an MCP manifest JSON object.',
      audit_mcp_permissions: 'Report whether an MCP manifest needs permission review.',
    }[name] || name,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        manifest_json: { type: 'string' },
        manifest: { type: 'object' },
      },
      additionalProperties: true,
    },
  }))
}

function respond(id, result, error) {
  const message = error
    ? { jsonrpc: '2.0', id, error: { code: -32000, message: error.message || String(error) } }
    : { jsonrpc: '2.0', id, result }
  const raw = JSON.stringify(message)
  process.stdout.write('Content-Length: ' + Buffer.byteLength(raw) + '\\r\\n\\r\\n' + raw)
}

function handle(message) {
  if (!message || message.id === undefined) return
  try {
    if (message.method === 'initialize') {
      respond(message.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'cogclaw-mcp-installer', version: '1.0.0' },
      })
    } else if (message.method === 'tools/list') {
      respond(message.id, { tools: toolSchemas() })
    } else if (message.method === 'tools/call') {
      respond(message.id, callTool(message.params?.name, message.params?.arguments || {}))
    } else if (message.method === 'ping') {
      respond(message.id, {})
    } else {
      respond(message.id, null, new Error('unsupported method: ' + message.method))
    }
  } catch (error) {
    respond(message.id, null, error)
  }
}

let buffer = Buffer.alloc(0)
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk])
  while (true) {
    const headerEnd = buffer.indexOf('\\r\\n\\r\\n')
    if (headerEnd >= 0) {
      const header = buffer.slice(0, headerEnd).toString('utf8')
      const match = /Content-Length:\\s*(\\d+)/i.exec(header)
      if (!match) {
        buffer = buffer.slice(headerEnd + 4)
        continue
      }
      const length = Number(match[1])
      const start = headerEnd + 4
      if (buffer.length < start + length) return
      const raw = buffer.slice(start, start + length).toString('utf8')
      buffer = buffer.slice(start + length)
      handle(JSON.parse(raw))
      continue
    }

    const newline = buffer.indexOf('\\n')
    if (newline < 0) return
    const line = buffer.slice(0, newline).toString('utf8').trim()
    buffer = buffer.slice(newline + 1)
    if (line) handle(JSON.parse(line))
  }
})
process.stdin.on('end', () => process.exit(0))
`
  await writeFile(serverPath, server)
  return { id: 'mcp-installer', path, serverPath, manifest }
}

export async function installDefaultExtensibility(binding?: WorkspaceBinding) {
  const skill = await installSkillInstallerSkill(binding)
  const mcp = await installMcpInstallerServer(binding)
  return { skill, mcp }
}
