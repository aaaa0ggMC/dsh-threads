import { describe, expect, it } from 'vitest'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { domain, openStore } from '../src/storage.ts'

// Records as earlier versions wrote them must still read after an upgrade: every field added
// since then needs a default (CLAUDE.md). These are the oldest shapes of each table, taken from
// the schemas in git history (M1 #1, M2a #2, M2c #4).

type Schema = { parse(value: unknown): unknown }
const table = (name: keyof typeof domain.tables) => (domain.tables[name] as unknown as { valueSchema: Schema }).valueSchema

const report = { status: 'done', summary: 'ok', changedFiles: ['a.ts'], decisions: [], at: '2026-10-23T20:00:00.000Z' }

describe('stored records from earlier versions', () => {
  it('reads an M1 thread with today\'s defaults', () => {
    const m1 = {
      id: 'session-1', mainSessionId: 'session-main', n: 1, title: 'a', task: 'x', initiation: 'user_asked',
      status: 'idle', round: null, roundStartSeq: 3, roundStartedAt: '2026-10-23T20:00:00.000Z',
      lastReport: report, error: null, createdAt: '2026-10-23T20:00:00.000Z', updatedAt: '2026-10-23T20:00:00.000Z',
    }
    expect(table('threads').parse(m1)).toEqual({ ...m1, resolved: false, archived: false, userMessages: [], worktree: null, reminder: null, stopped: false, lastRound: null, late: false, reportSentAt: null })
  })

  it('reads a worktree written before subfolders were recorded', () => {
    const worktree = { path: '/r/.agents/worktrees/dsh-threads-1-abc', branch: 'dsh-threads/1-abc', baseCommit: 'abc', repositoryRoot: '/r', removed: false }
    const thread = {
      id: 'session-1', mainSessionId: 'm', n: 1, title: 'a', task: 'x', initiation: 'proposal', status: 'running', resolved: false,
      round: 'dispatch', roundStartSeq: 0, roundStartedAt: null, lastReport: null, error: null, worktree, createdAt: '', updatedAt: '',
    }
    expect((table('threads').parse(thread) as { worktree: unknown }).worktree).toEqual({ ...worktree, subdir: '' })
  })

  it('reads an M1 main record and its notes, without cards', () => {
    const m1 = { id: 'session-main', autoWakeStreak: 2, pendingNotes: [{ threadId: 'session-1', text: '[讨论串 #1] …', quiet: false }] }
    expect(table('mains').parse(m1)).toEqual(m1)
  })

  it('reads an M2a project with today\'s defaults', () => {
    const m2a = {
      id: 'project-1', title: 'P', workspaceId: 'ws', folder: '/code/p', mainSessionId: 'session-main',
      pinned: true, instructions: '用中文', createdAt: '', updatedAt: '',
    }
    expect(table('projects').parse(m2a)).toEqual({
      ...m2a, icon: 'folder', goal: '', archived: false, notify: 'attention', mainModel: null, threadModel: null,
    })
  })

  it('reads an M2c proposal with today\'s defaults', () => {
    const m2c = { id: 'proposal-1', mainSessionId: 'm', title: 't', task: 'x', state: 'queued', threadId: null, createdAt: '', expiresAt: '' }
    expect(table('proposals').parse(m2c)).toEqual({ ...m2c, worktree: false })
  })
})

describe('reloading the plugin in place', () => {
  // DSH's own facility over a backend that keeps nothing: it allows one open handle per domain.
  const facility = () => new DomainFacility({
    storage: { backend: { get: () => ({ kv: { open: async () => ({ loadAll: async () => ({ tables: {}, global: null }), close: async () => {} }) } }) } },
  } as never, { backend: 'memory', routes: {} })

  it('opens the store again after the previous load closed it', async () => {
    const storageDomain = facility()
    const first = await openStore(storageDomain)
    await first.close()
    await expect(openStore(storageDomain)).resolves.toBeDefined()
  })

  it('takes over a handle an earlier version left open', async () => {
    const storageDomain = facility()
    const stale = await storageDomain.open(domain)
    await expect(storageDomain.open(domain)).rejects.toThrow('already open')
    await expect(openStore(storageDomain)).resolves.toBeDefined()
    await expect(stale.table('threads').put('session-1', {} as never)).rejects.toThrow()
  })
})
