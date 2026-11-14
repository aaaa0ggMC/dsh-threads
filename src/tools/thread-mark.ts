import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { type ThreadManager, ThreadError } from '../manager.ts'
import { msg } from '../messages.ts'

const DESCRIPTION = 'Mark one of this conversation\'s threads (by its number #n) as solved or as archived. '
  + 'action "resolve": the thread\'s work is done and the user has seen it; it stays in the threads list with a ✓, and a message the user types in it reopens it. '
  + 'action "reopen": undo that. '
  + 'action "archive": the thread is no longer needed; it leaves the threads list and its session is archived in DSH (nothing is deleted, but it cannot run). '
  + 'action "unarchive": bring it back. Archiving is refused while the thread runs: wait for its report, or ask the user to stop it in the threads pane. '
  + 'The user can do all of this in the threads pane; use it here to keep this conversation\'s list tidy.'

export function threadMarkTool(manager: ThreadManager): ToolDefinition {
  return defineTool({
    name: 'thread_mark',
    description: DESCRIPTION,
    parameters: {
      n: { type: 'integer', required: true, description: 'Thread number (#n), as shown by thread_status.' },
      action: {
        type: 'string',
        required: true,
        enum: ['resolve', 'reopen', 'archive', 'unarchive'],
        description: '"resolve" to mark the thread solved; "reopen" to undo that; "archive" to put a thread that is no longer needed out of the way (refused while it runs); "unarchive" to bring it back.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const caller = exec.agent
      if (caller === undefined) throw new Error('thread_mark needs a calling session')
      try {
        const thread = await manager.markNumber(caller.id, args.n, args.action)
        const m = msg()
        if (args.action === 'resolve') return m.toolResolved(thread.n, thread.title)
        if (args.action === 'reopen') return m.toolReopened(thread.n, thread.title)
        if (args.action === 'archive') return m.toolArchived(thread.n, thread.title)
        return m.toolUnarchived(thread.n, thread.title)
      } catch (error) {
        if (error instanceof ThreadError) return msg().toolNotMarked(error.message)
        throw error
      }
    },
  })
}
