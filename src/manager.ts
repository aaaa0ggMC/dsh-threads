import type { Config } from './config.ts'
import type { MainAgent } from './delivery.ts'
import { flushNotes } from './delivery.ts'
import { msg } from './messages.ts'
import { composeNote, currentReport, normalizeReport, noticeSummary, plainLine, truncate } from './report.ts'
import type { NoticeMeta, ThreadCardInfo } from './source.ts'
import type { ThreadStore } from './store.ts'
import type { Initiation, ModelChoice, PendingNote, ProposalRecord, ThreadRecord, ThreadReport, ThreadWorktree } from './types.ts'
import { type RemoveResult, worktreeFolder } from './worktree.ts'

/** Longest report summary carried on a transcript card. */
const CARD_SUMMARY_MAX = 160
/** Changed files a transcript card lists (the thread pane has the rest). */
const CARD_FILES_MAX = 4
/** The user's latest messages in one thread round kept for its report. */
const USER_MESSAGES_MAX = 5

function cardOf(thread: Pick<ThreadRecord, 'id' | 'n' | 'title' | 'worktree'>): ThreadCardInfo {
  const card: ThreadCardInfo = { threadId: thread.id, n: thread.n, title: thread.title }
  return thread.worktree === null ? card : { ...card, branch: thread.worktree.branch }
}

/** A live session agent, reduced to what thread orchestration needs. */
export interface ThreadAgent extends MainAgent {
  readonly id: string
  /** Current session log offset. */
  readonly seq: number
  /**
   * Hand the message to the thread's current work: a running thread reads it at its next step
   * boundary (no waiting for the turn to end); an idle thread starts a turn. `meta` lets the
   * transcript render thread cards.
   */
  steer(text: string, summary: string, meta?: NoticeMeta): void
}

/** DSH services behind the manager (src/host.ts adapts the real ones). */
export interface ThreadHost {
  /** Create an ordinary session in the main conversation's workspace and return its agent. */
  createSession(mainSessionId: string, sessionId: string): Promise<ThreadAgent>
  /** The live agent for a session, resuming it when needed. */
  resolve(sessionId: string): Promise<ThreadAgent | undefined>
  rename(sessionId: string, title: string): void
  /**
   * The main conversation's current permission preset, resuming it when needed; undefined when
   * DSH has no presets. Throws when the main conversation cannot be reached.
   */
  permissionOf(mainSessionId: string): Promise<string | undefined>
  /** Give the thread this permission preset (throws when it cannot). */
  setPermission(threadId: string, preset: string): void
  /** Text of the thread's last assistant reply since `fromSeq`. */
  roundOutput(threadId: string, fromSeq: number): string | undefined
  /** Whether the thread's latest turn since `fromSeq` ended because the user stopped it (DSH's stop button, or ours). */
  stoppedByUser(threadId: string, fromSeq: number): boolean
  /** Stop the thread's running turn, dropping input queued behind it; false when nothing was running. */
  cancel(threadId: string): Promise<boolean>
  /** Archive a session in DSH (it leaves the sidebar and cannot run); throws when it is busy. */
  archiveSession(sessionId: string): Promise<void>
  unarchiveSession(sessionId: string): Promise<void>
  /** A new worktree branched from the main conversation's folder (throws WorktreeError when it cannot). */
  createWorktree(mainSessionId: string, name: string): Promise<ThreadWorktree>
  /** Make `path` the thread's working directory. */
  enterDirectory(threadId: string, path: string): Promise<void>
  removeWorktree(worktree: ThreadWorktree): Promise<RemoveResult>
  /** Give a session a model without changing DSH's default for new sessions. */
  applyModel(sessionId: string, choice: ModelChoice): Promise<void>
}

export interface OpenInput {
  title: string
  task: string
  initiation: Initiation
  /** Give the thread its own git worktree and branch (for threads that change files). */
  worktree?: boolean
}

export interface ManagerDeps {
  store: ThreadStore
  host: ThreadHost
  config: Config
  now: () => string
  newSessionId: () => string
  newProposalId: () => string
  warn: (message: string) => void
}

/** A refusal the model should read and act on (not a bug). */
export class ThreadError extends Error {}

/** How thread_reply puts its message into the thread: into the current work, or as its next turn. */
export type ReplyMode = 'steer' | 'followup'

/** How thread_mark changes a thread: mark it solved, undo that, or (un)archive it. */
export type MarkAction = 'resolve' | 'reopen' | 'archive' | 'unarchive'

const TITLE_MAX = 30

