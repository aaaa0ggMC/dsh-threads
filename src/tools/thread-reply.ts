import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { type ThreadManager, ThreadError } from '../manager.ts'
import { msg } from '../messages.ts'

const DESCRIPTION = 'Send more instructions to an existing thread of this conversation (by its number #n) instead of opening a new one. '
  + 'The default mode "steer" delivers the message into the thread\'s current work: a running thread reads it at its next step, without waiting for the thread\'s current turn to end; an idle thread starts working on it right away. '
  + 'Mode "followup" queues the message as the thread\'s own next turn, after the thread\'s current turn ends; use it for a separate next task that should wait until the current one is finished. '
  + 'An idle thread starts either mode right away — the mode only matters while it is running. Its report comes back here as usual.'

export function threadReplyTool(manager: ThreadManager): ToolDefinition {
  return defineTool({
    name: 'thread_reply',
    description: DESCRIPTION,
    parameters: {
      n: { type: 'integer', required: true, description: 'Thread number (#n), as shown by thread_status.' },
      message: {
        type: 'string',
        required: true,
        description: 'The instruction, self-contained: what to do next and what done looks like.',
      },
      mode: {
        type: 'string',
        enum: ['steer', 'followup'],
        description: '"steer" (default): the thread reads it in its current work, at its next step. "followup": it becomes the thread\'s own next turn, after the current one ends.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const caller = exec.agent
      if (caller === undefined) throw new Error('thread_reply needs a calling session')
      // An unset mode steers: the common follow-up (a correction, an answer, a new constraint)
      // must reach the running thread now, not after its current turn.
      const mode = args.mode === 'followup' ? 'followup' : 'steer'
      try {
        const thread = await manager.reply(caller.id, args.n, args.message, mode)
        return mode === 'followup' ? msg().toolRepliedFollowup(thread.n, thread.title) : msg().toolRepliedSteer(thread.n, thread.title)
      } catch (error) {
        if (error instanceof ThreadError) return msg().toolNotSent(error.message)
        throw error
      }
    },
  })
}
