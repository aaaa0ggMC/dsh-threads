import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { language, languageOf, msg, setLanguage } from '../src/messages.ts'
import { composeNote } from '../src/report.ts'
import { dispatchRpc } from '../src/rpc.ts'
import { threadOpenTool } from '../src/tools/thread-open.ts'
import { setup } from './fixtures.ts'

// The host half writes in the page's language: English until a browser says otherwise.

const rpc = (body: unknown) => dispatchRpc({ ping: () => 'pong' }, new Request('http://host/api/dsh-threads', { method: 'POST', body: JSON.stringify(body) }))

describe('host language', () => {
  it('maps the page locale to Chinese or English', () => {
    expect(['zh', 'zh-CN', 'zh-Hant-TW', 'ZH'].map(languageOf)).toEqual(['zh', 'zh', 'zh', 'zh'])
    expect(['en', 'en-US', 'ja', 'fr-FR'].map(languageOf)).toEqual(['en', 'en', 'en', 'en'])
  })

  it('follows the locale the latest browser call carries, and keeps it on calls without one', async () => {
    await rpc({ method: 'ping', locale: 'en-US' })
    expect(language()).toBe('en')
    await rpc({ method: 'ping' })
    expect(language()).toBe('en')
    await rpc({ method: 'ping', locale: 'zh-CN' })
    expect(language()).toBe('zh')
  })

  it('writes refusals, briefs and reports in English', async () => {
    setLanguage('en')
    const t = setup()
    await expect(t.manager.open('other', { title: 'a', task: 'x', initiation: 'user_asked' })).rejects.toThrow('Only a project\'s main conversation can open threads.')
    await t.manager.open('main', { title: 'Deps', task: 'List outdated dependencies', initiation: 'user_asked' })
    expect(t.agents.get('session-1')?.followups[0]).toBe('[Task from the main conversation · thread #1 "Deps"]\n\nList outdated dependencies\n\n'
      + '(Important: call thread_report once before you end this reply. The main conversation receives only what you put in thread_report, not your reply text.)')
    const note = composeNote({ id: 'session-1', n: 1, title: 'Deps', round: 'user', userMessages: ['bump it'] },
      { status: 'done', summary: 'Updated', changedFiles: ['a.ts', 'b.ts'], decisions: [], at: '' }, undefined, 400)
    expect(note).toBe([
      '[Thread #1 "Deps" · done · the thread\'s own report, not proof]',
      'The user asked for this round in the thread themselves; the thread did not act on its own. The user\'s words: "bump it"',
      'Summary: Updated',
      'Changed: a.ts, b.ts',
      'Details: thread_status { n: 1 }, or have the user open the thread in the sidebar.',
    ].join('\n'))
  })

  it('writes a failed round in English', () => {
    setLanguage('en')
    const note = composeNote({ id: 'session-1', n: 3, title: 'Deps' }, null, undefined, 400,
      { failure: { message: 'Your account quota has run out', code: 'QUOTA', status: 403 } })
    expect(note).toBe([
      '[Thread #3 "Deps" · failed · the thread\'s own report, not proof]',
      'Failed: Your account quota has run out (code QUOTA, HTTP 403). The thread\'s model call failed this round — the report was not lost; '
        + 'tell the user the reason and let them decide whether to retry.',
      'Details: thread_status { n: 3 }, or have the user open the thread in the sidebar.',
    ].join('\n'))
  })

  it('asks the offer question in the page language and accepts an answer in either', async () => {
    setLanguage('en')
    const t = setup()
    const asked: { question: string; options: { label: string }[] }[] = []
    const ctx = {
      get: () => ({
        async ask(request: { questions: { id: string; question: string; options: { label: string }[] }[] }) {
          asked.push(...request.questions)
          // The page switched to Chinese while the question waited.
          return { answers: [{ id: request.questions[0]!.id, selected: ['在主对话里做'] }] }
        },
      }),
    }
    const tool = threadOpenTool(ctx as unknown as Context, t.manager)
    const result = await tool.execute({ title: 'Review', task: 'x', initiation: 'offer' } as never,
      { agent: { id: 'main' }, signal: new AbortController().signal, callId: 'c' } as never) as { text: string }
    expect(asked[0]?.question).toBe('Open a thread for "Review"?')
    expect(asked[0]?.options.map((option) => option.label)).toEqual(['Open a thread', 'Do it here', 'Not now'])
    expect(result.text).toBe(msg().offerChoseHere)
    expect(t.store.threadsOf('main')).toEqual([])
  })
})
