import { createAgentMessages } from './agentRuntime'
import { executeRuntimeTool, openAiToolDefinitionsForWorkspace } from './agenticTools'
import { chatCompletionUrl, type ResolvedModelRoute } from './runtimeEnv'
import type { ResearchInput, RuntimePermissionMode, ToolCallTrace, WorkspaceBinding } from './types'

export type StreamTraceEvent = {
  id: string
  title: string
  status: 'queued' | 'running' | 'complete' | 'blocked' | 'error'
  detail: string
}

type ProviderToolCall = {
  id: string
  index?: number
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export type ChatStreamResult = {
  content: string
  modelId?: string
  resolvedRoute?: string
  toolCalls?: ToolCallTrace[]
  fallback?: boolean
  error?: string
}

export function extractProviderText(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  const choices = Array.isArray(record.choices) ? record.choices : []
  const first = choices[0] as Record<string, unknown> | undefined
  const delta = first?.delta as Record<string, unknown> | undefined
  const message = first?.message as Record<string, unknown> | undefined
  const candidates = [
    delta?.content,
    message?.content,
    first?.text,
    record.output_text,
    record.response,
    record.content,
  ]

  for (const candidate of candidates) {
    if (typeof candidate === 'string') return candidate
    if (Array.isArray(candidate)) {
      return candidate
        .map(item => {
          if (typeof item === 'string') return item
          if (item && typeof item === 'object') {
            const block = item as Record<string, unknown>
            return typeof block.text === 'string' ? block.text : ''
          }
          return ''
        })
        .join('')
    }
  }

  return ''
}

function extractProviderToolCalls(value: unknown): ProviderToolCall[] {
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  const choices = Array.isArray(record.choices) ? record.choices : []
  const first = choices[0] as Record<string, unknown> | undefined
  const delta = first?.delta as Record<string, unknown> | undefined
  const message = first?.message as Record<string, unknown> | undefined
  const calls = delta?.tool_calls ?? message?.tool_calls
  if (!Array.isArray(calls)) return []
  return calls
    .map<ProviderToolCall | null>((call, fallbackIndex) => {
      if (!call || typeof call !== 'object') return null
      const item = call as Record<string, unknown>
      const fn = item.function as Record<string, unknown> | undefined
      const name = typeof fn?.name === 'string' ? fn.name : ''
      const args = typeof fn?.arguments === 'string' ? fn.arguments : ''
      if (!name && !args) return null
      const index = typeof item.index === 'number' ? item.index : fallbackIndex
      return {
        id: typeof item.id === 'string' ? item.id : `tool-${Date.now().toString(36)}-${index}`,
        index,
        type: 'function',
        function: {
          name,
          arguments: args,
        },
      }
    })
    .filter((item): item is ProviderToolCall => item !== null)
}

function mergeToolCallDelta(calls: ProviderToolCall[], delta: ProviderToolCall[]) {
  const next = [...calls]
  for (const call of delta) {
    const existingIndex = next.findIndex(item =>
      item.id === call.id || (item.index !== undefined && item.index === call.index),
    )
    if (existingIndex >= 0) {
      const existing = next[existingIndex]!
      next[existingIndex] = {
        ...existing,
        id: call.id.startsWith('tool-') ? existing.id : call.id,
        index: existing.index ?? call.index,
        function: {
          name: call.function.name || existing.function.name,
          arguments: `${existing.function.arguments ?? ''}${call.function.arguments ?? ''}`,
        },
      }
    } else {
      next.push(call)
    }
  }
  return next
}

export function safeJsonArguments(value: string) {
  if (!value.trim()) return {}
  try {
    return JSON.parse(value) as Record<string, unknown>
  } catch {
    return { raw: value }
  }
}

export function summarizeRuntimeValue(value: unknown, max = 1600) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return text.length > max ? `${text.slice(0, max)}\n...truncated...` : text
}

export async function readWebStream(
  stream: ReadableStream<Uint8Array>,
  onChunk: (chunk: Uint8Array) => void,
) {
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) onChunk(value)
    }
  } finally {
    reader.releaseLock()
  }
}

export async function streamResponseBody(
  body: ReadableStream<Uint8Array>,
  send: (event: string, value: unknown) => void,
) {
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let toolCalls: ProviderToolCall[] = []
  await readWebStream(body, chunk => {
    buffer += decoder.decode(chunk, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      const line = part
        .split(/\r?\n/)
        .find(item => item.startsWith('data:'))
      if (!line) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      try {
        const parsed = JSON.parse(data)
        const delta = extractProviderText(parsed)
        const deltaToolCalls = extractProviderToolCalls(parsed)
        if (deltaToolCalls.length) {
          toolCalls = mergeToolCallDelta(toolCalls, deltaToolCalls)
        }
        if (delta) {
          content += delta
          send('delta', { content: delta })
        }
      } catch {
        // Ignore malformed provider chunks and keep the stream alive.
      }
    }
  })

  return {
    ok: true as const,
    content,
    toolCalls: toolCalls.filter(call => call.function.name),
  }
}

