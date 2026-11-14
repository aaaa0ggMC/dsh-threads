// ThreadStore on DSH's storage-domain service (`<DSH_HOME>/storages/dsh_threads.json`).
// Fields added after M1 carry defaults so records written by earlier versions still read.
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { byCreated, byNumber, emptyMain, type ThreadStore } from './store.ts'
import type { MainRecord, ProjectRecord, ProposalRecord, ThreadRecord } from './types.ts'

const reportSchema = z.object({
  status: z.enum(['done', 'blocked', 'needs_decision', 'failed']),
  summary: z.string(),
  changedFiles: z.array(z.string()),
  decisions: z.array(z.string()),
  at: z.string(),
})

const threadSchema = z.object({
  id: z.string(),
  mainSessionId: z.string(),
  n: z.number().int().positive(),
  title: z.string(),
  task: z.string(),
  initiation: z.enum(['user_asked', 'offer', 'proposal']),
  status: z.enum(['starting', 'running', 'idle', 'failed']),
  resolved: z.boolean().default(false),
  archived: z.boolean().default(false),
  round: z.enum(['dispatch', 'user']).nullable(),
  userMessages: z.array(z.string()).default([]),
  roundStartSeq: z.number().int().nonnegative().nullable(),
  roundStartedAt: z.string().nullable(),
  lastReport: reportSchema.nullable(),
  reportSentAt: z.string().nullable().default(null),
  error: z.string().nullable(),
  worktree: z.object({
    path: z.string(),
    subdir: z.string().default(''),
    branch: z.string(),
    baseCommit: z.string(),
    repositoryRoot: z.string(),
    removed: z.boolean().default(false),
  }).nullable().default(null),
  reminder: z.object({ fallback: z.string().nullable() }).nullable().default(null),
  stopped: z.boolean().default(false),
  lastRound: z.enum(['dispatch', 'user']).nullable().default(null),
  late: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const cardSchema = z.object({
  threadId: z.string(),
  n: z.number().int().positive(),
  title: z.string(),
  status: z.string().optional(),
  summary: z.string().optional(),
  branch: z.string().optional(),
  decision: z.string().optional(),
  files: z.array(z.string()).optional(),
})

const mainSchema = z.object({
  id: z.string(),
  autoWakeStreak: z.number().int().nonnegative(),
  pendingNotes: z.array(z.object({ threadId: z.string(), text: z.string(), quiet: z.boolean(), card: cardSchema.optional() })),
})

const proposalSchema = z.object({
  id: z.string(),
  mainSessionId: z.string(),
  title: z.string(),
  task: z.string(),
  state: z.enum(['pending', 'queued', 'started', 'dismissed']),
  worktree: z.boolean().default(false),
  threadId: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
})

const modelSchema = z.object({ provider: z.string(), model: z.string(), reasoningEffort: z.string().optional() })

const projectSchema = z.object({
  id: z.string(),
  title: z.string(),
  workspaceId: z.string(),
  folder: z.string(),
  mainSessionId: z.string(),
  pinned: z.boolean(),
  instructions: z.string(),
  icon: z.string().default('folder'),
  goal: z.string().default(''),
  archived: z.boolean().default(false),
  notify: z.enum(['all', 'attention', 'waiting', 'none']).default('attention'),
  mainModel: modelSchema.nullable().default(null),
  threadModel: modelSchema.nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** Record keys are session ids (`session-<uuid>`) and project ids (`project-<uuid>`), which fit the domain's key pattern. */
export const domain = defineDomain({
  name: 'dsh_threads',
  version: 1,
  layout: 'single',
  tables: {
    threads: domainTable<string, ThreadRecord>(threadSchema),
    mains: domainTable<string, MainRecord>(mainSchema),
    projects: domainTable<string, ProjectRecord>(projectSchema),
    proposals: domainTable<string, ProposalRecord>(proposalSchema),
  },
})

/** The store and its domain handle's close; the plugin closes it when it unloads. */
export interface OpenedStore extends ThreadStore {
  close(): Promise<void>
}

/**
 * DSH allows one open handle per domain name in a process. A reload in place (HMR after a
 * rebuild, a plugin manager change, a config edit) runs `apply` again, and versions up to
 * 0.1.0-rc.8 never closed their handle, so the next `open` failed with `already-open` and the
 * whole plugin stayed down. Take over a handle an earlier load of this plugin left open.
 */
export async function openStore(storageDomain: DomainFacility): Promise<OpenedStore> {
  await storageDomain.get(domain.name)?.close()
  const opened = await storageDomain.open(domain)
  const threads = opened.table('threads')
  const mains = opened.table('mains')
  const projects = opened.table('projects')
  const proposals = opened.table('proposals')
  const values = <V>(table: { entries(): IterableIterator<[string, V]> }) => [...table.entries()].map(([, record]) => record)
  return {
    proposal: (id) => proposals.get(id),
    proposalsOf: (mainSessionId) => values(proposals).filter((p) => p.mainSessionId === mainSessionId).sort(byCreated),
    putProposal: (record) => proposals.put(record.id, record),
    thread: (id) => threads.get(id),
    threads: () => values(threads),
    threadsOf: (mainSessionId) => values(threads).filter((t) => t.mainSessionId === mainSessionId).sort(byNumber),
    putThread: (record) => threads.put(record.id, record),
    main: (id) => mains.get(id) ?? emptyMain(id),
    mains: () => values(mains),
    putMain: (record) => mains.put(record.id, record),
    project: (id) => projects.get(id),
    projects: () => values(projects),
    projectOfMain: (mainSessionId) => values(projects).find((p) => p.mainSessionId === mainSessionId),
    putProject: (record) => projects.put(record.id, record),
    removeProject: async (id) => { await projects.delete(id) },
    close: () => opened.close(),
  }
}