export function titleFrom(task: string): string {
  return truncate(task.trim().split('\n', 1)[0]?.trim() ?? '', TITLE_MAX)
}

/** First message of a dispatched round: the brief, framed so the thread knows where it came from. */
export function briefText(thread: Pick<ThreadRecord, 'n' | 'title'>, task: string): string {
  return [msg().briefHeader(thread.n, thread.title), '', task.trim(), '', msg().briefFooter].join('\n')
}

/** Sent once when a task round ended without thread_report. */
export function reminderText(thread: Pick<ThreadRecord, 'n' | 'title'>): string {
  return [msg().reminderHeader(thread.n, thread.title), '', msg().reminderBody].join('\n')
}

/** A follow-up instruction from the main conversation (thread_reply). */
export function replyText(thread: Pick<ThreadRecord, 'n' | 'title'>, message: string): string {
  return [msg().replyHeader(thread.n, thread.title), '', message.trim(), '', msg().replyFooter].join('\n')
}

export class ThreadManager {
  /** Sessions being created right now; `agent/created` fires before the record says `running`. */
  private readonly creating = new Set<string>()
  /** Per-main-conversation serialization of delivery. */
  private readonly chains = new Map<string, Promise<void>>()
  /** Per-main-conversation serialization of opening threads (running limit, numbers, proposal queue). */
  private readonly openings = new Map<string, Promise<unknown>>()
  /** Threads whose round ended but whose note is not queued yet; delivery counts them as running. */
  private readonly settling = new Set<string>()
  /** Messages each non-thread session has received since the plugin loaded; the lead reminder follows it. */
  private readonly inboxCounts = new Map<string, number>()

  constructor(private readonly deps: ManagerDeps) {}

  isThread(sessionId: string): boolean {
    return this.creating.has(sessionId) || this.deps.store.thread(sessionId) !== undefined
  }

  /**
   * A thread whose main conversation is still a project's. After the project is deleted its
   * threads are ordinary conversations again: shown in DSH's list, without thread tools.
   */
  isProjectThread(sessionId: string): boolean {
    const thread = this.deps.store.thread(sessionId)
    return thread === undefined ? this.creating.has(sessionId) : this.isDispatcher(thread.mainSessionId)
  }

  /** The live worktree a thread works in, if any (for its system prompt). */
  worktreeOf(sessionId: string): ThreadWorktree | null {
    const worktree = this.deps.store.thread(sessionId)?.worktree ?? null
    return worktree === null || worktree.removed ? null : worktree
  }

  /**
   * How many messages (the user's, or our reports) a main conversation has received since the
   * plugin loaded. Its lead reminder carries this number, so DSH, which adds a runtime-context
   * snapshot only when the text changes, puts a fresh reminder after each new message.
   */
  inboxCount(sessionId: string): number {
    return this.inboxCounts.get(sessionId) ?? 0
  }

  /** Only a project's main conversation dispatches threads (as in Claude). */
  isDispatcher(sessionId: string): boolean {
    return this.deps.store.projectOfMain(sessionId) !== undefined
  }

  runningCount(mainSessionId: string): number {
    return this.deps.store.threadsOf(mainSessionId).filter((t) => t.status === 'starting' || t.status === 'running').length
  }

  /** Open a thread. Opens for one main conversation run one at a time, so parallel calls cannot overshoot the limit or share a number. */
  open(mainSessionId: string, input: OpenInput): Promise<ThreadRecord> {
    return this.opening(mainSessionId, () => this.openNow(mainSessionId, input))
  }

  private opening<T>(mainSessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.openings.get(mainSessionId) ?? Promise.resolve()
    const next = previous.then(task, task)
    this.openings.set(mainSessionId, next.catch(() => undefined))
    return next
  }

