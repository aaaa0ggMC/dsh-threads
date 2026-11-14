import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { ThreadError } from '../src/manager.ts'
import { FakeAgent, setup } from './fixtures.ts'

describe('ThreadManager', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => { t = setup() })

  it('opens a thread: record, title, inherited preset, and the brief sent as a dispatch round', async () => {
    const thread = await t.manager.open('main', { title: '查依赖', task: '列出过期依赖', initiation: 'user_asked' })
    expect(thread).toMatchObject({ n: 1, status: 'running', round: 'dispatch', mainSessionId: 'main' })
    expect(t.renamed).toEqual(['session-1:#1 查依赖'])
    expect(t.inherited).toEqual(['ask->session-1'])
    expect(t.agents.get('session-1')?.followups[0]).toContain('列出过期依赖')
    expect(t.manager.isThread('session-1')).toBe(true)
  })

  it('refuses to open a thread when the main conversation\'s preset cannot be read', async () => {
    t.unreachableMain()
    await expect(t.manager.open('main', { title: 'a', task: 'x', initiation: 'user_asked', worktree: true })).rejects.toBeInstanceOf(ThreadError)
    // Nothing was created: no record, no session, no worktree checkout entered.
    expect(t.store.threadsOf('main')).toEqual([])
    expect(t.agents.has('session-1')).toBe(false)
    expect(t.entered).toEqual([])
  })

  it('does not set a preset when the setting is off', async () => {
    t = setup({ inheritPermissionPreset: false })
    t.unreachableMain()
    await t.manager.open('main', { title: 'a', task: 'x', initiation: 'user_asked' })
    expect(t.inherited).toEqual([])
  })

  it('refuses beyond maxRunning, and refuses from inside a thread', async () => {
    t = setup({ maxRunning: 1 })
    await t.manager.open('main', { title: 'a', task: 'a', initiation: 'user_asked' })
    await expect(t.manager.open('main', { title: 'b', task: 'b', initiation: 'user_asked' })).rejects.toBeInstanceOf(ThreadError)
    await expect(t.manager.open('session-1', { title: 'c', task: 'c', initiation: 'user_asked' })).rejects.toBeInstanceOf(ThreadError)
  })

  it('marks the thread failed when its session cannot be created', async () => {
    t.failCreate()
    await expect(t.manager.open('main', { title: 'a', task: 'a', initiation: 'user_asked' })).rejects.toThrow('create failed')
    expect(t.store.thread('session-1')).toMatchObject({ status: 'failed', error: 'Error: create failed' })
  })

  it('reports a finished round to the idle main conversation and wakes it', async () => {
    await t.manager.open('main', { title: '查依赖', task: 'x', initiation: 'user_asked' })
    await t.manager.recordReport('session-1', { status: 'done', summary: '有 3 个过期依赖', changedFiles: [], decisions: [] })
    await t.manager.onIdle('session-1')
    expect(t.store.thread('session-1')).toMatchObject({ status: 'idle', round: null })
    expect(t.main.followups).toHaveLength(1)
    expect(t.main.followups[0]).toContain('有 3 个过期依赖')
    expect(t.store.main('main').autoWakeStreak).toBe(1)
  })

  it('delivers a report as soon as the thread records it, without waiting for the round to end', async () => {
    // A thread that leaves TODOs unticked often keeps working after reporting; the main
    // conversation must hear the result anyway, or it can never schedule the next step.
    await t.manager.open('main', { title: 'a', task: 'x', initiation: 'user_asked' })
    await t.manager.recordReport('session-1', { status: 'done', summary: '先做到这里', changedFiles: [], decisions: [] })
    expect(t.main.followups).toHaveLength(1)
    expect(t.main.followups[0]).toContain('先做到这里')
    // The round is still open; ending it later does not send the same report twice.
    expect(t.store.thread('session-1')).toMatchObject({ status: 'running', round: 'dispatch', reportSentAt: t.store.thread('session-1')!.lastReport!.at })
    await t.manager.onIdle('session-1')
    expect(t.main.followups).toHaveLength(1)
    expect(t.store.thread('session-1')).toMatchObject({ status: 'idle', round: null })
  })

  it('falls back to the last reply when the thread did not report', async () => {
    await t.manager.open('main', { title: 'a', task: 'x', initiation: 'user_asked' })
    t.outputs.set('session-1', '做完了，但忘了回报')
    await t.manager.onIdle('session-1')
    expect(t.main.followups[0]).toContain('做完了，但忘了回报')
  })

  it('holds the note while the main conversation is busy and delivers it when it goes idle', async () => {
    await t.manager.open('main', { title: 'a', task: 'x', initiation: 'user_asked' })
    t.main.status = 'running'
    await t.manager.onIdle('session-1')
    expect(t.main.followups).toHaveLength(0)
    expect(t.store.main('main').pendingNotes).toHaveLength(1)
    t.main.status = 'idle'
    await t.manager.onIdle('main')
    expect(t.main.followups).toHaveLength(1)
    expect(t.store.main('main').pendingNotes).toHaveLength(0)
  })

  it('reports a round the user drove in the thread quietly, quoting what they asked', async () => {
    await t.manager.open('main', { title: 'a', task: 'x', initiation: 'user_asked' })
    await t.manager.onIdle('session-1')
    await t.manager.onInbox('session-1', 'user', 10, '困难模式再快一点')
    await t.manager.onInbox('session-1', 'user', 12, '起步 60ms')
    expect(t.store.thread('session-1')).toMatchObject({ status: 'running', round: 'user', roundStartSeq: 10, userMessages: ['困难模式再快一点', '起步 60ms'] })
    await t.manager.onIdle('session-1')
    expect(t.main.followups).toHaveLength(1)
    expect(t.main.injects).toHaveLength(1)
    expect(t.main.injects[0]).toContain('用户的原话：「困难模式再快一点」 「起步 60ms」')
    expect(t.store.thread('session-1')?.userMessages).toEqual([])
  })

  it('ignores our own messages and stops waking after maxAutoWakes until the user speaks', async () => {
    t = setup({ maxAutoWakes: 1 })
    await t.manager.open('main', { title: 'a', task: 'x', initiation: 'user_asked' })
    await t.manager.onInbox('session-1', 'dsh-threads', 1)
    expect(t.store.thread('session-1')?.round).toBe('dispatch')
    await t.manager.onIdle('session-1')
    expect(t.main.followups).toHaveLength(1)

    await t.manager.onInbox('session-1', 'user', 5)
    await t.manager.onIdle('session-1')
    await t.manager.open('main', { title: 'b', task: 'y', initiation: 'user_asked' })
    await t.manager.onIdle('session-2')
    expect(t.main.followups).toHaveLength(1)
    expect(t.main.injects).toHaveLength(2)

    await t.manager.onInbox('main', 'user', 0)
    expect(t.store.main('main').autoWakeStreak).toBe(0)
  })

  it('describes threads for thread_status', async () => {
    await t.manager.open('main', { title: '查依赖', task: 'x', initiation: 'offer' })
    expect(t.manager.describe('main')).toContain('#1「查依赖」· running')
    expect(t.manager.describe('main', 1)).toContain('任务：x')
    expect(() => t.manager.describe('main', 9)).toThrow(ThreadError)
  })

  it('only lets a project main conversation open threads', async () => {
    t.agents.set('other', new FakeAgent('other'))
    expect(t.manager.isDispatcher('main')).toBe(true)
    expect(t.manager.isDispatcher('other')).toBe(false)
    await expect(t.manager.open('other', { title: 'a', task: 'a', initiation: 'user_asked' })).rejects.toBeInstanceOf(ThreadError)
  })

  it('stops a running thread: no reminder, a quiet note that says the user stopped it', async () => {
    t = setup({ reportReminder: true })
    await t.manager.open('main', { title: 'a', task: 'x', initiation: 'user_asked' })
    const thread = t.agents.get('session-1')!
    thread.status = 'running'
    await t.manager.stop('session-1')
    await t.manager.onIdle('session-1')
    // The reminder would have restarted the thread.
    expect(thread.followups).toHaveLength(1)
    expect(t.store.thread('session-1')).toMatchObject({ status: 'idle', round: null })
    expect(t.main.followups).toHaveLength(0)
    expect(t.main.injects[0]).toContain('· stopped ·')
    expect(t.main.injects[0]).toContain('不要自己重开或重派')
    expect(t.main.metas[0]?.threads[0]?.status).toBe('stopped')
  })

  it('treats DSH\'s own stop button like ours', async () => {
    t = setup({ reportReminder: true })
    await t.manager.open('main', { title: 'a', task: 'x', initiation: 'user_asked' })
    t.stopped.add('session-1')
    await t.manager.onIdle('session-1')
    expect(t.agents.get('session-1')?.followups).toHaveLength(1)
    expect(t.main.injects[0]).toContain('· stopped ·')
  })

  it('keeps a report made before the stop, and still counts the thread as stopped', async () => {
    await t.manager.open('main', { title: 'a', task: 'x', initiation: 'user_asked' })
    await t.manager.recordReport('session-1', { status: 'done', summary: '做了一半', changedFiles: [], decisions: [] })
    t.stopped.add('session-1')
    await t.manager.onIdle('session-1')
    expect(t.main.injects[0]).toContain('· stopped ·')
    expect(t.main.injects[0]).toContain('做了一半')
    expect(t.store.thread('session-1')).toMatchObject({ stopped: true, lastReport: { status: 'done' } })
  })

  it('refuses to stop a thread that is not running', async () => {
    await t.manager.open('main', { title: 'a', task: 'x', initiation: 'user_asked' })
    // The record says running but the agent is idle: nothing to cancel.
    await expect(t.manager.stop('session-1')).rejects.toThrow('现在没有在运行')
    await t.manager.onIdle('session-1')
    await expect(t.manager.stopNumber('main', 1)).rejects.toBeInstanceOf(ThreadError)
    await expect(t.manager.stopNumber('main', 9)).rejects.toThrow('没有讨论串 #9')
  })

  it('archives a finished thread on its own, refuses while it runs, and refuses follow-ups to it', async () => {
    await t.manager.open('main', { title: 'a', task: 'x', initiation: 'user_asked' })
    await expect(t.manager.setArchived('session-1', true)).rejects.toThrow('先停止再归档')
    await t.manager.onIdle('session-1')
    expect((await t.manager.setArchived('session-1', true)).archived).toBe(true)
    expect(t.archived.has('session-1')).toBe(true)
    await expect(t.manager.reply('main', 1, 'more')).rejects.toThrow('已被用户归档')
    expect(t.manager.describe('main')).toContain('· 已归档')
    expect((await t.manager.setArchived('session-1', false)).archived).toBe(false)
    expect(t.archived.has('session-1')).toBe(false)
  })

  it('counts the messages a main conversation receives, not a thread\'s', async () => {
    await t.manager.open('main', { title: 'a', task: 'x', initiation: 'user_asked' })
    await t.manager.onInbox('main', 'user', 1, 'hi')
    await t.manager.onInbox('main', 'dsh-threads', 2)
    await t.manager.onInbox('session-1', 'user', 3, 'in the thread')
    expect(t.manager.inboxCount('main')).toBe(2)
    expect(t.manager.inboxCount('session-1')).toBe(0)
  })

  it('treats a deleted project\'s threads as ordinary conversations', async () => {
    await t.manager.open('main', { title: 'a', task: 'x', initiation: 'user_asked' })
    await t.manager.onIdle('session-1')
    expect(t.manager.isProjectThread('session-1')).toBe(true)
    await t.store.removeProject('project-1')
    expect(t.manager.isThread('session-1')).toBe(true)
    expect(t.manager.isProjectThread('session-1')).toBe(false)
    // The user talking there no longer starts a round that reports to the old main conversation.
    await t.manager.onInbox('session-1', 'user', 10, 'hi')
    await t.manager.onIdle('session-1')
    expect(t.store.thread('session-1')).toMatchObject({ status: 'idle', round: null })
    expect(t.main.injects).toHaveLength(0)
  })
})

