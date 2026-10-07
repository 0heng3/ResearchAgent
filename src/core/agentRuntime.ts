import { assembleCogClawPromptSections } from './sessionRuntime'
import type { ConversationTurn, ResearchInput } from './types'

export type ModelRoute = {
  route: string
  modelId: string
  channel: {
    id: string
    label: string
    baseUrl: string
    apiKey: string
  }
}

export type AgentChatResult = {
  content: string
  modelId?: string
  fallback?: boolean
  error?: string
  resolvedRoute?: string
}

export function createAgentMessages(input: ResearchInput, modelId?: string) {
  const systemSections = assembleCogClawPromptSections({ input, modelId })
  const conversation = (input.conversation ?? [])
    .slice(-24)
    .filter(turn => (turn.role === 'user' || turn.role === 'assistant') && turn.content.trim())
    .map(turn => ({
      role: turn.role,
      content: turn.content,
    }))

  return [
    ...systemSections.map(section => ({
      role: 'system',
      content: section,
    })),
    ...conversation,
  ]
}

function chatUrl(baseUrl: string) {
  const clean = baseUrl.replace(/\/+$/, '')
  return clean.endsWith('/v1') ? `${clean}/chat/completions` : `${clean}/v1/chat/completions`
}

function runtimeErrorContent(error: string, route?: ModelRoute) {
  return [
    'COG-CLAW runtime error.',
    route?.route ? `Route: ${route.route}` : null,
    route?.modelId ? `Model: ${route.modelId}` : null,
    `Error: ${error}`,
  ]
    .filter(Boolean)
    .join('\n')
}

export async function runAgentChat(input: ResearchInput, route?: ModelRoute): Promise<AgentChatResult> {
  if (!route) {
    const error = 'no live model route configured'
    return {
      content: runtimeErrorContent(error),
      fallback: true,
      error,
    }
  }

  try {
    const response = await fetch(chatUrl(route.channel.baseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${route.channel.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: route.modelId,
        messages: createAgentMessages(input, route.modelId),
        temperature: 0.4,
        stream: false,
      }),
    })

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      const error = `chat endpoint returned ${response.status}${detail ? `: ${detail.slice(0, 220)}` : ''}`
      return {
        content: runtimeErrorContent(error, route),
        modelId: route.modelId,
        resolvedRoute: route.route,
        fallback: true,
        error,
      }
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = payload.choices?.[0]?.message?.content?.trim()
    if (!content) {
      const error = 'empty model response'
      return {
        content: runtimeErrorContent(error, route),
        modelId: route.modelId,
        resolvedRoute: route.route,
        fallback: true,
        error,
      }
    }

    return {
      content,
      modelId: route.modelId,
      resolvedRoute: route.route,
      fallback: false,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'model chat failed'
    return {
      content: runtimeErrorContent(message, route),
      modelId: route.modelId,
      resolvedRoute: route.route,
      fallback: true,
      error: message,
    }
  }
}

export function createAssistantTurnFromChat(
  result: AgentChatResult,
  extra?: Partial<ConversationTurn>,
): ConversationTurn {
  return {
    id: `assistant-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    role: 'assistant',
    content: result.content,
    mode: extra?.mode ?? 'chat',
    modelId: result.modelId,
    toolCalls: extra?.toolCalls,
    workTrace: extra?.workTrace,
  }
}