  private async openNow(mainSessionId: string, input: OpenInput): Promise<ThreadRecord> {
    const { store, host, config, now } = this.deps
    if (this.isThread(mainSessionId)) throw new ThreadError(msg().noNestedThreads)
    if (!this.isDispatcher(mainSessionId)) throw new ThreadError(msg().notAProject)
    const task = input.task.trim()
    if (task.length === 0) throw new ThreadError(msg().emptyTask)
    const running = this.runningCount(mainSessionId)
    if (running >= config.maxRunning) {
      throw new ThreadError(msg().runningLimit(running, config.maxRunning))
    }

    const n = Math.max(0, ...store.threadsOf(mainSessionId).map((t) => t.n)) + 1
    const title = truncate(input.title.trim(), TITLE_MAX) || titleFrom(task)
    const id = this.deps.newSessionId()
    // Read before anything is created: a thread must never run under DSH's default preset
    // because its main conversation was not loaded (the default may be looser).
    let preset: string | undefined
    if (config.inheritPermissionPreset) {
      try {
        preset = await host.permissionOf(mainSessionId)
      } catch (error) {
        throw new ThreadError(msg().noPreset(error instanceof Error ? error.message : String(error)))
      }
      if (preset === undefined) this.deps.warn('dsh-threads: DSH has no permission presets; the thread follows its default')
    }
    // Before the session exists, so a folder that is not a git repository costs nothing.
    let worktree: ThreadWorktree | null = null
    if (input.worktree === true) {
      try {
        worktree = await host.createWorktree(mainSessionId, `${n}-${id.replace(/^session-/, '').slice(0, 6)}`)
      } catch (error) {
        throw new ThreadError(msg().noWorktree(error instanceof Error ? error.message : String(error)))
      }
    }
    const createdAt = now()
    let record: ThreadRecord = {
      id, mainSessionId, n, title, task,
      initiation: input.initiation,
      status: 'starting',
      resolved: false,
      archived: false,
      round: null, userMessages: [], roundStartSeq: null, roundStartedAt: null,
      lastReport: null, reportSentAt: null, error: null,
      worktree,
      reminder: null,
      stopped: false,
      lastRound: null, late: false,
      createdAt, updatedAt: createdAt,
    }
    this.creating.add(id)
    try {
      await store.putThread(record)
      const agent = await host.createSession(mainSessionId, id)
      if (worktree !== null) await host.enterDirectory(id, worktreeFolder(worktree))
      // The project's thread model; a model DSH cannot use leaves the thread on the default.
      const threadModel = store.projectOfMain(mainSessionId)?.threadModel ?? null
      if (threadModel !== null) {
        await host.applyModel(id, threadModel).catch((error: unknown) => {
          this.deps.warn(`dsh-threads: thread ${id} keeps the default model: ${String(error)}`)
        })
      }
      try {
        host.rename(id, `#${n} ${title}`)
      } catch (error) {
        this.deps.warn(`dsh-threads: could not rename thread ${id}: ${String(error)}`)
      }
      if (preset !== undefined) host.setPermission(id, preset)
      record = await this.dispatch(record, agent, briefText(record, task))
      return record
    } catch (error) {
      record = { ...record, status: 'failed', error: String(error), updatedAt: now() }
      await store.putThread(record)
      throw error
    } finally {
      this.creating.delete(id)
    }
  }

  /** Start a round the main conversation asked for. The record is saved before the message is sent. */
  private async dispatch(record: ThreadRecord, agent: ThreadAgent, text: string): Promise<ThreadRecord> {
    const at = this.deps.now()
    const next: ThreadRecord = { ...record, status: 'running', round: 'dispatch', userMessages: [], roundStartSeq: agent.seq, roundStartedAt: at, reminder: null, stopped: false, late: false, updatedAt: at }
    await this.deps.store.putThread(next)
    agent.followup(text, noticeSummary(next, msg().noticeBrief), { role: 'brief', threads: [cardOf(next)], wake: true })
    return next
  }

  /**
   * thread_reply: send a thread more instructions. `steer` (the default) hands the message to
   * the thread's current work, so a running thread reads it at its next step instead of after
   * the turn; `followup` queues it as the thread's own next turn. An idle thread starts a
   * dispatched round either way, and its result is reported with wake-up rules even if the
   * user started the current round.
   */
  async reply(mainSessionId: string, n: number, message: string, mode: ReplyMode = 'steer'): Promise<ThreadRecord> {
    const text = message.trim()
    if (text.length === 0) throw new ThreadError(msg().emptyMessage)
    const thread = this.deps.store.threadsOf(mainSessionId).find((t) => t.n === n)
    if (thread === undefined) throw new ThreadError(msg().noThreadNumber(n))
    if (thread.status === 'failed' || thread.status === 'starting') {
      throw new ThreadError(msg().notReady(n, thread.status))
    }
    if (thread.archived) throw new ThreadError(msg().archivedNoReply(n))
    const agent = await this.deps.host.resolve(thread.id)
    if (agent === undefined) throw new ThreadError(msg().unreachable(n))
    const at = this.deps.now()
    // Read again: the thread may have reported (and opened a round of its own) while we waited.
    const current = this.deps.store.thread(thread.id) ?? thread
    const next: ThreadRecord = current.round === null
      ? { ...current, status: 'running', round: 'dispatch', userMessages: [], roundStartSeq: agent.seq, roundStartedAt: at, resolved: false, reminder: null, stopped: false, late: false, updatedAt: at }
      // A round the thread's own late report opened becomes an ordinary task round.
      : { ...current, round: 'dispatch', resolved: false, reminder: null, stopped: false, late: false, updatedAt: at }
    await this.deps.store.putThread(next)
    const notice = replyText(next, text)
    const summary = noticeSummary(next, msg().noticeReply)
    const meta: NoticeMeta = { role: 'reply', threads: [cardOf(next)], wake: true }
    if (mode === 'followup') agent.followup(notice, summary, meta)
    else agent.steer(notice, summary, meta)
    return next
  }