// DSH's stop ends the turn, not the background jobs the thread started. When one finishes, DSH
// puts a `tool-jobs` notice in the idle session's inbox and that starts a turn by itself.
describe('a stopped thread that DSH wakes for a finished background job', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => { t = setup({ reportReminder: true }) })

  /** Open #1, stop it (our stop, or DSH's own button), let the round settle, then let the job notice start a turn. */
  async function stopThenWake(how: 'ours' | 'dsh') {
    await t.manager.open('main', { title: 'a', task: 'sleep 61 后回报', initiation: 'user_asked' })
    const thread = t.agents.get('session-1')!
    thread.status = 'running'
    if (how === 'ours') await t.manager.stop('session-1')
    else { thread.status = 'idle'; t.stopped.add('session-1') }
    await t.manager.onIdle('session-1')
    thread.status = 'running'
    await t.manager.onInbox('session-1', 'tool-jobs', 30, 'background job bash-1 (bash: sleep 61) finished [status: completed, exit code: 0]')
    return thread
  }

  for (const how of ['ours', 'dsh'] as const) {
    it(`stays stopped and refuses the late report (${how === 'ours' ? 'our stop' : "DSH's stop button"})`, async () => {
      const thread = await stopThenWake(how)
      // Not a round: nothing to settle, nothing to remind.
      expect(t.store.thread('session-1')).toMatchObject({ status: 'idle', round: null, stopped: true })
      expect(t.manager.isStopped('session-1')).toBe(true)
      await expect(t.manager.recordReport('session-1', { status: 'done', summary: 'sleep 结束了', changedFiles: [], decisions: [] })).rejects.toThrow('用户已经停止了这个讨论串')
      thread.status = 'idle'
      await t.manager.onIdle('session-1')
      expect(t.store.thread('session-1')).toMatchObject({ status: 'idle', round: null, stopped: true, lastReport: null })
      // Only the brief ever went to the thread; the main conversation heard once, quietly, that the user stopped it.
      expect(thread.followups).toHaveLength(1)
      expect(t.main.followups).toHaveLength(0)
      expect(t.main.injects).toHaveLength(1)
      expect(t.main.injects[0]).toContain('· stopped ·')
      expect(t.store.main('main').pendingNotes).toEqual([])
      expect(t.manager.describe('main')).toContain('· idle · 用户已停止 ·')
      expect(t.manager.describe('main', 1)).toContain('· idle · 用户已停止（会话')
    })
  }

  it('lets the user stop the turn DSH started', async () => {
    const thread = await stopThenWake('ours')
    await t.manager.stop('session-1')
    expect(thread.status).toBe('idle')
    await t.manager.onIdle('session-1')
    expect(t.main.injects).toHaveLength(1)
  })

  it('runs again when the user writes in it: a user-driven round whose report is recorded', async () => {
    const thread = await stopThenWake('dsh')
    thread.status = 'idle'
    await t.manager.onIdle('session-1')
    // The user's own message starts a turn that ends normally.
    t.stopped.delete('session-1')
    await t.manager.onInbox('session-1', 'user', 40, '继续，把结果告诉我')
    expect(t.store.thread('session-1')).toMatchObject({ status: 'running', round: 'user', stopped: false })
    expect(t.manager.isStopped('session-1')).toBe(false)
    await t.manager.recordReport('session-1', { status: 'done', summary: 'sleep 结束了', changedFiles: [], decisions: [] })
    await t.manager.onIdle('session-1')
    expect(t.main.injects).toHaveLength(2)
    expect(t.main.injects[1]).toContain('· done ·')
    expect(t.manager.describe('main')).not.toContain('用户已停止')
  })

  it('runs again when the main conversation sends a follow-up', async () => {
    const thread = await stopThenWake('ours')
    thread.status = 'idle'
    await t.manager.onIdle('session-1')
    t.stopped.delete('session-1')
    await t.manager.reply('main', 1, '用户让你接着做')
    expect(t.store.thread('session-1')).toMatchObject({ status: 'running', round: 'dispatch', stopped: false })
    await t.manager.recordReport('session-1', { status: 'done', summary: '做完了', changedFiles: [], decisions: [] })
    await t.manager.onIdle('session-1')
    expect(t.main.followups).toHaveLength(1)
    expect(t.main.followups[0]).toContain('做完了')
  })

  it('does not hold back a thread that was not stopped', async () => {
    await t.manager.open('main', { title: 'a', task: 'x', initiation: 'user_asked' })
    await t.manager.recordReport('session-1', { status: 'done', summary: '第一轮', changedFiles: [], decisions: [] })
    await t.manager.onIdle('session-1')
    expect(t.manager.isStopped('session-1')).toBe(false)
    await t.manager.onInbox('session-1', 'tool-jobs', 30, 'background job finished')
    await t.manager.recordReport('session-1', { status: 'done', summary: '后台任务也好了', changedFiles: [], decisions: [] })
    expect(t.store.thread('session-1')?.lastReport?.summary).toBe('后台任务也好了')
  })
})

