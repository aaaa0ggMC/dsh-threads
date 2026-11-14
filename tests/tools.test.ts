import type { Context } from '@deepseek-ai/cordis'
import { ToolArgsError } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { beforeEach, describe, expect, it } from 'vitest'
import { Config } from '../src/config.ts'
import { threadMarkTool } from '../src/tools/thread-mark.ts'
import { threadOpenTool } from '../src/tools/thread-open.ts'
import { threadProposeTool } from '../src/tools/thread-propose.ts'
import { threadReplyTool } from '../src/tools/thread-reply.ts'
import { threadReportTool } from '../src/tools/thread-report.ts'
import { threadStatusTool } from '../src/tools/thread-status.ts'
import { setup } from './fixtures.ts'

// The thread_* tools are what the model calls directly: argument checks, refusals it can read, results.

type Answer = { selected: string[]; custom?: string }

/** A DSH context with only the optional userQuestions service, answering every question with `answer`. */
function contextWith(answer: Answer | undefined): { ctx: Context; asked: string[] } {
  const asked: string[] = []
  const questions = {
    async ask(request: { questions: { id: string; question: string }[] }) {
      asked.push(...request.questions.map((q) => q.question))
      return { answers: request.questions.map((q) => ({ id: q.id, ...answer! })) }
    },
  }
  const ctx = {
    get(name: string) {
      if (name === 'userQuestions' && answer !== undefined) return questions
      throw new Error(`service ${name} is not provided`)
    },
  }
  return { ctx: ctx as unknown as Context, asked }
}

const call = (tool: ToolDefinition, args: unknown, agentId = 'main') =>
  tool.execute(args as never, { agent: { id: agentId }, signal: new AbortController().signal, callId: 'call-1' } as never)

describe('thread_open', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => { t = setup() })

  it('opens a thread the user asked for and returns its card data', async () => {
    const tool = threadOpenTool(contextWith(undefined).ctx, t.manager)
    const result = await call(tool, { title: '查依赖', task: '列出过期依赖', initiation: 'user_asked' }) as { text: string; threadId: string; n: number }
    expect(result).toMatchObject({ threadId: 'session-1', n: 1, title: '查依赖' })
    expect(result.text).toContain('#1「查依赖」')
    expect(tool.output.presentationMeta?.({} as never, result as never)).toEqual({ threadId: 'session-1', n: 1, title: '查依赖' })
  })

  it('rejects arguments the schema does not allow', async () => {
    const tool = threadOpenTool(contextWith(undefined).ctx, t.manager)
    // `proposal` is thread_propose's job; the model may only pass user_asked or offer.
    await expect(call(tool, { title: 'a', task: 'b', initiation: 'proposal' })).rejects.toBeInstanceOf(ToolArgsError)
    await expect(call(tool, { title: 'a', initiation: 'user_asked' })).rejects.toBeInstanceOf(ToolArgsError)
    expect(t.store.threadsOf('main')).toEqual([])
  })

  it('asks the user first for an offer, and opens only on "open a thread"', async () => {
    const open = contextWith({ selected: ['开讨论串'] })
    await call(threadOpenTool(open.ctx, t.manager), { title: '审查', task: 'x', initiation: 'offer' })
    expect(open.asked).toEqual(['要为「审查」开一个讨论串吗？'])
    expect(t.store.threadsOf('main')).toHaveLength(1)

    for (const answer of [{ selected: ['在主对话里做'] }, { selected: ['先不做'] }, { selected: [], custom: '晚点再说' }]) {
      const result = await call(threadOpenTool(contextWith(answer).ctx, t.manager), { title: 'b', task: 'y', initiation: 'offer' }) as { text: string; threadId?: string }
      expect(result.threadId).toBeUndefined()
      expect(result.text).toContain('不要开讨论串')
    }
    expect(t.store.threadsOf('main')).toHaveLength(1)
  })

  it('tells the model to ask in its reply when DSH cannot show the question', async () => {
    const result = await call(threadOpenTool(contextWith(undefined).ctx, t.manager), { title: 'a', task: 'x', initiation: 'offer' }) as { text: string }
    expect(result.text).toContain('userQuestions 不可用')
    expect(t.store.threadsOf('main')).toEqual([])
  })

  // Issue #51: a coordinator that decides on its own what becomes a thread, without a card per thread.
  it('opens an offer without asking when offerApproval is "open"', async () => {
    const answered = contextWith({ selected: ['先不做'] })
    const tool = threadOpenTool(answered.ctx, t.manager, 'open')
    const result = await call(tool, { title: '审查', task: 'x', initiation: 'offer' }) as { threadId?: string }
    expect(answered.asked).toEqual([])
    expect(result.threadId).toBe('session-1')
    // Nothing to ask, so a host without userQuestions opens it as well.
    await call(threadOpenTool(contextWith(undefined).ctx, t.manager, 'open'), { title: 'b', task: 'y', initiation: 'offer' })
    // The record still says how the thread came to exist.
    expect(t.store.threadsOf('main').map((thread) => thread.initiation)).toEqual(['offer', 'offer'])
  })

  it('tells the model whether an offer asks first', () => {
    const initiation = (tool: ToolDefinition) => (tool.parameters as { properties: Record<string, { description?: string }> }).properties.initiation?.description
    expect(initiation(threadOpenTool(contextWith(undefined).ctx, t.manager))).toContain('(the user is asked first)')
    expect(initiation(threadOpenTool(contextWith(undefined).ctx, t.manager, 'ask'))).toContain('(the user is asked first)')
    expect(initiation(threadOpenTool(contextWith(undefined).ctx, t.manager, 'open'))).toContain('(it opens right away too)')
  })

  it('keeps the confirmation card as the default', () => {
    expect(Config({}).offerApproval).toBe('ask')
    expect(Config({ offerApproval: 'open' }).offerApproval).toBe('open')
    expect(() => Config({ offerApproval: 'never' } as never)).toThrow()
  })

  it('returns refusals as text the model can act on', async () => {
    t.agents.set('plain', t.main)
    const result = await call(threadOpenTool(contextWith(undefined).ctx, t.manager), { title: 'a', task: 'x', initiation: 'user_asked' }, 'plain') as { text: string }
    expect(result.text).toMatch(/^没有开讨论串：只有项目的主对话能开讨论串/)
  })
})

