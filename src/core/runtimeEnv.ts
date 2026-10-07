import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export type RuntimeModel = {
  id: string
  object?: string
  owned_by?: string
}

export type ModelChannel = {
  id: string
  label: string
  baseUrl: string
  apiKey: string
}

export type ResolvedModelRoute = {
  route: string
  modelId: string
  channel: ModelChannel
  fallback?: boolean
}

export function applyLocalEnvFile(cwd = process.cwd()) {
  const target = resolve(cwd, '.env')
  if (!existsSync(target)) return
  try {
    const text = readFileSync(target, 'utf-8')
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const index = line.indexOf('=')
      if (index <= 0) continue
      const key = line.slice(0, index).trim()
      const value = line
        .slice(index + 1)
        .trim()
        .replace(/^['"]|['"]$/g, '')
      if (!process.env[key]) process.env[key] = value
    }
  } catch {
    // Local model credentials are optional.
  }
}

function envNameForChannel(channelId: string, suffix: string) {
  return `CLAW_MODEL_${channelId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_${suffix}`
}

export function modelChannels(): ModelChannel[] {
  const ids = (process.env.CLAW_MODEL_CHANNELS ?? '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean)

  const channels = ids
    .map(id => {
      const baseUrl = process.env[envNameForChannel(id, 'BASE_URL')] ?? ''
      const apiKey = process.env[envNameForChannel(id, 'API_KEY')] ?? ''
      const label = process.env[envNameForChannel(id, 'LABEL')] ?? id
      return {
        id,
        label,
        baseUrl: baseUrl.replace(/\/+$/, ''),
        apiKey,
      }
    })
    .filter(channel => channel.baseUrl && channel.apiKey)

  if (channels.length) return channels

  const baseUrl =
    process.env.CLAW_MODEL_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    process.env.openai_base_url ||
    process.env.LITELLM_BASE_URL ||
    process.env.litellm_base_url ||
    ''
  const apiKey =
    process.env.CLAW_MODEL_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.LITELLM_APIKEY ||
    ''

  return baseUrl && apiKey
    ? [
        {
          id: 'default',
          label: 'default',
          apiKey,
          baseUrl: baseUrl.replace(/\/+$/, ''),
        },
      ]
    : []
}

export function modelListUrl(baseUrl: string) {
  return baseUrl.endsWith('/v1') ? `${baseUrl}/models` : `${baseUrl}/v1/models`
}

export function chatCompletionUrl(baseUrl: string) {
  const clean = baseUrl.replace(/\/+$/, '')
  return clean.endsWith('/v1') ? `${clean}/chat/completions` : `${clean}/v1/chat/completions`
}

export function resolveModelRoute(routeId: string): ResolvedModelRoute | undefined {
  const separator = routeId.indexOf(':')
  if (separator <= 0) return undefined
  const channelId = routeId.slice(0, separator)
  const modelId = routeId.slice(separator + 1)
  const channel = modelChannels().find(item => item.id === channelId)
  if (!channel || !modelId) return undefined
  return {
    route: routeId,
    channel,
    modelId,
  }
}

export async function listChannelModels(channel: ModelChannel) {
  try {
    const response = await fetch(modelListUrl(channel.baseUrl), {
      headers: {
        authorization: `Bearer ${channel.apiKey}`,
      },
    })
    if (!response.ok) return [] as RuntimeModel[]
    const payload = (await response.json()) as { data?: RuntimeModel[] }
    return (payload.data ?? []).filter(model => model.id)
  } catch {
    return [] as RuntimeModel[]
  }
}

export async function listRuntimeModels() {
  const channels = modelChannels()
  const results = await Promise.all(
    channels.map(async channel => ({
      channel,
      models: await listChannelModels(channel),
    })),
  )
  return results.flatMap(result =>
    result.models.map(model => ({
      id: `${result.channel.id}:${model.id}`,
      modelId: model.id,
      label: model.id,
      channelId: result.channel.id,
      channelLabel: result.channel.label,
      baseUrl: result.channel.baseUrl,
      ownedBy: model.owned_by ?? result.channel.label,
    })),
  )
}

export async function resolveUsableModelRoute(routeId?: string): Promise<ResolvedModelRoute | undefined> {
  if (routeId) {
    const direct = resolveModelRoute(routeId)
    if (direct) return direct
  }

  const channels = modelChannels()
  for (const channel of channels) {
    const models = await listChannelModels(channel)
    const preferred =
      models.find(model => model.id === routeId) ??
      models.find(model => /gpt-5\.5|gpt-5|claude|sonnet|opus/i.test(model.id)) ??
      models[0]
    if (preferred?.id) {
      return {
        route: `${channel.id}:${preferred.id}`,
        channel,
        modelId: preferred.id,
        fallback: true,
      }
    }
  }

  return undefined
}