  /**
   * After DSH restarts: threads left `starting` failed; `running` threads whose agent is now
   * idle are settled (their report or last reply goes to the main conversation); notes still
   * waiting for a main conversation are delivered.
   */
  async recover(): Promise<void> {
    const { store, host, now } = this.deps
    for (const thread of store.threads()) {
      if (thread.status === 'starting') {
        await store.putThread({ ...thread, status: 'failed', error: msg().failedAtRestart, updatedAt: now() })
        continue
      }
      if (thread.status !== 'running') continue
      const agent = await host.resolve(thread.id)
      if (agent === undefined) {
        await store.putThread({ ...thread, status: 'failed', round: null, error: msg().unreachableAfterRestart, updatedAt: now() })
        continue
      }
      if (agent.status === 'idle') await this.onIdle(thread.id)
    }
    for (const main of store.mains()) {
      if (main.pendingNotes.length > 0) await this.flush(main.id)
    }
  }

  /**
   * A message entered a session's inbox. A user message in an idle thread starts a user-driven
   * round; in any round, the user's words are kept for the report. Anything else that wakes an
   * idle thread (DSH's own notices, such as a background job finishing) starts no round here: a
   * stopped thread stays stopped through it, and any other thread opens a round only if it
   * reports in that turn (recordReport).
   */
  async onInbox(sessionId: string, sourceKind: string, seq: number, text = ''): Promise<void> {
    if (!this.isThread(sessionId)) this.inboxCounts.set(sessionId, this.inboxCount(sessionId) + 1)
    if (sourceKind !== 'user') return
    const thread = this.deps.store.thread(sessionId)
    if (thread === undefined) {
      await this.onMainUserMessage(sessionId)
      return
    }
    // A deleted project's thread is an ordinary conversation now: nothing to report.
    if (!this.isDispatcher(thread.mainSessionId)) return
    const said = text.trim().length === 0 ? [] : [text.trim()]
    const at = this.deps.now()
    if (thread.round !== null) {
      if (said.length > 0) await this.deps.store.putThread({ ...thread, userMessages: [...thread.userMessages, ...said].slice(-USER_MESSAGES_MAX), updatedAt: at })
      return
    }
    await this.deps.store.putThread({ ...thread, status: 'running', round: 'user', userMessages: said, roundStartSeq: seq, roundStartedAt: at, resolved: false, reminder: null, stopped: false, late: false, updatedAt: at })
  }

  /** The user spoke in a main conversation: automatic wake-ups may start again. */
  private onMainUserMessage(mainSessionId: string): Promise<void> {
    // In the delivery chain: a flush in flight writes back the record it read, which would
    // otherwise undo this reset.
    return this.serial(mainSessionId, async () => {
      const main = this.deps.store.main(mainSessionId)
      if (main.autoWakeStreak === 0) return
      await this.deps.store.putMain({ ...main, autoWakeStreak: 0 })
    })
  }

  /** A session went idle: settle a thread's round, or deliver notes held for a main conversation. */
  async onIdle(sessionId: string): Promise<void> {
    const thread = this.deps.store.thread(sessionId)
    if (thread === undefined) {
      if (this.deps.store.main(sessionId).pendingNotes.length > 0) await this.flush(sessionId)
      return
    }
    if (thread.round === null) {
      if (thread.status === 'running') await this.deps.store.putThread({ ...thread, status: 'idle', updatedAt: this.deps.now() })
      return
    }
    // The user stopped the round (DSH's stop button in the thread, or ours): never remind it back to work.
    const stopped = this.deps.host.stoppedByUser(thread.id, thread.roundStartSeq ?? 0)
    // A task round that ended without thread_report: ask once, keep the round open.
    if (!stopped && thread.round === 'dispatch' && thread.reminder === null && this.deps.config.reportReminder
      && currentReport(thread) === null && await this.remind(thread)) return
    // Until the note is queued, delivery must not mistake this thread for finished-and-reported:
    // another thread settling at the same moment would otherwise wake the main conversation alone.
    this.settling.add(thread.id)
    try {
      await this.settle(thread, stopped)
    } finally {
      this.settling.delete(thread.id)
    }
    await this.flush(thread.mainSessionId)
  }