// The neighbouring case: the round ended normally, the thread left a background job running, and
// DSH wakes it when the job finishes. A report from that turn must reach the main conversation.
describe('a thread that reports again after its round ended', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => { t = setup({ reportReminder: true }) })

  const report = (summary: string, status: 'done' | 'failed' = 'done') => ({ status, summary, changedFiles: [], decisions: [] })

  /** Open #1, let it report that the job was started, and settle the round (the main conversation is woken once). */
  async function reportedOnce() {
    await t.manager.open('main', { title: '构建', task: '后台跑构建，结束后回报', initiation: 'user_asked' })
    const thread = t.agents.get('session-1')!
    thread.status = 'running'
    await t.manager.recordReport('session-1', report('构建已在后台启动，结果待回报'))
    thread.status = 'idle'
    await t.manager.onIdle('session-1')
    return thread
  }

  /** DSH's notice that the job finished starts a turn by itself. */
  async function jobWakes(thread: FakeAgent, seq = 30) {
    thread.status = 'running'
    thread.seq = seq
    await t.manager.onInbox('session-1', 'tool-jobs', seq, 'background job bash-1 (bash: npm run build) finished [status: failed, exit code: 1]')
  }

  it('delivers the late report by the wake-up rules, marked as replacing the earlier one', async () => {
    const thread = await reportedOnce()
    expect(t.main.followups).toHaveLength(1)
    expect(t.store.thread('session-1')).toMatchObject({ status: 'idle', round: null, lastRound: 'dispatch', late: false })

    await jobWakes(thread)
    // The notice alone opens no round.
    expect(t.store.thread('session-1')).toMatchObject({ status: 'idle', round: null })
    await t.manager.recordReport('session-1', report('构建失败：3 个测试没过', 'failed'))
    // The report does: the thread counts as running until this turn ends.
    expect(t.store.thread('session-1')).toMatchObject({ status: 'running', round: 'dispatch', late: true, roundStartSeq: 30 })
    expect(t.manager.runningCount('main')).toBe(1)
    thread.status = 'idle'
    await t.manager.onIdle('session-1')

    expect(t.store.thread('session-1')).toMatchObject({ status: 'idle', round: null, late: false, lastRound: 'dispatch', stopped: false })
    expect(t.main.followups).toHaveLength(2)
    expect(t.main.followups[1]).toContain('· failed ·')
    expect(t.main.followups[1]).toContain('构建失败：3 个测试没过')
    expect(t.main.followups[1]).toContain('上一轮结束之后补交的回报')
    expect(t.main.followups[1]).not.toContain('构建已在后台启动')
    expect(t.main.metas.at(-1)).toMatchObject({ role: 'report', wake: true, threads: [{ n: 1, status: 'failed' }] })
    expect(t.store.main('main').autoWakeStreak).toBe(2)
    // The late round never asks for a report: it exists because of one. Only the brief went to the thread.
    expect(thread.followups).toHaveLength(1)
  })

  it('tells nobody when the thread does not report in the turn DSH started', async () => {
    const thread = await reportedOnce()
    await jobWakes(thread)
    t.outputs.set('session-1', '后台任务结束了，没什么要补充的。')
    thread.status = 'idle'
    await t.manager.onIdle('session-1')
    expect(t.store.thread('session-1')).toMatchObject({ status: 'idle', round: null, lastReport: { summary: '构建已在后台启动，结果待回报' } })
    expect(t.main.followups).toHaveLength(1)
    expect(t.main.injects).toHaveLength(0)
    expect(thread.followups).toHaveLength(1)
  })

  it('delivers the late report even while another thread is running', async () => {
    const thread = await reportedOnce()
    await t.manager.open('main', { title: 'b', task: 'y', initiation: 'user_asked' })
    await jobWakes(thread)
    await t.manager.recordReport('session-1', report('构建通过'))
    thread.status = 'idle'
    await t.manager.onIdle('session-1')
    // A finished thread's result is not held behind a sibling that is still running: the main
    // conversation hears about each thread as it finishes, in its own wake-up.
    expect(t.main.followups).toHaveLength(2)
    expect(t.main.followups[1]).toContain('构建通过')
    expect(t.store.main('main').pendingNotes).toEqual([])
    await t.manager.recordReport('session-2', report('b 做完了'))
    await t.manager.onIdle('session-2')
    expect(t.main.followups).toHaveLength(3)
    expect(t.main.followups[2]).toContain('b 做完了')
  })

  it('stops waking at maxAutoWakes: the late report is put in quietly', async () => {
    t = setup({ maxAutoWakes: 1 })
    const thread = await reportedOnce()
    expect(t.store.main('main').autoWakeStreak).toBe(1)
    await jobWakes(thread)
    await t.manager.recordReport('session-1', report('构建通过'))
    thread.status = 'idle'
    await t.manager.onIdle('session-1')
    expect(t.main.followups).toHaveLength(1)
    expect(t.main.injects).toHaveLength(1)
    expect(t.main.injects[0]).toContain('构建通过')
    expect(t.store.main('main').pendingNotes).toEqual([])
  })

  it('is quiet when the last round was one the user drove in the thread', async () => {
    const thread = await reportedOnce()
    await t.manager.onInbox('session-1', 'user', 20, '再后台跑一次测试')
    await t.manager.recordReport('session-1', report('测试已在后台启动'))
    await t.manager.onIdle('session-1')
    expect(t.store.thread('session-1')).toMatchObject({ round: null, lastRound: 'user' })
    expect(t.main.injects).toHaveLength(1)

    await jobWakes(thread, 40)
    await t.manager.recordReport('session-1', report('测试通过'))
    expect(t.store.thread('session-1')).toMatchObject({ status: 'running', round: 'user', late: true })
    thread.status = 'idle'
    await t.manager.onIdle('session-1')
    expect(t.main.followups).toHaveLength(1)
    expect(t.main.injects).toHaveLength(2)
    expect(t.main.injects[1]).toContain('测试通过')
    expect(t.main.injects[1]).toContain('补交的回报')
    // Nothing the user said belongs to this round.
    expect(t.main.injects[1]).not.toContain('用户的原话')
    expect(t.store.thread('session-1')).toMatchObject({ lastRound: 'user' })
  })

  it('keeps only the newest report when the thread reports twice in that turn', async () => {
    const thread = await reportedOnce()
    await jobWakes(thread)
    await t.manager.recordReport('session-1', report('构建结束，正在看日志'))
    await t.manager.recordReport('session-1', report('构建通过，日志无警告'))
    expect(t.store.thread('session-1')).toMatchObject({ round: 'dispatch', late: true, roundStartSeq: 30 })
    thread.status = 'idle'
    await t.manager.onIdle('session-1')
    expect(t.main.followups).toHaveLength(2)
    expect(t.main.followups[1]).toContain('构建通过，日志无警告')
    expect(t.main.followups[1]).not.toContain('正在看日志')
  })

  it('settles as stopped when the user stops that turn after the report', async () => {
    const thread = await reportedOnce()
    await jobWakes(thread)
    await t.manager.recordReport('session-1', report('构建通过'))
    await t.manager.stop('session-1')
    await t.manager.onIdle('session-1')
    expect(t.store.thread('session-1')).toMatchObject({ status: 'idle', round: null, stopped: true, late: false })
    expect(t.main.followups).toHaveLength(1)
    expect(t.main.injects).toHaveLength(1)
    expect(t.main.injects[0]).toContain('· stopped ·')
    expect(t.main.injects[0]).toContain('构建通过')
    // From here on it is a stopped thread: the next job notice cannot report.
    await jobWakes(thread, 50)
    await expect(t.manager.recordReport('session-1', report('又一个任务结束了'))).rejects.toThrow('用户已经停止了这个讨论串')
  })

  it('becomes an ordinary task round when the main conversation sends a follow-up meanwhile', async () => {
    const thread = await reportedOnce()
    await jobWakes(thread)
    await t.manager.recordReport('session-1', report('构建失败', 'failed'))
    await t.manager.reply('main', 1, '失败的话顺手修掉')
    expect(t.store.thread('session-1')).toMatchObject({ status: 'running', round: 'dispatch', late: false })
    await t.manager.recordReport('session-1', report('修好了，构建通过'))
    thread.status = 'idle'
    await t.manager.onIdle('session-1')
    expect(t.main.followups).toHaveLength(2)
    expect(t.main.followups[1]).toContain('修好了，构建通过')
    expect(t.main.followups[1]).not.toContain('补交')
  })

  it('does not lose a follow-up that arrives while the report is being recorded', async () => {
    const thread = await reportedOnce()
    await jobWakes(thread)
    // Both read the record before either writes.
    const recording = t.manager.recordReport('session-1', report('构建失败', 'failed'))
    const replying = t.manager.reply('main', 1, '失败的话顺手修掉')
    await Promise.all([recording, replying])
    expect(t.store.thread('session-1')).toMatchObject({ status: 'running', round: 'dispatch', late: false, lastReport: { summary: '构建失败' } })
  })

  it('delivers a late round that was still open when DSH restarted', async () => {
    const thread = await reportedOnce()
    await jobWakes(thread)
    await t.manager.recordReport('session-1', report('构建通过'))
    thread.status = 'idle'
    await t.manager.recover()
    expect(t.store.thread('session-1')).toMatchObject({ status: 'idle', round: null })
    expect(t.main.followups).toHaveLength(2)
    expect(t.main.followups[1]).toContain('构建通过')
  })

  it('only records the report in a deleted project\'s thread', async () => {
    const thread = await reportedOnce()
    await t.store.removeProject('project-1')
    await jobWakes(thread)
    await t.manager.recordReport('session-1', report('构建通过'))
    expect(t.store.thread('session-1')).toMatchObject({ status: 'idle', round: null, late: false, lastReport: { summary: '构建通过' } })
    thread.status = 'idle'
    await t.manager.onIdle('session-1')
    expect(t.main.followups).toHaveLength(1)
  })
})

