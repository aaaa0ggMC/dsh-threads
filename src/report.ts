import { msg } from './messages.ts'
import type { RoundFailure, ThreadRecord, ThreadReport } from './types.ts'

const ELLIPSIS = '…'
/** Longest quote of one user message in a report. */
const USER_WORDS_MAX = 200

/** Cut `text` to at most `max` characters (code points), marking the cut. */
export function truncate(text: string, max: number): string {
  const chars = [...text]
  if (chars.length <= max) return text
  return chars.slice(0, Math.max(0, max - 1)).join('') + ELLIPSIS
}

/** One line of plain text for a card: markdown markers dropped, whitespace collapsed. */
export function plainLine(text: string): string {
  return text
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Plain text of content blocks (text blocks only), or undefined when there is none. */
export function textOf(blocks: readonly { type: string; text?: string }[] | undefined): string | undefined {
  const text = (blocks ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
    .trim()
  return text.length === 0 ? undefined : text
}

/** Clean up a model-supplied report: trim, bound the summary, drop empty list items. */
export function normalizeReport(input: {
  status: ThreadReport['status']
  summary: string
  changedFiles?: readonly string[]
  decisions?: readonly string[]
}, summaryMaxChars: number, at: string): ThreadReport {
  const items = (list: readonly string[] | undefined) => (list ?? []).map((item) => item.trim()).filter((item) => item.length > 0)
  return {
    status: input.status,
    summary: truncate(input.summary.trim(), summaryMaxChars),
    changedFiles: items(input.changedFiles),
    decisions: items(input.decisions),
    at,
  }
}

/** The report submitted during the current round, if any. */
export function currentReport(thread: ThreadRecord): ThreadReport | null {
  const report = thread.lastReport
  if (report === null || thread.roundStartedAt === null) return null
  return report.at >= thread.roundStartedAt ? report : null
}

/** One line for the chat UI's notice row (the UI bounds it further). */
export function noticeSummary(thread: Pick<ThreadRecord, 'n' | 'title'>, status: string): string {
  return msg().noticeSummary(thread.n, thread.title, status)
}

/**
 * The note delivered to the main conversation: only the conclusion, changed files and
 * open decisions; the details stay in the thread (docs/IMPLEMENTATION.md §三).
 *
 * `failure` is why the round's model call failed. It leads the note, right under the header, so
 * truncation cannot drop the one thing the main conversation must act on.
 */
export function composeNote(
  thread: Pick<ThreadRecord, 'n' | 'title' | 'id'> & Partial<Pick<ThreadRecord, 'worktree' | 'round' | 'userMessages'>>,
  report: ThreadReport | null,
  fallbackText: string | undefined,
  maxChars: number,
  options: { stopped?: boolean; late?: boolean; failure?: RoundFailure | null } = {},
): string {
  const m = msg()
  const failure = options.failure ?? null
  const status = options.stopped === true ? 'stopped' : failure !== null ? 'failed' : report?.status ?? 'no-report'
  const lines = [m.noteHeader(thread.n, thread.title, status)]
  if (failure !== null) lines.push(m.noteFailure(m.failureReason(failure.message, failure.code, failure.status)))
  if (options.stopped === true) lines.push(m.noteStopped)
  // Also under the header: the main conversation has usually been told about this thread once already.
  if (options.late === true) lines.push(m.noteLate)
  // Right under the header so truncation never drops it.
  if (thread.worktree != null) lines.push(m.noteBranch(thread.worktree.branch))
  // Also near the top: without it a change the user asked for in the thread reads as the thread's own idea.
  const said = (thread.userMessages ?? []).map((text) => m.quote(truncate(plainLine(text), USER_WORDS_MAX))).join(' ')
  if (said.length > 0) lines.push(thread.round === 'user' ? m.noteUserRound(said) : m.noteUserSaid(said))
  if (report !== null) {
    lines.push(m.noteSummary(report.summary))
    if (report.changedFiles.length > 0) lines.push(m.changedFiles(report.changedFiles))
    if (report.decisions.length > 0) lines.push(m.decisionsLine(report.decisions))
  } else if (fallbackText !== undefined) {
    lines.push(m.noteFallback(fallbackText))
  } else if (failure === null) {
    lines.push(m.noteNothing)
  }
  lines.push(m.noteDetails(thread.n))
  return truncate(lines.join('\n'), maxChars)
}
