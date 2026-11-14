import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.ts'
import { installPerAgent } from '../src/install.ts'
import { type ProjectHost, Projects } from '../src/projects.ts'
import { setup } from './fixtures.ts'

// Which tools and prompt sections each session gets, and that they follow project changes.

interface FakeSession {
  id: string
  tools: string[]
  sections: { name: string; text: string | (() => string) }[]
  contexts: { name: string; text: string | (() => string) }[]
  disposed: string[]
}

function fakeAgent(id: string, origin?: string) {
  const session: FakeSession = { id, tools: [], sections: [], contexts: [], disposed: [] }
  const agent = {
    id,
    session: { header: { origin } },
    ctx: {
      tools: { register: (tool: { name: string }) => { session.tools.push(tool.name); return () => session.disposed.push(tool.name) } },
      systemPrompt: {
        section: (section: { name: string; text: string | (() => string) }) => {
          session.sections.push(section)
          return () => session.disposed.push(section.name)
        },
        context: (context: { name: string; text: string | (() => string) }) => {
          session.contexts.push(context)
          return () => session.disposed.push(context.name)
        },
      },
    },
  }
  return { agent, session }
}

function harness() {
  const t = setup()
  const agents: ReturnType<typeof fakeAgent>['agent'][] = []
  const listeners = new Map<string, (event: { agent: unknown }) => unknown>()
  const effects: (() => void)[] = []
  const ctx = {
    agents: { list: () => agents },
    on: (event: string, listener: (event: { agent: unknown }) => unknown) => { listeners.set(event, listener) },
    effect: (start: () => () => void) => { effects.push(start()) },
    logger: { warn: () => {} },
  }
  const projects = new Projects({ store: t.store, host: { workspaceOf: () => ({ id: 'ws', path: '/tmp/p' }) } as unknown as ProjectHost, isThread: (id) => t.manager.isThread(id), now: () => '', newProjectId: () => 'p' })
  const add = (id: string, origin?: string) => {
    const created = fakeAgent(id, origin)
    agents.push(created.agent)
    return created
  }
  const main = add('main')
  const plain = add('plain')
  installPerAgent(ctx as unknown as Context, t.manager, projects, Config({}))
  return {
    t, projects, main: main.session, plain: plain.session,
    /** A session DSH creates after the plugin applied. */
    create: (id: string, origin?: string) => {
      const created = add(id, origin)
      listeners.get('agent/created')?.({ agent: created.agent })
      return created.session
    },
    dispose: (id: string) => listeners.get('agent/disposed')?.({ agent: agents.find((agent) => agent.id === id) }),
    unload: () => { for (const stop of effects) stop() },
  }
}

const text = (section: { text: string | (() => string) }) => typeof section.text === 'string' ? section.text : section.text()

describe('installPerAgent', () => {
  it('gives a project\'s main conversation the dispatcher tools and prompt, and plain sessions nothing', () => {
    const h = harness()
    expect(h.main.tools).toEqual(['thread_open', 'thread_propose', 'thread_reply', 'thread_status', 'thread_mark'])
    expect(h.main.sections.map((s) => s.name)).toEqual(['dsh-threads-project', 'dsh-threads'])
    expect(text(h.main.sections[0]!)).toContain('# Project: P')
    expect(text(h.main.sections[1]!)).toContain('# Threads (dsh-threads)')
    // The lead reminder next to each new message: its number follows the messages the main conversation received.
    expect(h.main.contexts.map((c) => c.name)).toEqual(['dsh-threads-lead'])
    expect(text(h.main.contexts[0]!)).toContain('reminder (message 0)')
    void h.t.manager.onInbox('main', 'user', 1, 'hi')
    expect(text(h.main.contexts[0]!)).toContain('reminder (message 1)')
    expect(h.plain.tools).toEqual([])
    expect(h.plain.sections).toEqual([])
    expect(h.plain.contexts).toEqual([])
  })

  it('gives a thread thread_report and the thread prompt, and subagents nothing', async () => {
    const h = harness()
    await h.t.manager.open('main', { title: 'a', task: 'x', initiation: 'user_asked' })
    const thread = h.create('session-1')
    expect(thread.tools).toEqual(['thread_report'])
    expect(text(thread.sections[1]!)).toContain('# You are a thread (dsh-threads)')
    // Nothing extra next to its messages while it works; a notice once the user has stopped it, until it is set going again.
    expect(thread.contexts.map((c) => c.name)).toEqual(['dsh-threads-stopped'])
    expect(text(thread.contexts[0]!)).toBe('')
    h.t.stopped.add('session-1')
    await h.t.manager.onIdle('session-1')
    expect(text(thread.contexts[0]!)).toContain('the user stopped this thread')
    expect(text(thread.contexts[0]!)).toContain('do not call thread_report')
    await h.t.manager.onInbox('session-1', 'user', 5, '继续')
    expect(text(thread.contexts[0]!)).toBe('')
    // A subagent of the main conversation (same project, but not a conversation the user dispatches from).
    expect(h.create('sub', 'subagent').tools).toEqual([])
  })

  it('takes the tools away when the project is deleted, and gives them back when it is made again', async () => {
    const h = harness()
    await h.t.manager.open('main', { title: 'a', task: 'x', initiation: 'user_asked' })
    const thread = h.create('session-1')
    await h.t.manager.onIdle('session-1')

    await h.projects.remove('project-1')
    expect(h.main.disposed.sort()).toEqual(['dsh-threads', 'dsh-threads-lead', 'dsh-threads-project', 'thread_mark', 'thread_open', 'thread_propose', 'thread_reply', 'thread_status'])
    expect(thread.disposed.sort()).toEqual(['dsh-threads', 'dsh-threads-project', 'dsh-threads-stopped', 'thread_report'])

    // Making the old main conversation a project again: the main conversation and its thread get their tools back.
    await h.projects.create({ title: 'P', fromSessionId: 'main' })
    expect(h.main.tools.filter((name) => name === 'thread_open')).toHaveLength(2)
    expect(thread.tools.filter((name) => name === 'thread_report')).toHaveLength(2)
  })

  it('cleans up when a session goes away and when the plugin unloads', () => {
    const h = harness()
    h.dispose('main')
    expect(h.main.disposed).toHaveLength(8)
    const other = harness()
    other.unload()
    expect(other.main.disposed).toHaveLength(8)
  })
})