describe('ThreadManager.reply', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => { t = setup() })

  it('starts a new dispatched round on an idle thread and steers it by default', async () => {
    await t.manager.open('main', { title: 'a', task: 'x', initiation: 'user_asked' })
    await t.manager.onIdle('session-1')
    await t.store.putThread({ ...t.store.thread('session-1')!, resolved: true })
    const thread = t.agents.get('session-1')!
    thread.seq = 42
    await t.manager.reply('main', 1, '再补一个测试')
    expect(t.store.thread('session-1')).toMatchObject({ status: 'running', round: 'dispatch', roundStartSeq: 42, resolved: false })
    expect(thread.steers.at(-1)).toContain('再补一个测试')
    // The reply is steered, not queued as another turn behind the brief.
    expect(thread.followups.some((text) => text.includes('再补一个测试'))).toBe(false)
  })

  it('can queue the instruction as the thread\'s own next turn', async () => {
    await t.manager.open('main', { title: 'a', task: 'x', initiation: 'user_asked' })
    await t.manager.onIdle('session-1')
    const thread = t.agents.get('session-1')!
    await t.manager.reply('main', 1, '下一件事做 B', 'followup')
    expect(thread.followups.at(-1)).toContain('下一件事做 B')
    expect(thread.steers).toEqual([])
  })

  it('upgrades a user-driven round so its result wakes the main conversation', async () => {
    await t.manager.open('main', { title: 'a', task: 'x', initiation: 'user_asked' })
    await t.manager.onIdle('session-1')
    await t.manager.onInbox('session-1', 'user', 5)
    await t.manager.reply('main', 1, '顺便看下 B')
    expect(t.store.thread('session-1')).toMatchObject({ round: 'dispatch', roundStartSeq: 5 })
    // The bug this fixes: a running thread must get the message into its current work
    // (steer), not queued behind the turn it is still working on (followup).
    expect(t.agents.get('session-1')?.steers.at(-1)).toContain('顺便看下 B')
    await t.manager.onIdle('session-1')
    expect(t.main.followups).toHaveLength(2)
  })

  it('refuses an unknown or unfinished thread', async () => {
    await expect(t.manager.reply('main', 1, 'x')).rejects.toBeInstanceOf(ThreadError)
    t.failCreate()
    await expect(t.manager.open('main', { title: 'a', task: 'x', initiation: 'user_asked' })).rejects.toThrow()
    await expect(t.manager.reply('main', 1, 'x')).rejects.toBeInstanceOf(ThreadError)
  })
})

