// Getting thread reports back into the main conversation, following Claude's rules
// (docs/IMPLEMENTATION.md §三 "唤醒规则"): wake an idle main conversation only when none of
// its threads is still running, hold while it is busy, and stop waking after
// `maxAutoWakes` consecutive wake-ups until the user speaks again.
import { msg } from './messages.ts'
import type { NoticeMeta } from './source.ts'
import type { MainRecord, PendingNote } from './types.ts'

export type DeliveryAction = 'wake' | 'hold' | 'quiet'

export interface DeliveryInput {
  mainStatus: 'idle' | 'running'
  runningThreads: number
  autoWakeStreak: number
  maxAutoWakes: number
}

/**
 * What to do with pending loud notes right now. Only the main conversation's own turn holds
 * them: a note from a finished thread must not wait behind unrelated threads that are still
 * running, or the main conversation never hears a finished thread while another one is long.
 */
export function decideDelivery(input: DeliveryInput): DeliveryAction {
  if (input.mainStatus === 'running') return 'hold'
  if (input.autoWakeStreak >= input.maxAutoWakes) return 'quiet'
  return 'wake'
}

/** The part of an Agent that delivery uses. */
export interface MainAgent {
  readonly status: 'idle' | 'running'
  /** Queue as a new turn and wake the agent. `meta` lets the transcript render thread cards. */
  followup(text: string, summary: string, meta?: NoticeMeta): void
  /** Queue for the next step without waking. */
  inject(text: string, summary: string, meta?: NoticeMeta): void
}

export interface FlushResult {
  record: MainRecord
  woke: boolean
}

/**
 * Deliver what can be delivered now and return the updated record (pure; the caller
 * persists it). Quiet notes are always injected; loud notes follow `decideDelivery`.
 */
export function flushNotes(record: MainRecord, agent: MainAgent, runningThreads: number, maxAutoWakes: number): FlushResult {
  if (record.pendingNotes.length === 0) return { record, woke: false }
  const quiet = record.pendingNotes.filter((note) => note.quiet)
  const loud = record.pendingNotes.filter((note) => !note.quiet)
  if (quiet.length > 0) agent.inject(join(quiet), summaryOf(quiet), metaOf(quiet, false))

  let remaining: PendingNote[] = []
  let streak = record.autoWakeStreak
  let woke = false
  if (loud.length > 0) {
    const action = decideDelivery({ mainStatus: agent.status, runningThreads, autoWakeStreak: streak, maxAutoWakes })
    if (action === 'wake') {
      agent.followup(join(loud), summaryOf(loud), metaOf(loud, true))
      streak += 1
      woke = true
    } else if (action === 'quiet') {
      agent.inject(join(loud), summaryOf(loud), metaOf(loud, false))
    } else {
      remaining = loud
    }
  }
  return { record: { ...record, autoWakeStreak: streak, pendingNotes: remaining }, woke }
}

function join(notes: readonly PendingNote[]): string {
  return notes.map((note) => note.text).join('\n\n')
}

function metaOf(notes: readonly PendingNote[], wake: boolean): NoticeMeta {
  return { role: 'report', threads: notes.flatMap((note) => (note.card === undefined ? [] : [note.card])), wake }
}

function summaryOf(notes: readonly PendingNote[]): string {
  const first = notes[0]?.text.split('\n', 1)[0] ?? ''
  return notes.length === 1 ? first : msg().reportsSummary(notes.length)
}
