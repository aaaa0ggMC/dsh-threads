import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { type ThreadManager, ThreadError } from '../manager.ts'

export function threadStatusTool(manager: ThreadManager): ToolDefinition {
  return defineTool({
    name: 'thread_status',
    description: 'List the threads opened from this conversation with their status and latest report, or pass n to read one thread in detail.',
    parameters: {
      n: { type: 'integer', description: 'Thread number (#n). Omit to list all threads.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const caller = exec.agent
      if (caller === undefined) throw new Error('thread_status needs a calling session')
      try {
        return await manager.describe(caller.id, args.n)
      } catch (error) {
        if (error instanceof ThreadError) return error.message
        throw error
      }
    },
  })
}
