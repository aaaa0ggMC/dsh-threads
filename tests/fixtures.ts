// Shared fixtures: a ThreadManager on an in-memory store and a fake DSH host.
import { Config } from '../src/config.ts'
import { type ThreadAgent, type ThreadHost, ThreadManager } from '../src/manager.ts'
import type { NoticeMeta } from '../src/source.ts'
import { memoryStore, type ThreadStore } from '../src/store.ts'
import type { ThreadWorktree } from '../src/types.ts'
import { WorktreeError } from '../src/worktree.ts'

export class FakeAgent implements ThreadAgent {
  status: 'idle' | 'running' = 'idle'
  seq = 0
  followups: string[] = []
  steers: string[] = []
  injects: string[] = []
  metas: (NoticeMeta | undefined)[] = []
  constructor(readonly id: string) {}
  followup(text: string, _summary: string, meta?: NoticeMeta) { this.followups.push(text); this.metas.push(meta) }
  steer(text: string, _summary: string, meta?: NoticeMeta) { this.steers.push(text); this.metas.push(meta) }
  inject(text: string, _summary: string, meta?: NoticeMeta) { this.injects.push(text); this.metas.push(meta) }
}

export function setup(overrides: Partial<Config> = {}, options: { slowWrites?: boolean; slowMain?: boolean } = {}) {
  const agents = new Map<string, FakeAgent>()
  const outputs = new Map<string, string>()
  const renamed: string[] = []
  const inherited: string[] = []
  let failCreate = false
  let notARepo = false
  let unreachableMain = false
  let subdir = ''
  const entered: string[] = []
  const models: string[] = []
  const removals = new Map<string, { outcome: 'removed' | 'missing' | 'dirty'; branchKept: boolean }>()
  /** Threads whose latest turn the user stopped. */
  const stopped = new Set<string>()
  const archived = new Set<string>()
  const host: ThreadHost = {
    async createSession(_main, id) {
      if (failCreate) throw new Error('create failed')
      const agent = new FakeAgent(id)
      agents.set(id, agent)
      return agent
    },
    async resolve(id) {
      if (options.slowMain === true && id === 'main') await new Promise((resolve) => setTimeout(resolve, 5))
      return agents.get(id)
    },
    rename(id, title) { renamed.push(`${id}:${title}`) },
    async permissionOf(main) {
      if (!agents.has(main) || unreachableMain) throw new Error('main unreachable')
      return 'ask'
    },
    setPermission(thread, preset) { inherited.push(`${preset}->${thread}`) },
    roundOutput(id) { return outputs.get(id) },
    stoppedByUser: (id) => stopped.has(id),
    async cancel(id) {
      const agent = agents.get(id)
      if (agent === undefined || agent.status !== 'running') return false
      agent.status = 'idle'
      stopped.add(id)
      return true
    },
    async archiveSession(id) {
      if (agents.get(id)?.status === 'running') throw new Error('workspace/session-active')
      archived.add(id)
    },
    async unarchiveSession(id) { archived.delete(id) },
    async createWorktree(_main, name) {
      if (notARepo) throw new WorktreeError('not a git repository')
      return { path: `/repo/.agents/worktrees/dsh-threads-${name}`, subdir, branch: `dsh-threads/${name}`, baseCommit: 'abc1234def', repositoryRoot: '/repo', removed: false }
    },
    async enterDirectory(id, path) { entered.push(`${id}:${path}`) },
    async removeWorktree(worktree: ThreadWorktree) { return removals.get(worktree.branch) ?? { outcome: 'removed', branchKept: false } },
    async applyModel(id, choice) {
      if (choice.model === 'missing') throw new Error('session/model-unavailable')
      models.push(`${id}:${choice.provider}/${choice.model}`)
    },
  }
  const main = new FakeAgent('main')
  agents.set('main', main)
  const memory = memoryStore()
  // A store whose thread writes land a tick later, like a real storage backend may.
  const store: ThreadStore = options.slowWrites === true
    ? { ...memory, putThread: async (record) => { await new Promise((resolve) => setTimeout(resolve, 0)); await memory.putThread(record) } }
    : memory
  let clock = 0
  let ids = 0
  const manager = new ThreadManager({
    store,
    host,
    // The report reminder has its own tests; elsewhere a round settles on its first idle.
    config: { ...Config({}), reportReminder: false, ...overrides },
    now: () => new Date(Date.UTC(2026, 9, 23, 0, 0, clock++)).toISOString(),
    newSessionId: () => `session-${++ids}`,
    newProposalId: () => `proposal-${++ids}`,
    warn: () => {},
  })
  // 'main' is a project's main conversation; only those dispatch threads.
  void store.putProject({
    id: 'project-1', title: 'P', workspaceId: 'ws', folder: '/tmp/p', mainSessionId: 'main',
    pinned: false, instructions: '', icon: 'folder', goal: '', archived: false, notify: 'attention',
    mainModel: null, threadModel: null, createdAt: '', updatedAt: '',
  })
  return { manager, store, main, agents, outputs, renamed, inherited, entered, removals, models, stopped, archived, failCreate: () => { failCreate = true }, notARepo: () => { notARepo = true }, unreachableMain: () => { unreachableMain = true }, subdir: (value: string) => { subdir = value } }
}
