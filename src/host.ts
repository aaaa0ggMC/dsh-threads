// Adapts the real DSH services to ThreadHost (src/manager.ts). Verified against DSH
// 0.2.1-rc.2 in docs/IMPLEMENTATION.md §二 and the M0 spike table.
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { finalAssistantOutput } from '@deepseek-ai/dsh-subagent'
import { randomUUID } from 'node:crypto'
import type { ThreadAgent, ThreadHost } from './manager.ts'
import type { ProjectHost, TokenBuckets, WorkspaceInfo } from './projects.ts'
import { msg } from './messages.ts'
import { textOf, truncate } from './report.ts'
import { optional } from './services.ts'
import { type NoticeMeta, SOURCE_KIND } from './source.ts'
import { createWorktree, removeWorktree, systemGit } from './worktree.ts'

/** How much of a provider failure's message reaches the main conversation. */
const FAILURE_MESSAGE_MAX = 200

interface SessionTitleLike {
  rename(session: Agent['session'], title: string): unknown
}

interface WorkingDirectoryLike {
  get(session: Agent['session']): string
  set(agent: Agent, path: string, signal?: AbortSignal): Promise<string>
}

interface DefaultModelLike {
  currentSelection(): { provider: string; model: string; reasoningEffort?: string }
  saveSelection(next: { provider: string; model: string; reasoningEffort?: string }): Promise<void>
}

interface PermissionPresetsLike {
  current(session: Agent['session']): string
  set(session: Agent['session'], name: string): void
}

/**
 * Every message this plugin puts into an inbox: tagged with our source, shown as a compact
 * notice, and carrying the thread cards the browser half renders in place of the notice row.
 */
export function noticeMessage(text: string, summary: string, meta?: NoticeMeta) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: SOURCE_KIND,
      form: 'notice',
      summary: boundContextSummary(summary),
      ...(meta === undefined ? {} : { role: meta.role, threads: meta.threads, wake: meta.wake }),
    },
  })
}

export function wrapAgent(agent: Agent): ThreadAgent {
  return {
    id: agent.id,
    get status() { return agent.status },
    get seq() { return Number(agent.session.seq) },
    followup: (text, summary, meta) => agent.followup(noticeMessage(text, summary, meta)),
    steer: (text, summary, meta) => agent.steer(noticeMessage(text, summary, meta)),
    inject: (text, summary, meta) => agent.inject(noticeMessage(text, summary, meta)),
  }
}

/** Host services the browser's notifications use (src/api.ts). */
export interface ReplyHost {
  lastReply(sessionId: string): string | undefined
}