describe('thread_propose', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => { t = setup() })

  it('stores suggestions for the proposals card without opening anything', async () => {
    const text = await call(threadProposeTool(t.manager, 3), { items: [{ title: '补测试', task: '给 a 补测试', worktree: true }, { title: '文档', task: '写 b 的文档' }] })
    expect(text).toContain('「补测试」、「文档」')
    expect(t.manager.proposals('main').map((p) => [p.title, p.worktree])).toEqual([['补测试', true], ['文档', false]])
    expect(t.store.threadsOf('main')).toEqual([])
  })

  it('refuses more than the per-turn limit, and items without a brief', async () => {
    t = setup({ maxProposalsPerTurn: 2 })
    const tool = threadProposeTool(t.manager, 2)
    const items = [1, 2, 3].map((i) => ({ title: `t${i}`, task: `task ${i}` }))
    expect(await call(tool, { items })).toContain('一次最多提 2 个')
    expect(await call(tool, { items: [{ title: 'a', task: '   ' }] })).toContain('至少要有一个带完整简报的提议')
    await expect(call(tool, { items: [{ title: 'a' }] })).rejects.toBeInstanceOf(ToolArgsError)
    expect(t.manager.proposals('main')).toEqual([])
  })
})

describe('thread_reply', () => {
  it('steers the instruction into the thread by default and refuses unknown numbers', async () => {
    const t = setup()
    await t.manager.open('main', { title: 'a', task: 'x', initiation: 'user_asked' })
    await t.manager.onIdle('session-1')
    const tool = threadReplyTool(t.manager)
    expect(await call(tool, { n: 1, message: '再加一个用例' })).toContain('已把追加指令直接插给讨论串 #1')
    expect(t.agents.get('session-1')?.steers.at(-1)).toContain('再加一个用例')
    expect(t.agents.get('session-1')?.followups).toHaveLength(1)
    expect(await call(tool, { n: 7, message: 'x' })).toContain('没有发送：这个主对话没有讨论串 #7')
    await expect(call(tool, { n: '1', message: 'x' })).rejects.toBeInstanceOf(ToolArgsError)
  })

  it('queues it as the next turn when asked to, and refuses an unknown mode', async () => {
    const t = setup()
    await t.manager.open('main', { title: 'a', task: 'x', initiation: 'user_asked' })
    await t.manager.onIdle('session-1')
    const tool = threadReplyTool(t.manager)
    expect(await call(tool, { n: 1, message: '之后再做 B', mode: 'followup' })).toContain('已把追加指令排给讨论串 #1')
    expect(t.agents.get('session-1')?.followups.at(-1)).toContain('之后再做 B')
    expect(t.agents.get('session-1')?.steers).toEqual([])
    await expect(call(tool, { n: 1, message: 'x', mode: 'queue' })).rejects.toBeInstanceOf(ToolArgsError)
  })
})

describe('thread_status', () => {
  it('lists threads, or one thread in detail', async () => {
    const t = setup()
    const tool = threadStatusTool(t.manager)
    expect(await call(tool, {})).toBe('这个主对话还没有讨论串。')
    await t.manager.open('main', { title: '查依赖', task: '列出过期依赖', initiation: 'user_asked' })
    expect(await call(tool, {})).toContain('#1「查依赖」· running')
    expect(await call(tool, { n: 1 })).toContain('任务：列出过期依赖')
    expect(await call(tool, { n: 2 })).toBe('没有讨论串 #2。')
  })
})