describe('ThreadManager.setResolved', () => {
  it('marks a thread resolved, and a user message in it reopens it', async () => {
    const t = setup()
    await t.manager.open('main', { title: 'a', task: 'x', initiation: 'user_asked' })
    await t.manager.onIdle('session-1')
    expect((await t.manager.setResolved('session-1', true)).resolved).toBe(true)
    await t.manager.onInbox('session-1', 'user', 3)
    expect(t.store.thread('session-1')).toMatchObject({ resolved: false, round: 'user' })
    await expect(t.manager.setResolved('session-x', true)).rejects.toBeInstanceOf(ThreadError)
  })
})

describe('thread model', () => {
  it("opens threads on the project's thread model, and on the default when DSH cannot use it", async () => {
    const t = setup()
    const project = t.store.projectOfMain('main')!
    await t.store.putProject({ ...project, threadModel: { provider: 'deepseek', model: 'deepseek-pro', reasoningEffort: 'high' } })
    await t.manager.open('main', { title: 'a', task: 'a', initiation: 'user_asked' })
    expect(t.models).toEqual(['session-1:deepseek/deepseek-pro'])

    await t.store.putProject({ ...project, threadModel: { provider: 'deepseek', model: 'missing' } })
    const thread = await t.manager.open('main', { title: 'b', task: 'b', initiation: 'user_asked' })
    expect(thread.status).toBe('running')
  })
})