  /** Send the one reminder; the thread stays `running` and the round settles on its next idle. */
  private async remind(thread: ThreadRecord): Promise<boolean> {
    const agent = await this.deps.host.resolve(thread.id)
    if (agent === undefined) return false
    // Saved now: after the reminder, the last reply is the answer to the reminder, not the work.
    const fallback = this.deps.host.roundOutput(thread.id, thread.roundStartSeq ?? 0) ?? null
    await this.deps.store.putThread({ ...thread, reminder: { fallback }, updatedAt: this.deps.now() })
    agent.followup(reminderText(thread), noticeSummary(thread, msg().noticeReminder), { role: 'reminder', threads: [cardOf(thread)], wake: true })
    return true
  }

  /**
   * Turn the finished round into a note for the main conversation. A round the user drove, or
   * stopped, is quiet: the user already knows, and the main conversation hears at its next turn.
   */
  private async settle(thread: ThreadRecord, stopped = false): Promise<void> {
    const report = currentReport(thread)
    await this.deps.store.putThread({ ...thread, status: 'idle', round: null, userMessages: [], reminder: null, stopped, lastRound: thread.round, late: false, updatedAt: this.deps.now() })
    // A report already handed over when it was recorded is not sent again at the round's end —
    // unless the round then ended in a way the main conversation has not been told about yet: the
    // user stopped it (that is the user's call, and it decides what may be reopened), or the
    // model call failed. Both override the de-duplication.
    if (report !== null && thread.reportSentAt === report.at && !stopped) {
      await this.drainQueue(thread.mainSessionId)
      return
    }
    const fallback = report !== null ? undefined
      : thread.reminder !== null ? thread.reminder.fallback ?? undefined
      : this.deps.host.roundOutput(thread.id, thread.roundStartSeq ?? 0)
    await this.queueNote(thread, this.noteOf(thread, report, fallback, stopped, thread.late))
  }

  /**
   * thread_propose: suggestions the model came up with itself. They wait in the proposals
   * card until the user starts or dismisses them (Claude's `own_initiative`).
   */
  async propose(mainSessionId: string, items: readonly { title: string; task: string; worktree?: boolean }[]): Promise<ProposalRecord[]> {
    const { store, config, now } = this.deps
    if (!this.isDispatcher(mainSessionId)) throw new ThreadError(msg().notAProject)
    const cleaned = items
      .map((item) => ({ task: item.task.trim(), title: truncate(item.title.trim(), TITLE_MAX), worktree: item.worktree === true }))
      .filter((item) => item.task.length > 0)
    if (cleaned.length === 0) throw new ThreadError(msg().noProposals)
    if (cleaned.length > config.maxProposalsPerTurn) {
      throw new ThreadError(msg().proposalLimit(config.maxProposalsPerTurn))
    }
    const createdAt = now()
    const expiresAt = new Date(Date.parse(createdAt) + config.proposalTtlDays * 86_400_000).toISOString()
    const records = cleaned.map((item): ProposalRecord => ({
      id: this.deps.newProposalId(),
      mainSessionId,
      title: item.title || titleFrom(item.task),
      task: item.task,
      state: 'pending',
      worktree: item.worktree,
      threadId: null,
      createdAt,
      expiresAt,
    }))
    for (const record of records) await store.putProposal(record)
    return records
  }

  /** Proposals still waiting for the user (pending) or for a free slot (queued). Expired ones are dropped. */
  proposals(mainSessionId: string): ProposalRecord[] {
    const now = this.deps.now()
    return this.deps.store.proposalsOf(mainSessionId)
      .filter((p) => (p.state === 'pending' && p.expiresAt > now) || p.state === 'queued')
  }

  /** The user picked proposals: open as many as the running limit allows, queue the rest. */
  async startProposals(mainSessionId: string, ids: readonly string[]): Promise<ProposalRecord[]> {
    const { store } = this.deps
    for (const id of ids) {
      const proposal = store.proposal(id)
      if (proposal === undefined || proposal.mainSessionId !== mainSessionId || proposal.state !== 'pending') continue
      await store.putProposal({ ...proposal, state: 'queued' })
    }
    await this.drainQueue(mainSessionId)
    return ids.flatMap((id) => {
      const proposal = store.proposal(id)
      return proposal === undefined ? [] : [proposal]
    })
  }

