import { describe, expect, it } from 'vitest'
import { decideDelivery, flushNotes, type MainAgent } from '../src/delivery.ts'
import type { MainRecord } from '../src/types.ts'

function agent(status: 'idle' | 'running' = 'idle') {
  const sent = { followup: [] as string[], inject: [] as string[] }
  const main: MainAgent = {
    status,
    followup: (text) => { sent.followup.push(text) },
    inject: (text) => { sent.inject.push(text) },
  }
  return { main, sent }
}

const record = (notes: MainRecord['pendingNotes'], autoWakeStreak = 0): MainRecord => ({ id: 'main', autoWakeStreak, pendingNotes: notes })
const loud = (text: string) => ({ threadId: 't', text, quiet: false })
const quiet = (text: string) => ({ threadId: 't', text, quiet: true })

describe('decideDelivery', () => {
  const base = { mainStatus: 'idle' as const, runningThreads: 0, autoWakeStreak: 0, maxAutoWakes: 5 }

  it('wakes an idle main conversation with no running threads', () => {
    expect(decideDelivery(base)).toBe('wake')
  })

  it('holds while the main conversation is running', () => {
    expect(decideDelivery({ ...base, mainStatus: 'running' })).toBe('hold')
  })

  it('still wakes for a finished thread while another thread is running', () => {
    // A long-running sibling must not hold this thread's result back from the main conversation.
    expect(decideDelivery({ ...base, runningThreads: 1 })).toBe('wake')
  })

  it('stops waking once the streak reaches the limit', () => {
    expect(decideDelivery({ ...base, autoWakeStreak: 5 })).toBe('quiet')
  })
})

describe('flushNotes', () => {
  it('wakes with all loud notes in one message and counts the wake-up', () => {
    const { main, sent } = agent()
    const result = flushNotes(record([loud('a'), loud('b')]), main, 0, 5)
    expect(sent.followup).toEqual(['a\n\nb'])
    expect(result.woke).toBe(true)
    expect(result.record.autoWakeStreak).toBe(1)
    expect(result.record.pendingNotes).toEqual([])
  })

  it('keeps loud notes pending while holding', () => {
    const { main, sent } = agent('running')
    const result = flushNotes(record([loud('a')]), main, 0, 5)
    expect(sent.followup).toEqual([])
    expect(result.record.pendingNotes).toEqual([loud('a')])
  })

  it('injects instead of waking at the wake-up limit (loop guard)', () => {
    const { main, sent } = agent()
    const result = flushNotes(record([loud('a')], 5), main, 0, 5)
    expect(sent.followup).toEqual([])
    expect(sent.inject).toEqual(['a'])
    expect(result.record.autoWakeStreak).toBe(5)
    expect(result.record.pendingNotes).toEqual([])
  })

  it('always injects quiet notes, even while holding loud ones', () => {
    const { main, sent } = agent('running')
    const result = flushNotes(record([quiet('q'), loud('a')]), main, 0, 5)
    expect(sent.inject).toEqual(['q'])
    expect(result.record.pendingNotes).toEqual([loud('a')])
  })

  // A thread's held report and the one it sent later, after a background job ended (src/manager.ts
  // recordReport): both are delivered, in order, so words the first carried are not lost. The
  // later one says that it replaces the earlier. Notes wait only while the main conversation is
  // running: a sibling thread that is still running no longer holds them back (decideDelivery).
  it('delivers two notes of one thread together, oldest first', () => {
    const busy = agent('running')
    const first = { threadId: 'session-1', text: '[#1 · done]\n摘要：构建已启动', quiet: false }
    const late = { threadId: 'session-1', text: '[#1 · failed]\n补交的回报\n摘要：构建失败', quiet: false }
    const held = flushNotes(record([first, late]), busy.main, 1, 5)
    expect(held.record.pendingNotes).toEqual([first, late])
    const { main, sent } = agent()
    const result = flushNotes(held.record, main, 1, 5)
    expect(sent.followup).toEqual([`${first.text}\n\n${late.text}`])
    expect(result.record).toMatchObject({ pendingNotes: [], autoWakeStreak: 1 })
  })
})