describe('wake streak', () => {
  it('resets when the user speaks, even while a delivery to the main conversation is in flight', async () => {
    const t = setup({}, { slowMain: true })
    await t.store.putMain({ ...t.store.main('main'), autoWakeStreak: 2 })
    await t.manager.open('main', { title: 'a', task: 'x', initiation: 'user_asked' })
    const settling = t.manager.onIdle('session-1')
    // The delivery is waiting to reach the main conversation when the user speaks there.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await t.manager.onInbox('main', 'user', 5)
    await settling
    expect(t.main.followups).toHaveLength(1)
    expect(t.store.main('main').autoWakeStreak).toBe(0)
  })
})

describe('report reminder', () => {
  it('asks a thread once to report, keeps the round open, and delivers the report it then sends', async () => {
    const t = setup({ reportReminder: true })
    await t.manager.open('main', { title: '查依赖', task: 'x', initiation: 'user_asked' })
    t.outputs.set('session-1', '做完了')
    await t.manager.onIdle('session-1')
    const thread = t.agents.get('session-1')!
    expect(thread.followups[1]).toContain('没有调用 thread_report')
    expect(thread.metas[1]?.role).toBe('reminder')
    expect(t.store.thread('session-1')).toMatchObject({ status: 'running', round: 'dispatch', reminder: { fallback: '做完了' } })
    expect(t.main.followups).toHaveLength(0)

    await t.manager.recordReport('session-1', { status: 'done', summary: '有 3 个过期依赖', changedFiles: [], decisions: [] })
    await t.manager.onIdle('session-1')
    expect(t.main.followups[0]).toContain('有 3 个过期依赖')
    expect(t.store.thread('session-1')).toMatchObject({ status: 'idle', round: null, reminder: null })
  })

  it('falls back to the reply from before the reminder when the thread still does not report', async () => {
    const t = setup({ reportReminder: true })
    await t.manager.open('main', { title: 'a', task: 'x', initiation: 'user_asked' })
    t.outputs.set('session-1', '真正的结果')
    await t.manager.onIdle('session-1')
    t.outputs.set('session-1', '好的')
    await t.manager.onIdle('session-1')
    expect(t.agents.get('session-1')!.followups).toHaveLength(2)
    expect(t.main.followups[0]).toContain('真正的结果')
    expect(t.main.followups[0]).not.toContain('好的')
  })

  it('does not remind after a round the user drove in the thread', async () => {
    const t = setup({ reportReminder: true })
    await t.manager.open('main', { title: 'a', task: 'x', initiation: 'user_asked' })
    await t.manager.recordReport('session-1', { status: 'done', summary: 'ok', changedFiles: [], decisions: [] })
    await t.manager.onIdle('session-1')
    await t.manager.onInbox('session-1', 'user', 10)
    await t.manager.onIdle('session-1')
    expect(t.agents.get('session-1')!.followups).toHaveLength(1)
    expect(t.main.injects).toHaveLength(1)
  })
})