  async dismissProposals(mainSessionId: string, ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const proposal = this.deps.store.proposal(id)
      if (proposal === undefined || proposal.mainSessionId !== mainSessionId) continue
      if (proposal.state === 'pending' || proposal.state === 'queued') await this.deps.store.putProposal({ ...proposal, state: 'dismissed' })
    }
  }

  /** Start queued proposals, oldest first, while there is room under `maxRunning`. */
  private drainQueue(mainSessionId: string): Promise<void> {
    return this.opening(mainSessionId, async () => {
      for (const proposal of this.deps.store.proposalsOf(mainSessionId)) {
        if (proposal.state !== 'queued') continue
        if (this.runningCount(mainSessionId) >= this.deps.config.maxRunning) return
        try {
          const thread = await this.openNow(mainSessionId, { title: proposal.title, task: proposal.task, initiation: 'proposal', worktree: proposal.worktree })
          await this.deps.store.putProposal({ ...proposal, state: 'started', threadId: thread.id })
        } catch (error) {
          this.deps.warn(`dsh-threads: could not start proposal ${proposal.id}: ${String(error)}`)
          await this.deps.store.putProposal({ ...proposal, state: 'dismissed' })
        }
      }
    })
  }

  /** "标记已解决 / 重新打开" from the thread pane. A resolved thread's composer is locked in the UI. */
  async setResolved(threadId: string, resolved: boolean): Promise<ThreadRecord> {
    const thread = this.deps.store.thread(threadId)
    if (thread === undefined) throw new ThreadError(msg().threadNotFound)
    if (thread.resolved === resolved) return thread
    const next = { ...thread, resolved, updatedAt: this.deps.now() }
    await this.deps.store.putThread(next)
    return next
  }

  /**
   * Stop a running thread (the pane's stop, `/thread stop`). Its round then settles as stopped,
   * quietly and without a reminder (onIdle reads the turn's end). A turn outside any round (DSH
   * woke the thread itself, say for a finished background job) is stopped the same way.
   */
  async stop(threadId: string): Promise<ThreadRecord> {
    const thread = this.deps.store.thread(threadId)
    if (thread === undefined) throw new ThreadError(msg().threadNotFound)
    if (thread.status === 'starting') throw new ThreadError(msg().stillStarting(thread.n))
    if (thread.status === 'failed' || !await this.deps.host.cancel(threadId)) throw new ThreadError(msg().notRunning(thread.n))
    return thread
  }

  /**
   * Whether the user stopped this thread and nobody has set it going again. Background jobs it
   * started keep running (DSH's stop ends the turn, not the jobs), and DSH wakes the session
   * when one finishes; that turn must not carry on with the task or report it as done.
   */
  isStopped(sessionId: string): boolean {
    const thread = this.deps.store.thread(sessionId)
    return thread !== undefined && thread.stopped && thread.round === null
  }

  /** `/thread stop <n>` from a main conversation. */
  stopNumber(mainSessionId: string, n: number): Promise<ThreadRecord> {
    const thread = this.deps.store.threadsOf(mainSessionId).find((t) => t.n === n)
    if (thread === undefined) return Promise.reject(new ThreadError(msg().noThreadNumber(n)))
    return this.stop(thread.id)
  }

  /**
   * thread_mark from a main conversation: mark a thread solved or archived by its number, the way
   * `/thread stop <n>` finds it. Both are idempotent, and archiving is refused while it runs.
   */
  markNumber(mainSessionId: string, n: number, action: MarkAction): Promise<ThreadRecord> {
    const thread = this.deps.store.threadsOf(mainSessionId).find((t) => t.n === n)
    if (thread === undefined) return Promise.reject(new ThreadError(msg().noThreadNumber(n)))
    return action === 'archive' || action === 'unarchive'
      ? this.setArchived(thread.id, action === 'archive')
      : this.setResolved(thread.id, action === 'resolve')
  }

  /**
   * Archive one thread, as in Claude: its session is archived in DSH (out of the way, nothing
   * deleted) and it leaves the threads list. Refused while it runs; stop it first.
   */
  async setArchived(threadId: string, archived: boolean): Promise<ThreadRecord> {
    const thread = this.deps.store.thread(threadId)
    if (thread === undefined) throw new ThreadError(msg().threadNotFound)
    if (thread.archived === archived) return thread
    if (archived) {
      if (thread.status === 'running' || thread.status === 'starting') throw new ThreadError(msg().stopBeforeArchive(thread.n))
      await this.deps.host.archiveSession(threadId)
    } else {
      await this.deps.host.unarchiveSession(threadId)
    }
    const next = { ...thread, archived, updatedAt: this.deps.now() }
    await this.deps.store.putThread(next)
    return next
  }

  /**
   * thread_report. In a round, the report is kept until the round settles. Outside one (DSH
   * started this turn on its own, usually because a background job the thread left running
   * finished), the report opens a round of its own, so that it settles into a note like any
   * other: what the cards and thread_status show never differs from what the main conversation
   * was told. That round is delivered the way the thread's last round was (`lastRound`). A turn
   * DSH started in which the thread does not report stays outside any round: nothing new to tell.
   */
  async recordReport(threadId: string, input: Omit<ThreadReport, 'at'>): Promise<ThreadReport> {
    const { store, host, config, now } = this.deps
    if (store.thread(threadId) === undefined) throw new ThreadError(msg().reportFromThreadsOnly)
    // Stopping is the user's call: a turn DSH started on its own afterwards cannot turn the
    // thread into "done" behind their back.
    if (this.isStopped(threadId)) throw new ThreadError(msg().reportAfterStop)
    // The offset is read first: the record is then read and written with nothing in between,
    // so a follow-up from the main conversation arriving at this moment is not overwritten.
    const seq = store.thread(threadId)?.round === null ? (await host.resolve(threadId))?.seq : undefined
    const thread = store.thread(threadId)
    if (thread === undefined) throw new ThreadError(msg().reportFromThreadsOnly)
    const report = normalizeReport(input, config.summaryMaxChars, now())
    // A deleted project's thread is an ordinary conversation: there is nobody to deliver to.
    const late = thread.round === null && thread.status !== 'failed' && thread.status !== 'starting' && !thread.stopped && this.isDispatcher(thread.mainSessionId)
    const next: ThreadRecord = late
      ? {
          ...thread,
          status: 'running', round: thread.lastRound ?? 'dispatch', late: true, userMessages: [], reminder: null,
          roundStartSeq: seq ?? thread.roundStartSeq, roundStartedAt: report.at,
          lastReport: report, updatedAt: report.at,
        }
      : { ...thread, lastReport: report, updatedAt: report.at }
    await store.putThread(next)
    // Hand it over now rather than at the round's end: a thread that leaves TODOs unticked often
    // keeps working (or keeps a turn open), so waiting for the end can keep the result from the
    // main conversation for a long time. The round stays open; `settle` skips this report. A
    // report that arrived outside any round just opened one of its own (above), so it is
    // delivered when that round settles, the way the thread's last round was delivered.
    if (next.round !== null && !late) await this.deliverReport(next)
    return report
  }

  /** Send the round's recorded report now, without closing the round. */
  private async deliverReport(thread: ThreadRecord): Promise<void> {
    const report = currentReport(thread)
    if (report === null || thread.reportSentAt === report.at) return
    const next: ThreadRecord = { ...thread, reportSentAt: report.at }
    await this.deps.store.putThread(next)
    await this.queueNote(next, this.noteOf(next, report, undefined, false, false))
    await this.flush(thread.mainSessionId)
  }

  /** The note a round's outcome becomes; `settle` and `deliverReport` share it. */
  private noteOf(thread: ThreadRecord, report: ThreadReport | null, fallback: string | undefined, stopped: boolean, late: boolean): PendingNote {
    return {
      threadId: thread.id,
      text: composeNote(thread, report, fallback, this.deps.config.noteMaxChars, { stopped, late }),
      quiet: thread.round === 'user' || stopped,
      card: {
        ...cardOf(thread),
        status: stopped ? 'stopped' : report?.status ?? 'no-report',
        summary: truncate(plainLine(report?.summary ?? fallback ?? ''), CARD_SUMMARY_MAX),
        ...(report?.decisions[0] === undefined ? {} : { decision: truncate(report.decisions[0], CARD_SUMMARY_MAX) }),
        ...(report === null || report.changedFiles.length === 0 ? {} : { files: report.changedFiles.slice(0, CARD_FILES_MAX) }),
      },
    }
  }

  /** Put one note into its main conversation's queue, after starting queued proposals. */
  private async queueNote(thread: ThreadRecord, note: PendingNote): Promise<void> {
    // Start queued proposals first: the note then waits for them, and the main conversation
    // hears from the whole batch once instead of once per thread.
    await this.drainQueue(thread.mainSessionId)
    await this.serial(thread.mainSessionId, async () => {
      const main = this.deps.store.main(thread.mainSessionId)
      await this.deps.store.putMain({ ...main, pendingNotes: [...main.pendingNotes, note] })
    })
  }

  /** Deliver held notes if the rules allow it now. */
  flush(mainSessionId: string): Promise<void> {
    return this.serial(mainSessionId, async () => {
      const main = this.deps.store.main(mainSessionId)
      if (main.pendingNotes.length === 0) return
      const agent = await this.deps.host.resolve(mainSessionId)
      if (agent === undefined) return
      const settling = this.deps.store.threadsOf(mainSessionId).filter((t) => this.settling.has(t.id)).length
      const { record } = flushNotes(main, agent, this.runningCount(mainSessionId) + settling, this.deps.config.maxAutoWakes)
      await this.deps.store.putMain(record)
    })
  }

  private serial(key: string, task: () => Promise<void>): Promise<void> {
    const previous = this.chains.get(key) ?? Promise.resolve()
    const next = previous.then(task, task)
    const settled = next.catch((error: unknown) => {
      this.deps.warn(`dsh-threads: delivery to ${key} failed: ${String(error)}`)
    })
    this.chains.set(key, settled)
    return next
  }

  /** Worktrees `/thread cleanup` would remove: threads of this main conversation that are not running. */
  cleanupCandidates(mainSessionId: string): ThreadRecord[] {
    return this.deps.store.threadsOf(mainSessionId)
      .filter((t) => t.worktree !== null && !t.worktree.removed && t.status !== 'running' && t.status !== 'starting')
  }

  /** `/thread cleanup confirm`: remove those worktrees (never forced) and say what happened to each. */
  async cleanupWorktrees(mainSessionId: string): Promise<string[]> {
    const lines: string[] = []
    for (const thread of this.cleanupCandidates(mainSessionId)) {
      const worktree = thread.worktree as ThreadWorktree
      let result: RemoveResult
      try {
        result = await this.deps.host.removeWorktree(worktree)
      } catch (error) {
        lines.push(msg().cleanupFailed(thread.n, error instanceof Error ? error.message : String(error)))
        continue
      }
      if (result.outcome === 'dirty') {
        lines.push(msg().cleanupDirty(thread.n, worktree.path))
        continue
      }
      await this.deps.store.putThread({ ...thread, worktree: { ...worktree, removed: true }, updatedAt: this.deps.now() })
      lines.push(msg().cleanupRemoved(thread.n, worktree.branch, result.branchKept))
    }
    return lines
  }

  /** Text for thread_status: every thread of this main conversation, or one thread in detail. */
  describe(mainSessionId: string, n?: number): string {
    const m = msg()
    const marks = (thread: ThreadRecord) => `${this.isStopped(thread.id) ? m.stoppedMark : ''}${thread.resolved ? m.resolvedMark : ''}${thread.archived ? m.archivedMark : ''}`
    const threads = this.deps.store.threadsOf(mainSessionId)
    if (n !== undefined) {
      const thread = threads.find((t) => t.n === n)
      if (thread === undefined) throw new ThreadError(msg().noSuchThread(n))
      const report = thread.lastReport
      return [
        m.describeHead(thread.n, thread.title, thread.status, marks(thread), thread.id),
        thread.worktree === null ? '' : m.describeWorktree(thread.worktree.path, thread.worktree.branch, thread.worktree.removed),
        m.describeTask(truncate(thread.task, 600)),
        report === null
          ? m.describeNoReport
          : [
              m.describeReport(report.at, report.status, report.summary),
              report.changedFiles.length > 0 ? m.changedFiles(report.changedFiles) : '',
              report.decisions.length > 0 ? m.decisionsLine(report.decisions) : '',
            ].filter((line) => line.length > 0).join('\n'),
        thread.error === null ? '' : m.describeError(thread.error),
      ].filter((line) => line.length > 0).join('\n')
    }
    if (threads.length === 0) return m.noThreads
    return threads.map((t) => {
      const latest = t.lastReport === null ? m.listNoReport : m.listLatest(t.lastReport.status, truncate(t.lastReport.summary, 80))
      return m.listLine(t.n, t.title, t.status, marks(t), latest)
    }).join('\n')
  }
}
