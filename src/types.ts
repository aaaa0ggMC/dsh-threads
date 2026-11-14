import type { ThreadCardInfo } from './source.ts'

/** How a thread came to exist (docs/IMPLEMENTATION.md §一: Claude's `initiation`). */
export type Initiation = 'user_asked' | 'offer' | 'proposal'

export type ThreadStatus = 'starting' | 'running' | 'idle' | 'failed'

/** Status a thread declares in `thread_report`. */
export type ReportStatus = 'done' | 'blocked' | 'needs_decision' | 'failed'

export interface ThreadReport {
  status: ReportStatus
  summary: string
  changedFiles: string[]
  decisions: string[]
  /** ISO time the thread submitted it; compared with `roundStartedAt` to tell this round's report from a stale one. */
  at: string
}

/**
 * Who started the round now running in a thread: a task the main conversation sent
 * (`dispatch`, reported back with wake-up rules) or the user typing in the thread (`user`,
 * reported quietly, like Claude's notes from a turn the user drove).
 */
export type RoundOrigin = 'dispatch' | 'user'

/**
 * Why a thread's round failed, as DSH recorded it (`turn/end` with `reason.kind === 'error'`):
 * the provider's words, its provider-neutral machine code (`QUOTA`, `RATE_LIMIT`, …) and the
 * HTTP status when the provider gave one.
 */
export interface RoundFailure {
  message: string
  code: string
  status?: number
}

/** A thread's own git checkout (M3b): it works and commits on its own branch. */
export interface ThreadWorktree {
  /** The checkout's root. */
  path: string
  /** The project folder relative to the repository root, `/`-separated; '' when it is the root. */
  subdir: string
  branch: string
  /** Commit the branch started from. */
  baseCommit: string
  repositoryRoot: string
  /** Set by `/thread cleanup confirm` once the checkout is gone. */
  removed: boolean
}

export interface ThreadRecord {
  /** The thread's session id. */
  id: string
  mainSessionId: string
  /** Per-main-conversation serial number, shown as `#n`. */
  n: number
  title: string
  task: string
  initiation: Initiation
  status: ThreadStatus
  /** Marked resolved by the user; a new message to the thread reopens it. */
  resolved: boolean
  /** Archived on its own by the user (its session is archived in DSH); hidden from the threads list. */
  archived: boolean
  round: RoundOrigin | null
  /**
   * What the user typed in the thread during the current round, in their own words. The report
   * quotes it, so the main conversation knows a change was the user's request, not the thread's idea.
   */
  userMessages: string[]
  /** Session log offset when the current round started; the round's events are read from here. */
  roundStartSeq: number | null
  roundStartedAt: string | null
  lastReport: ThreadReport | null
  /**
   * `at` of the report already handed to the main conversation. A report is delivered as soon as
   * it is recorded (the round may stay open while the thread keeps working), so the round's end
   * must not send the same note twice.
   */
  reportSentAt?: string | null
  error: string | null
  /** Its own checkout when it was opened with `worktree: true`; otherwise it shares the project folder. */
  worktree: ThreadWorktree | null
  /**
   * Set when this round ended without thread_report and the thread was asked once to report.
   * `fallback` is its last reply from before the reminder, used if it still does not report.
   */
  reminder: { fallback: string | null } | null
  /**
   * The user stopped this thread's last round (our stop, or DSH's own button) and has not set it
   * going again. It stays stopped, on the cards and for the main conversation, until the user
   * writes in it or the main conversation sends it more work: a turn DSH starts on its own in
   * between (a background job finishing) is not a round, and a report from it is refused.
   */
  stopped: boolean
  /**
   * Who started the last round that settled. A report the thread makes after that round, in a
   * turn DSH started on its own (a background job finishing), is delivered the way that round
   * was: by the wake-up rules after a task, quietly after a round the user drove. Null until a
   * round has settled (and on records from earlier versions), which counts as `dispatch`.
   */
  lastRound: RoundOrigin | null
  /**
   * The current round was not started by a brief, a follow-up or the user: the thread reported
   * in a turn DSH started on its own, and that report opened the round so it reaches the main
   * conversation. Its note says so.
   */
  late: boolean
  createdAt: string
  updatedAt: string
}

/** A report waiting to reach its main conversation. */
export interface PendingNote {
  threadId: string
  text: string
  /** Quiet notes never wake the main conversation; they ride along with its next turn. */
  quiet: boolean
  /** Card data for the transcript (absent on notes stored before M2c). */
  card?: ThreadCardInfo
}

/**
 * A thread the main conversation suggested on its own (thread_propose). It opens only when
 * the user picks it in the proposals card; past `maxRunning` it waits in a queue.
 */
export interface ProposalRecord {
  /** `proposal-<uuid>` */
  id: string
  mainSessionId: string
  title: string
  task: string
  state: 'pending' | 'queued' | 'started' | 'dismissed'
  /** Open the thread in its own worktree. */
  worktree: boolean
  threadId: string | null
  createdAt: string
  expiresAt: string
}

/**
 * A project, as in Claude: one folder (a DSH workspace) and one standing main conversation
 * that dispatches threads. Only a project's main conversation can open threads.
 */
export interface ProjectRecord {
  /** `project-<uuid>` */
  id: string
  title: string
  workspaceId: string
  /** The workspace folder, kept for display. */
  folder: string
  mainSessionId: string
  pinned: boolean
  /** Added to the system prompt of the main conversation and its threads ("记忆" in its settings). */
  instructions: string
  /** Icon id from the browser's project icon set. */
  icon: string
  /** What the coordinator works towards (Claude's project goal); only the main conversation sees it. */
  goal: string
  /** Archived projects leave the page's main list; their sessions are archived in DSH. */
  archived: boolean
  /** Which events raise a desktop notification. */
  notify: NotifyLevel
  /** Model for the main conversation; null follows DSH's default. */
  mainModel: ModelChoice | null
  /** Model for new threads; null follows DSH's default. */
  threadModel: ModelChoice | null
  createdAt: string
  updatedAt: string
}

/**
 * Notification levels, after Claude's: every new message; the main conversation and whatever
 * needs the user (Claude's "coordinator and @mentions"); only what needs the user; nothing.
 */
export type NotifyLevel = 'all' | 'attention' | 'waiting' | 'none'

export interface ModelChoice {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface MainRecord {
  id: string
  /** Automatic wake-ups since the user last spoke in this main conversation. */
  autoWakeStreak: number
  pendingNotes: PendingNote[]
}