export function createHost(ctx: Context): ThreadHost & ProjectHost & ReplyHost {
  const live = (sessionId: string): Agent | undefined => ctx.agents.get(sessionId as SessionId)

  const workspaceInfo = (workspace: { id: string; path: string } | undefined): WorkspaceInfo | undefined =>
    workspace === undefined ? undefined : { id: workspace.id, path: workspace.path }

  const rename = (sessionId: string, title: string) => {
    const agent = live(sessionId)
    if (agent !== undefined) optional<SessionTitleLike>(ctx, 'sessionTitle')?.rename(agent.session, title)
  }

  const resolveAgent = async (sessionId: string): Promise<Agent | undefined> => {
    const current = live(sessionId)
    if (current !== undefined) return current
    const resolved = await ctx.sessionController.resolveAgent(sessionId as SessionId)
    if ('error' in resolved) {
      ctx.logger.warn(`dsh-threads: cannot reach session ${sessionId}: ${resolved.error.message}`)
      return undefined
    }
    return resolved.agent
  }

  return {
    async createSession(mainSessionId, sessionId) {
      const workspace = ctx.workspaceRegistry.list().find((candidate) => candidate.sessionIds.includes(mainSessionId as SessionId))
      const created = await ctx.sessionController.create({
        ...(workspace === undefined ? {} : { workspaceId: workspace.id }),
        sessionId: sessionId as SessionId,
      })
      if (created.sessionId !== sessionId) throw new Error(`DSH reused session ${created.sessionId} instead of creating ${sessionId}`)
      const agent = await resolveAgent(sessionId)
      if (agent === undefined) throw new Error(`thread session ${sessionId} was created but cannot be resolved`)
      return wrapAgent(agent)
    },

    async resolve(sessionId) {
      const agent = await resolveAgent(sessionId)
      return agent === undefined ? undefined : wrapAgent(agent)
    },

    rename,

    async createMainSession(workspaceId, title) {
      const sessionId = `session-${randomUUID()}`
      const created = await ctx.sessionController.create({ workspaceId: workspaceId as never, sessionId: sessionId as SessionId })
      // A blank session has no live title yet until its agent is resolved.
      if (await resolveAgent(created.sessionId) !== undefined) rename(created.sessionId, title)
      return created.sessionId
    },

    workspace(workspaceId) {
      return workspaceInfo(ctx.workspaceRegistry.list().find((candidate) => candidate.id === workspaceId))
    },

    async applyModel(sessionId, choice) {
      const defaults = optional<DefaultModelLike>(ctx, 'agentDefaultModel')
      const previous = defaults?.currentSelection()
      const target = choice ?? previous
      if (target === undefined) return
      await ctx.sessionController.selectModel({
        sessionId: sessionId as SessionId,
        provider: target.provider,
        model: target.model,
        ...(target.reasoningEffort === undefined ? {} : { reasoningEffort: target.reasoningEffort }),
      } as Parameters<typeof ctx.sessionController.selectModel>[0])
      // selectModel also makes the choice DSH's default for new sessions. Saves run in submission
      // order (dsh-agent-default-model), so saving the previous default now puts it back.
      if (defaults !== undefined && previous !== undefined
        && (previous.provider !== target.provider || previous.model !== target.model || previous.reasoningEffort !== target.reasoningEffort)) {
        await defaults.saveSelection(previous)
      }
    },

    async sessionUsage(sessionId) {
      const projected = await ctx.sessionController.projections({ sessionId: sessionId as SessionId } as Parameters<typeof ctx.sessionController.projections>[0], AbortSignal.timeout(5000))
      const usage = (projected as { values?: { tokenUsage?: unknown } } | null)?.values?.tokenUsage as TokenBuckets | undefined
      return usage ?? null
    },

    async archiveSession(sessionId) {
      await ctx.workspaceRegistry.archiveSession(sessionId as SessionId, { stopActivity: false })
    },

    async unarchiveSession(sessionId) {
      await ctx.workspaceRegistry.unarchiveSession(sessionId as SessionId)
    },

    async ensureWorkspace(folder, title) {
      const workspace = await ctx.workspaceRegistry.create(folder, title)
      return { id: workspace.id, path: workspace.path }
    },

    workspaceOf(sessionId) {
      return workspaceInfo(ctx.workspaceRegistry.list().find((candidate) => candidate.sessionIds.includes(sessionId as SessionId)))
    },

    async permissionOf(mainSessionId) {
      const presets = optional<PermissionPresetsLike>(ctx, 'permissionPresets')
      if (presets === undefined) return undefined
      // Resumed when needed: queued proposals may start while the main conversation is not loaded.
      const main = await resolveAgent(mainSessionId)
      if (main === undefined) throw new Error(msg().mainUnreachable(mainSessionId))
      const preset = presets.current(main.session)
      // `custom`: the main conversation's sandbox and approval knobs match no preset, and
      // `set` accepts only real presets, so there is nothing safe to copy.
      if (preset === 'custom') throw new Error(msg().customPreset)
      return preset
    },

    setPermission(threadId, preset) {
      const presets = optional<PermissionPresetsLike>(ctx, 'permissionPresets')
      const thread = live(threadId)
      if (presets === undefined || thread === undefined) throw new Error(msg().cannotSetPreset(threadId))
      presets.set(thread.session, preset)
    },

    async createWorktree(mainSessionId, name) {
      const folder = ctx.workspaceRegistry.list().find((candidate) => candidate.sessionIds.includes(mainSessionId as SessionId))?.path
        ?? (() => {
          const main = live(mainSessionId)
          return main === undefined ? undefined : optional<WorkingDirectoryLike>(ctx, 'workingDirectory')?.get(main.session)
        })()
      if (folder === undefined) throw new Error(msg().noMainFolder)
      return createWorktree(systemGit, folder, name)
    },

    async enterDirectory(threadId, path) {
      const agent = live(threadId)
      const directories = optional<WorkingDirectoryLike>(ctx, 'workingDirectory')
      if (agent === undefined || directories === undefined) throw new Error(msg().cannotEnter(threadId, path))
      await directories.set(agent, path)
    },

    removeWorktree: (worktree) => removeWorktree(systemGit, worktree),

    /** The latest assistant reply in a live session (searching its recent events only). */
    lastReply(sessionId: string) {
      const agent = live(sessionId)
      if (agent === undefined) return undefined
      const from = Math.max(0, Number(agent.session.seq) - 400)
      const events = agent.session.snapshotEvents(from as Parameters<typeof agent.session.snapshotEvents>[0])
      return textOf(finalAssistantOutput(events) as { type: string; text?: string }[] | undefined)
    },

    async cancel(sessionId) {
      const agent = live(sessionId)
      if (agent === undefined || agent.status !== 'running') return false
      // As DSH stops a session it archives: queued input is dropped instead of starting another turn.
      agent.cancel({ kind: 'user' })
      return true
    },

    stoppedByUser(threadId, fromSeq) {
      const agent = live(threadId)
      if (agent === undefined) return false
      const events = agent.session.snapshotEvents(fromSeq as Parameters<typeof agent.session.snapshotEvents>[0])
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i] as { type: string; data?: { reason?: { kind: string; reason?: { kind: string } } } }
        if (event.type !== 'turn/end') continue
        const reason = event.data?.reason
        return reason?.kind === 'aborted' && reason.reason?.kind === 'user'
      }
      return false
    },

    roundFailure(threadId, fromSeq) {
      const agent = live(threadId)
      if (agent === undefined) return null
      const events = agent.session.snapshotEvents(fromSeq as Parameters<typeof agent.session.snapshotEvents>[0])
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i] as { type: string; data?: { reason?: { kind: string; error?: LlmFailure } } }
        if (event.type !== 'turn/end') continue
        const reason = event.data?.reason
        if (reason?.kind !== 'error') return null
        const failure = reason.error
        if (failure === undefined) return null
        return {
          message: truncate(String(failure.message ?? ''), FAILURE_MESSAGE_MAX),
          code: String(failure.code ?? 'UNKNOWN'),
          ...(typeof failure.status === 'number' ? { status: failure.status } : {}),
        }
      }
      return null
    },

    roundOutput(threadId, fromSeq) {
      const agent = live(threadId)
      if (agent === undefined) return undefined
      const events = agent.session.snapshotEvents(fromSeq as Parameters<typeof agent.session.snapshotEvents>[0])
      return textOf(finalAssistantOutput(events) as { type: string; text?: string }[] | undefined)
    },
  }
}