describe('thread_mark', () => {
  it('marks a thread solved, reopens it, archives it and unarchives it, by its number', async () => {
    const t = setup()
    await t.manager.open('main', { title: '查依赖', task: '列出过期依赖', initiation: 'user_asked' })
    await t.manager.onIdle('session-1')
    const tool = threadMarkTool(t.manager)
    expect(await call(tool, { n: 1, action: 'resolve' })).toContain('已把讨论串 #1「查依赖」标记为已解决')
    expect(t.store.thread('session-1')).toMatchObject({ resolved: true, archived: false })
    expect(await call(tool, { n: 1, action: 'resolve' })).toContain('标记为已解决')
    expect(await call(tool, { n: 1, action: 'reopen' })).toContain('已重新打开讨论串 #1')
    expect(t.store.thread('session-1')?.resolved).toBe(false)
    expect(await call(tool, { n: 1, action: 'archive' })).toContain('已归档讨论串 #1')
    expect(t.archived.has('session-1')).toBe(true)
    expect(await call(tool, { n: 1, action: 'unarchive' })).toContain('已取消归档讨论串 #1')
    expect(t.archived.has('session-1')).toBe(false)
    await expect(call(tool, { n: 1, action: 'delete' })).rejects.toBeInstanceOf(ToolArgsError)
    await expect(call(tool, { n: 1 })).rejects.toBeInstanceOf(ToolArgsError)
  })

  it('returns refusals as text the model can act on', async () => {
    const t = setup()
    await t.manager.open('main', { title: 'a', task: 'x', initiation: 'user_asked' })
    const tool = threadMarkTool(t.manager)
    // Running: the model is told to stop it first (the user does that in the pane).
    expect(await call(tool, { n: 1, action: 'archive' })).toContain('没有标记：讨论串 #1 还在运行，先停止再归档')
    expect(t.archived.has('session-1')).toBe(false)
    expect(await call(tool, { n: 7, action: 'resolve' })).toContain('没有标记：这个主对话没有讨论串 #7')
  })
})

describe('thread_report', () => {
  it('records the round\'s report from a thread', async () => {
    const t = setup()
    await t.manager.open('main', { title: 'a', task: 'x', initiation: 'user_asked' })
    const text = await call(threadReportTool(t.manager, 300), { status: 'needs_decision', summary: '两种做法', decisions: ['用 A 还是 B'] }, 'session-1')
    expect(text).toContain('回报已记录')
    expect(t.store.thread('session-1')?.lastReport).toMatchObject({ status: 'needs_decision', summary: '两种做法', changedFiles: [], decisions: ['用 A 还是 B'] })
  })

  it('tells a thread the user stopped that its report was not recorded', async () => {
    const t = setup()
    await t.manager.open('main', { title: 'a', task: 'x', initiation: 'user_asked' })
    t.stopped.add('session-1')
    await t.manager.onIdle('session-1')
    const text = await call(threadReportTool(t.manager, 300), { status: 'done', summary: '后台任务结束了' }, 'session-1')
    expect(text).toContain('没有记录这份回报')
    expect(text).toContain('不要继续这项任务')
    expect(t.store.thread('session-1')?.lastReport).toBeNull()
  })

  it('records a report made after the round ended and delivers it, which is now true', async () => {
    const t = setup()
    await t.manager.open('main', { title: 'a', task: 'x', initiation: 'user_asked' })
    const tool = threadReportTool(t.manager, 300)
    await call(tool, { status: 'done', summary: '后台任务已启动' }, 'session-1')
    await t.manager.onIdle('session-1')
    // DSH wakes the thread for the finished job; there is no round.
    await t.manager.onInbox('session-1', 'tool-jobs', 30, 'background job finished')
    const text = await call(tool, { status: 'done', summary: '后台任务已结束' }, 'session-1')
    // The report opened a round of its own, so it settles into a note like any other: the tool
    // result promises the main conversation hears it without the thread doing anything more.
    expect(text).toContain('不用等这一轮结束')
    await t.manager.onIdle('session-1')
    expect(t.main.followups).toHaveLength(2)
    expect(t.main.followups[1]).toContain('后台任务已结束')
  })

  it('refuses sessions that are not threads, and statuses outside the list', async () => {
    const t = setup()
    const tool = threadReportTool(t.manager, 300)
    expect(await call(tool, { status: 'done', summary: 'ok' })).toBe('只有讨论串会话能调用 thread_report。')
    await expect(call(tool, { status: 'finished', summary: 'ok' }, 'session-1')).rejects.toBeInstanceOf(ToolArgsError)
  })
})