describe('parallel threads', () => {
  it('runs up to three threads at once by default', async () => {
    const t = setup()
    for (const title of ['a', 'b', 'c']) await t.manager.open('main', { title, task: title, initiation: 'user_asked' })
    expect(t.manager.runningCount('main')).toBe(3)
    await expect(t.manager.open('main', { title: 'd', task: 'd', initiation: 'user_asked' })).rejects.toBeInstanceOf(ThreadError)
  })

  it('keeps the limit and the numbering when opens arrive at the same moment', async () => {
    const t = setup({ maxRunning: 2 }, { slowWrites: true })
    const results = await Promise.allSettled(['a', 'b', 'c'].map((title) => t.manager.open('main', { title, task: title, initiation: 'user_asked' })))
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'rejected'])
    expect(t.store.threadsOf('main').map((thread) => thread.n)).toEqual([1, 2])
  })

  it('tells the main conversation about each thread as it finishes, even while another runs', async () => {
    const t = setup({}, { slowMain: true })
    await t.manager.open('main', { title: 'a', task: 'a', initiation: 'user_asked' })
    await t.manager.open('main', { title: 'b', task: 'b', initiation: 'user_asked' })
    const first = t.manager.onIdle('session-1')
    // b finishes while a's report is still on its way to the main conversation.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await Promise.all([first, t.manager.onIdle('session-2')])
    // a's report is delivered while b is still running; each thread gets its own wake-up.
    expect(t.main.followups).toHaveLength(2)
    expect(t.main.followups[0]).toContain('no-report')
    expect(t.main.metas.map((meta) => meta?.threads.map((card) => card.title))).toEqual([['a'], ['b']])
  })

  it('starts each queued proposal once when two threads free their slots together', async () => {
    const t = setup({ maxRunning: 2 })
    const proposals = await t.manager.propose('main', [{ title: 'A', task: 'a' }, { title: 'B', task: 'b' }, { title: 'C', task: 'c' }])
    await t.manager.startProposals('main', proposals.map((p) => p.id))
    const [first, second] = t.store.threadsOf('main')
    await Promise.all([t.manager.onIdle(first!.id), t.manager.onIdle(second!.id)])
    expect(t.store.threadsOf('main').map((thread) => thread.title)).toEqual(['A', 'B', 'C'])
    expect(t.manager.runningCount('main')).toBe(1)
    // The first finished thread's note is not held behind the proposal that just started.
    expect(t.main.followups).toHaveLength(1)
  })
})

describe('worktrees', () => {
  it('opens a thread in its own worktree: branch on the record, the card and the report', async () => {
    const t = setup()
    const thread = await t.manager.open('main', { title: '改 README', task: 'x', initiation: 'user_asked', worktree: true })
    expect(thread.worktree).toMatchObject({ branch: 'dsh-threads/1-1', path: '/repo/.agents/worktrees/dsh-threads-1-1' })
    expect(t.entered).toEqual(['session-1:/repo/.agents/worktrees/dsh-threads-1-1'])
    expect(t.manager.worktreeOf('session-1')?.branch).toBe('dsh-threads/1-1')
    expect(t.agents.get('session-1')?.metas[0]?.threads[0]?.branch).toBe('dsh-threads/1-1')

    await t.manager.onIdle('session-1')
    expect(t.main.followups[0]).toContain('分支：dsh-threads/1-1')
  })

  it('works in the project\'s subfolder of the checkout when the project is part of a larger repository', async () => {
    const t = setup()
    t.subdir('packages/app')
    await t.manager.open('main', { title: 'a', task: 'x', initiation: 'user_asked', worktree: true })
    expect(t.entered).toEqual([`session-1:${join('/repo/.agents/worktrees/dsh-threads-1-1', 'packages', 'app')}`])
  })

  it('refuses without creating a session when the folder is not a repository', async () => {
    const t = setup()
    t.notARepo()
    await expect(t.manager.open('main', { title: 'a', task: 'x', initiation: 'user_asked', worktree: true })).rejects.toBeInstanceOf(ThreadError)
    expect(t.agents.has('session-1')).toBe(false)
    expect(t.store.threadsOf('main')).toEqual([])
  })

  it('cleans up finished worktrees only, keeping dirty ones', async () => {
    const t = setup()
    await t.manager.open('main', { title: 'a', task: 'a', initiation: 'user_asked', worktree: true })
    await t.manager.open('main', { title: 'b', task: 'b', initiation: 'user_asked', worktree: true })
    await t.manager.open('main', { title: 'c', task: 'c', initiation: 'user_asked', worktree: true })
    await t.manager.onIdle('session-1')
    await t.manager.onIdle('session-2')
    t.removals.set('dsh-threads/2-2', { outcome: 'dirty', branchKept: true })

    expect(t.manager.cleanupCandidates('main').map((thread) => thread.n)).toEqual([1, 2])
    const lines = await t.manager.cleanupWorktrees('main')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('没提交的改动')
    expect(t.store.thread('session-1')?.worktree?.removed).toBe(true)
    expect(t.store.thread('session-2')?.worktree?.removed).toBe(false)
    expect(t.manager.worktreeOf('session-1')).toBeNull()
  })

  it('carries the worktree choice through a proposal', async () => {
    const t = setup()
    const [p] = await t.manager.propose('main', [{ title: 'A', task: 'a', worktree: true }])
    await t.manager.startProposals('main', [p!.id])
    expect(t.store.thread('session-2')?.worktree?.branch).toBe('dsh-threads/1-2')
  })
})

