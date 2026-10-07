import { z } from 'zod'
import type { CapabilityKind, ToolCallTrace } from './types'

export type ToolContext = {
  runId: string
  now: Date
  emit?: (message: string) => void
  trace?: ToolCallTrace[]
}

export type ToolDefinition<Input, Output> = {
  name: string
  description: string
  inputSchema: z.ZodType<Input>
  capabilityKind?: CapabilityKind
  mcpCompatible?: boolean
  permissions?: Array<'read' | 'write' | 'network' | 'execute'>
  isReadOnly?: boolean
  isDestructive?: boolean
  run: (input: Input, context: ToolContext) => Promise<Output> | Output
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<unknown, unknown>>()

  register<Input, Output>(tool: ToolDefinition<Input, Output>) {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`)
    }
    this.tools.set(tool.name, tool as ToolDefinition<unknown, unknown>)
  }

  list() {
    return [...this.tools.values()].map(tool => ({
      name: tool.name,
      description: tool.description,
      capabilityKind: tool.capabilityKind ?? 'tool',
      mcpCompatible: Boolean(tool.mcpCompatible),
      permissions: tool.permissions ?? [],
      isReadOnly: Boolean(tool.isReadOnly),
      isDestructive: Boolean(tool.isDestructive),
    }))
  }

  async call<Input, Output>(
    name: string,
    input: Input,
    context: ToolContext,
  ): Promise<Output> {
    const tool = this.tools.get(name)
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`)
    }
    const parsed = tool.inputSchema.parse(input)
    const startedAt = performance.now()
    const trace = context.trace
    try {
      const output = await tool.run(parsed, context)
      if (trace) {
        trace.push({
          id: `${name}-${trace.length + 1}`,
          name,
          capabilityKind: tool.capabilityKind ?? 'tool',
          status: 'complete',
          summary: tool.description,
          inputSummary: summarizeValue(parsed),
          outputSummary: summarizeValue(output),
          permissions: tool.permissions ?? [],
          mcpCompatible: Boolean(tool.mcpCompatible),
          durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
        })
      }
      return output as Output
    } catch (error) {
      if (trace) {
        trace.push({
          id: `${name}-${trace.length + 1}`,
          name,
          capabilityKind: tool.capabilityKind ?? 'tool',
          status: 'error',
          summary: tool.description,
          inputSummary: summarizeValue(parsed),
          outputSummary: error instanceof Error ? error.message : 'tool failed',
          permissions: tool.permissions ?? [],
          mcpCompatible: Boolean(tool.mcpCompatible),
          durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
        })
      }
      throw error
    }
  }
}

function summarizeValue(value: unknown) {
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`
  if (!value || typeof value !== 'object') return String(value)
  const record = value as Record<string, unknown>
  if ('title' in record && typeof record.title === 'string') return record.title
  if ('mode' in record && 'targetMetric' in record) {
    return `${String(record.mode)} / ${String(record.targetMetric)}`
  }
  if ('input' in record && 'signals' in record) {
    const input = record.input as Partial<{ mode: string; targetMetric: string }>
    const signals = Array.isArray(record.signals) ? record.signals.length : 0
    return `${input.mode ?? 'input'} / ${input.targetMetric ?? 'metric'} / ${signals} signals`
  }
  if ('gates' in record) {
    const gates = Array.isArray(record.gates) ? record.gates.length : 0
    return `${gates} gates`
  }
  return `${Object.keys(record).slice(0, 4).join(', ')}`
}