export async function streamChatCompletion(args: {
  route: ResolvedModelRoute
  messages: Array<Record<string, unknown>>
  tools?: Awaited<ReturnType<typeof openAiToolDefinitionsForWorkspace>>
  send: (event: string, value: unknown) => void
  toolChoice?: 'auto' | 'none'
}) {
  let tools = args.tools
  let response = await fetch(chatCompletionUrl(args.route.channel.baseUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${args.route.channel.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: args.route.modelId,
      messages: args.messages,
      temperature: 0.4,
      stream: true,
      tools,
      tool_choice: tools?.length ? args.toolChoice ?? 'auto' : undefined,
    }),
  })

  if (!response.ok || !response.body) {
    const detail = (await response.text().catch(() => '')).slice(0, 300)
    if (tools?.length && /tool|function|schema|tool_choice|unsupported|unknown|invalid/i.test(detail)) {
      args.send('trace', {
        id: 'tool-schema-fallback',
        title: 'Tool schema fallback',
        status: 'blocked',
        detail: `The selected endpoint rejected tool schemas, so this turn continues without native tool-calling. Provider error: ${detail || response.status}`,
      })
      tools = undefined
      response = await fetch(chatCompletionUrl(args.route.channel.baseUrl), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${args.route.channel.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: args.route.modelId,
          messages: args.messages,
          temperature: 0.4,
          stream: true,
        }),
      })
      if (response.ok && response.body) {
        return streamResponseBody(response.body, args.send)
      }
    }
    return {
      ok: false as const,
      content: '',
      toolCalls: [] as ProviderToolCall[],
      error: `chat endpoint returned ${response.status}: ${detail}`,
    }
  }

  return streamResponseBody(response.body, args.send)
}

function finalToolSummary(trace: ToolCallTrace[]) {
  const last = trace.at(-1)
  if (!last) return ''
  const status = trace.some(tool => tool.status === 'error')
    ? 'Tool execution finished with an error.'
    : trace.some(tool => tool.status === 'blocked')
      ? 'Tool execution was blocked.'
      : 'Tool execution completed.'
  return [
    status,
    `${last.name}: ${last.outputSummary || last.summary}`.slice(0, 1200),
  ].join('\n')
}

export async function runStreamingToolLoop(args: {
  input: ResearchInput
  workspace: WorkspaceBinding
  route: ResolvedModelRoute
  permissionMode?: RuntimePermissionMode
  send: (event: string, value: unknown) => void
}) {
  const messages = createAgentMessages(args.input, args.route.modelId) as Array<Record<string, unknown>>
  const tools = await openAiToolDefinitionsForWorkspace(args.workspace)
  const runtimeToolTrace: ToolCallTrace[] = []
  let content = ''
  let toolLoops = 0
  let lastError = ''
  let executedTools = false

  while (toolLoops < 64) {
    const response = await streamChatCompletion({
      route: args.route,
      messages,
      tools,
      send: args.send,
    })

    if (!response.ok) {
      lastError = response.error
      break
    }

    content += response.content
    if (!response.toolCalls.length) break

    toolLoops += 1
    executedTools = true
    const toolCalls = response.toolCalls.map(call => ({
      id: call.id,
      type: 'function' as const,
      function: {
        name: call.function.name,
        arguments: call.function.arguments,
      },
    }))
    messages.push({
      role: 'assistant',
      content: response.content || null,
      tool_calls: toolCalls,
    })

    args.send('trace', {
      id: `tool-batch-${toolLoops}`,
      title: 'Run COG tools',
      status: 'running',
      detail: `${toolCalls.length} tool call${toolCalls.length > 1 ? 's' : ''} requested by the model.`,
    })

    const results = await Promise.all(
      response.toolCalls.map(async call => {
        const result = await executeRuntimeTool(
          call.function.name,
          safeJsonArguments(call.function.arguments),
          {
            workspace: args.workspace,
            trace: runtimeToolTrace,
            input: args.input,
            permissionMode: args.permissionMode ?? args.input.permissionMode,
            modelRoute: {
              route: args.route.route,
              modelId: args.route.modelId,
              channel: {
                baseUrl: args.route.channel.baseUrl,
                apiKey: args.route.channel.apiKey,
              },
            },
            emitTrace(event) {
              args.send('trace', event)
            },
          },
        )
        return { call, result }
      }),
    )

    for (const { call, result } of results) {
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: summarizeRuntimeValue(result, 6000),
      })
    }
    args.send('trace', {
      id: `tool-batch-${toolLoops}`,
      title: 'Run COG tools',
      status: 'complete',
      detail: `${results.length} tool result${results.length > 1 ? 's' : ''} returned to the model.`,
    })
  }

  if (executedTools && !content.trim() && !lastError) {
    messages.push({
      role: 'user',
      content: 'The tool calls have completed. Reply now with a concise final answer for the user. Do not call more tools.',
    })
    const finalResponse = await streamChatCompletion({
      route: args.route,
      messages,
      tools,
      toolChoice: 'none',
      send: args.send,
    })
    if (finalResponse.ok && finalResponse.content.trim()) {
      content += finalResponse.content
    } else {
      const fallback = finalToolSummary(runtimeToolTrace)
      if (fallback) {
        content = fallback
        args.send('delta', { content: fallback })
      } else if (!finalResponse.ok) {
        lastError = finalResponse.error
      }
    }
  }

  return {
    content,
    modelId: args.route.modelId,
    resolvedRoute: args.route.route,
    toolCalls: runtimeToolTrace,
    fallback: Boolean(lastError),
    error: lastError || undefined,
  } satisfies ChatStreamResult
}