describe('ThreadManager.recover', () => {
  it('fails threads that never started, settles idle ones and reports unreachable ones', async () => {
    const t = setup({ maxRunning: 3 })
    await t.manager.open('main', { title: 'a', task: 'x', initiation: 'user_asked' })
    await t.manager.open('main', { title: 'b', task: 'y', initiation: 'user_asked' })
    await t.manager.recordReport('session-1', { status: 'done', summary: '完成了 a', changedFiles: [], decisions: [] })
    const base = t.store.thread('session-2')!
    await t.store.putThread({ ...base, id: 'session-9', n: 9, status: 'starting', round: null })
    t.agents.delete('session-2')

    await t.manager.recover()

    expect(t.store.thread('session-9')).toMatchObject({ status: 'failed' })
    expect(t.store.thread('session-1')).toMatchObject({ status: 'idle' })
    expect(t.store.thread('session-2')).toMatchObject({ status: 'failed', round: null })
    expect(t.main.followups.join('\n')).toContain('完成了 a')
  })
})

describe('thread cards on notices', () => {
  it('tags the brief and the report with the thread card', async () => {
    const t = setup()
    await t.manager.open('main', { title: '查依赖', task: 'x', initiation: 'user_asked' })
    expect(t.agents.get('session-1')?.metas[0]).toEqual({ role: 'brief', threads: [{ threadId: 'session-1', n: 1, title: '查依赖' }], wake: true })
    await t.manager.recordReport('session-1', { status: 'needs_decision', summary: '要不要升级', changedFiles: ['package.json'], decisions: ['升级?'] })
    await t.manager.onIdle('session-1')
    expect(t.main.metas[0]).toEqual({
      role: 'report',
      threads: [{ threadId: 'session-1', n: 1, title: '查依赖', status: 'needs_decision', summary: '要不要升级', decision: '升级?', files: ['package.json'] }],
      wake: true,
    })
  })
})

describe('proposals', () => {
  it('stores up to maxProposalsPerTurn proposals, only for a project main conversation', async () => {
    const t = setup({ maxProposalsPerTurn: 2 })
    const created = await t.manager.propose('main', [{ title: 'A', task: 'do a' }, { title: '', task: 'do b\nmore' }])
    expect(created.map((p) => [p.title, p.state])).toEqual([['A', 'pending'], ['do b', 'pending']])
    expect(t.manager.proposals('main')).toHaveLength(2)
    await expect(t.manager.propose('main', [{ title: 'a', task: 'a' }, { title: 'b', task: 'b' }, { title: 'c', task: 'c' }])).rejects.toBeInstanceOf(ThreadError)
    await expect(t.manager.propose('other', [{ title: 'a', task: 'a' }])).rejects.toBeInstanceOf(ThreadError)
  })

  it('starts what fits under maxRunning and queues the rest until a thread finishes', async () => {
    const t = setup({ maxRunning: 1 })
    const [a, b] = await t.manager.propose('main', [{ title: 'A', task: 'do a' }, { title: 'B', task: 'do b' }])
    const result = await t.manager.startProposals('main', [a!.id, b!.id])
    expect(result.map((p) => p.state)).toEqual(['started', 'queued'])
    expect(t.store.thread('session-3')).toMatchObject({ initiation: 'proposal', title: 'A' })

    await t.manager.onIdle('session-3')
    expect(t.store.proposal(b!.id)).toMatchObject({ state: 'started' })
    expect(t.manager.runningCount('main')).toBe(1)
    // A's report reaches the main conversation now, without waiting for the queue's B.
    expect(t.main.followups).toHaveLength(1)
    await t.manager.onIdle('session-4')
    expect(t.main.followups).toHaveLength(2)
    expect(t.main.metas[0]?.threads.map((card) => card.title)).toEqual(['A'])
  })

  it('dismisses proposals and drops expired ones from the list', async () => {
    const t = setup({ proposalTtlDays: 1 })
    const [a, b] = await t.manager.propose('main', [{ title: 'A', task: 'a' }, { title: 'B', task: 'b' }])
    await t.manager.dismissProposals('main', [a!.id])
    expect(t.manager.proposals('main').map((p) => p.id)).toEqual([b!.id])
    await t.store.putProposal({ ...b!, expiresAt: '2000-01-01T00:00:00.000Z' })
    expect(t.manager.proposals('main')).toEqual([])
  })
})
