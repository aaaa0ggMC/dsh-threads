// Text the host half writes: what the user sees (the offer question, /thread replies, errors
// the panes show, the brief and follow-up cards in a thread) and what the models read (tool
// results, reports). It follows the browser's language, which every call from the browser half
// carries (src/rpc.ts); until a browser has called, it is English. System prompts stay English
// (src/prompts.ts): models answer in the user's language regardless.

export type Language = 'zh' | 'en'

const zh = {
  // Thread rounds (src/manager.ts)
  notAProject: '只有项目的主对话能开讨论串。先在左侧"项目"里新建项目，或在会话菜单里选"设为项目"。',
  briefHeader: (n: number, title: string) => `[来自主对话的任务 · 讨论串 #${n}「${title}」]`,
  briefFooter: '（重要：结束本轮回复之前，必须调用一次 thread_report。主对话只能收到 thread_report 的内容，收不到你的回复正文。）',
  reminderHeader: (n: number, title: string) => `[dsh-threads 提醒 · 讨论串 #${n}「${title}」]`,
  reminderBody: '你结束了这一轮，但没有调用 thread_report，主对话收不到结果。现在调用一次 thread_report 汇报这一轮的结果（status、summary、changedFiles、decisions）。不用重做任务，也不要做别的事。',
  replyHeader: (n: number, title: string) => `[来自主对话的追加指令 · 讨论串 #${n}「${title}」]`,
  replyFooter: '（做完后同样要调用一次 thread_report。）',
  noticeBrief: '任务',
  noticeReply: '追加指令',
  noticeReminder: '提醒回报',
  noNestedThreads: '讨论串里不能再开讨论串；把这个需要写进 thread_report 的 decisions，交给主对话决定。',
  emptyTask: 'task 不能为空：写一份完整的简报。',
  runningLimit: (running: number, max: number) => `已有 ${running} 个讨论串在运行（上限 ${max}）。等有讨论串回报后再开，或者这件事在主对话里做。`,
  noPreset: (reason: string) => `没有开讨论串：没法让它沿用主对话的审批模式（${reason}）。`,
  noWorktree: (reason: string) => `没法给讨论串开 worktree：${reason}`,
  emptyMessage: 'message 不能为空。',
  noThreadNumber: (n: number) => `这个主对话没有讨论串 #${n}。`,
  notReady: (n: number, status: string) => `讨论串 #${n} 没有建好（${status}），不能追加；需要的话重新开一个。`,
  archivedNoReply: (n: number) => `讨论串 #${n} 已被用户归档。需要继续就请用户在讨论串列表里取消归档，或者开一个新的。`,
  unreachable: (n: number) => `讨论串 #${n} 现在连不上（会话可能已被归档或删除）。`,
  failedAtRestart: 'DSH 重启时讨论串还没建好。',
  unreachableAfterRestart: 'DSH 重启后连不上这个讨论串。',
  noProposals: '至少要有一个带完整简报的提议。',
  proposalLimit: (max: number) => `一次最多提 ${max} 个讨论串；挑最值得做的。`,
  threadNotFound: '找不到这个讨论串。',
  stillStarting: (n: number) => `讨论串 #${n} 还在建，稍后再停。`,
  notRunning: (n: number) => `讨论串 #${n} 现在没有在运行。`,
  stopBeforeArchive: (n: number) => `讨论串 #${n} 还在运行，先停止再归档。`,
  reportFromThreadsOnly: '只有讨论串会话能调用 thread_report。',
  reportAfterStop: '没有记录这份回报：用户已经停止了这个讨论串，主对话那边它保持“已停止”。不要继续这项任务，也不要再调用工具；用一两句话结束回复，等用户在这里发话或主对话追加指令。',
  cleanupFailed: (n: number, reason: string) => `#${n}：删除失败（${reason}）`,
  cleanupDirty: (n: number, path: string) => `#${n}：${path} 里有没提交的改动，没删；先提交或丢弃。`,
  cleanupRemoved: (n: number, branch: string, kept: boolean) =>
    `#${n}：已删除 worktree，${kept ? `分支 ${branch} 还有没合并的提交，保留` : `分支 ${branch} 已合并，一并删除`}。`,

  // thread_status (manager.describe)
  noSuchThread: (n: number) => `没有讨论串 #${n}。`,
  noThreads: '这个主对话还没有讨论串。',
  archivedMark: ' · 已归档',
  stoppedMark: ' · 用户已停止',
  describeHead: (n: number, title: string, status: string, archived: string, id: string) => `讨论串 #${n}「${title}」· ${status}${archived}（会话 ${id}）`,
  describeWorktree: (path: string, branch: string, removed: boolean) => `worktree：${path}，分支 ${branch}${removed ? '（已删除 worktree）' : ''}`,
  describeTask: (task: string) => `任务：${task}`,
  describeNoReport: '最新回报：无',
  describeReport: (at: string, status: string, summary: string) => `最新回报（${at}，${status}）：${summary}`,
  describeError: (error: string) => `错误：${error}`,
  listNoReport: '无回报',
  listLatest: (status: string, summary: string) => `${status}：${summary}`,
  listLine: (n: number, title: string, status: string, archived: string, latest: string) => `#${n}「${title}」· ${status}${archived} · ${latest}`,

  // Reports to the main conversation (src/report.ts, src/delivery.ts)
  noticeSummary: (n: number, title: string, status: string) => `讨论串 #${n}「${title}」· ${status}`,
  noteHeader: (n: number, title: string, status: string) => `[讨论串 #${n}「${title}」· ${status} · 这是讨论串的报告，不是证据]`,
  noteStopped: '用户在这一轮做完之前停止了讨论串。不要自己重开或重派这件事，除非用户要求。',
  noteLate: '这是讨论串在上一轮结束之后补交的回报：DSH 自己叫醒了它（通常是它留在后台的任务结束了），不是你或用户让它继续的。它取代这个讨论串之前的回报。',
  noteBranch: (branch: string) => `分支：${branch}（讨论串自己的 worktree；改动不在项目文件夹里，用户要求时再合并）`,
  quote: (text: string) => `「${text}」`,
  noteUserRound: (said: string) => `这一轮是用户自己在讨论串里要求的，不是讨论串自作主张。用户的原话：${said}`,
  noteUserSaid: (said: string) => `这一轮中用户在讨论串里说过：${said}`,
  noteSummary: (summary: string) => `摘要：${summary}`,
  changedFiles: (files: readonly string[]) => `改动：${files.join('、')}`,
  decisionsLine: (decisions: readonly string[]) => `待用户决定：${decisions.join('；')}`,
  noteFallback: (text: string) => `（讨论串没有调用 thread_report，以下是它最后一条回复）${text}`,
  noteNothing: '（讨论串结束了，但没有回报也没有回复；用户可以点开讨论串查看。）',
  noteDetails: (n: number) => `详情：thread_status { n: ${n} }，或让用户在侧栏打开该讨论串。`,
  reportsSummary: (count: number) => `${count} 个讨论串回报`,

  // Worktrees and DSH services (src/worktree.ts, src/host.ts)
  notARepository: (folder: string) => `项目文件夹 ${folder} 不是 git 仓库，没法开 worktree。不用 worktree 再开，或者请用户先初始化仓库。`,
  gitMissing: '找不到 git：DeepSeek Harness 运行环境的 PATH 里没有 git 命令，没法开 worktree。请用户安装 Git（Windows 上是 Git for Windows），完全退出并重开 DeepSeek Harness；或者不用 worktree 再开。',
  gitFailed: (folder: string, detail: string) => `在项目文件夹 ${folder} 里运行 git 失败，没法开 worktree。git 的原话：${detail}。不用 worktree 再开，或者请用户先处理这个 git 错误。`,
  pathTooLong: (repository: string) => `worktree 里的完整路径超过了 Windows 默认的 260 字符上限，git 建不了里面的文件（Filename too long）。可以请用户只为这个仓库打开长路径支持（git -C "${repository}" config core.longpaths true），或者把仓库挪到更短的路径下；也可以不用 worktree 再开。`,
  checkoutFailed: (detail: string) => `git 没能检出 worktree：${detail}。不用 worktree 再开，或者请用户先处理这个 git 错误。`,
  noCommits: '仓库还没有任何提交，没法从 HEAD 开 worktree。',
  subfolderNotCommitted: (subdir: string) => `项目文件夹 ${subdir} 还没有提交进仓库，worktree 里不会有它。不用 worktree 再开，或者请用户先提交。`,
  mainUnreachable: (id: string) => `主对话 ${id} 连不上`,
  customPreset: '主对话的审批设置是自定义的（custom），不对应任何模式；先在主对话里选一个审批模式',
  cannotSetPreset: (id: string) => `没法给讨论串 ${id} 设审批模式。`,
  noMainFolder: '找不到主对话所在的文件夹。',
  cannotEnter: (id: string, path: string) => `没法把讨论串 ${id} 切到 ${path}。`,

  // Projects (src/projects.ts, src/api.ts)
  emptyProjectTitle: '项目名不能为空。',
  threadNotProject: '讨论串不能设为项目。',
  notInWorkspace: '这个会话不在任何工作区里，没法设为项目。',
  absoluteFolder: (example: string) => `文件夹要写完整路径，例如 ${example}。`,
  badFolder: (reason: string) => `没法用这个文件夹：${reason}`,
  pickFolder: '请选择项目的文件夹（工作区）。',
  workspaceNotFound: '找不到这个工作区。',
  projectNotFound: '找不到这个项目。',
  modelRefused: (reason: string) => `主对话没法换成这个模型：${reason}`,
  archiveWhileRunning: '还有讨论串在运行，等它们结束再归档。',
  mainBusy: (reason: string) => `主对话现在没法归档（可能还在运行）：${reason}`,
  deleteWhileRunning: '还有讨论串在运行，等它们结束再删除。',
  badRequest: (issues: readonly string[]) => `请求参数不对：${issues.join('；')}`,

  // /thread (src/command.ts)
  usage: '用法：/thread <任务>；/thread -w <任务> 在独立 worktree 里做；/thread stop <n> 停止讨论串 #n；/thread cleanup 清理做完的 worktree。',
  usageTask: '任务要写清目标、相关文件和完成标准。',
  commandStopped: (n: number, title: string) => `已停止讨论串 #${n}「${title}」。`,
  stopFailed: (reason: string) => `停止失败：${reason}`,
  commandOpened: (n: number, title: string, branch: string | null) =>
    `已开讨论串 #${n}「${title}」${branch === null ? '' : `（分支 ${branch}）`}，做完会把摘要发回这里。`,
  openFailed: (reason: string) => `开讨论串失败：${reason}`,
  cleanupNone: '没有可以清理的 worktree（运行中的讨论串不算）。',
  cleanupItem: (n: number, title: string, branch: string) => `#${n}「${title}」${branch}`,
  cleanupList: (items: readonly string[]) => `会删除这些讨论串的 worktree：${items.join('；')}。有没提交改动的会跳过；分支只在已合并时删除。确认请输入 /thread cleanup confirm。`,

  // Tools (src/tools)
  offerHeader: '讨论串',
  offerQuestion: (title: string) => `要为「${title}」开一个讨论串吗？`,
  offerOpen: '开讨论串',
  offerOpenDetail: '在后台的新会话里做，做完把摘要发回这里',
  offerHere: '在主对话里做',
  offerHereDetail: '就在当前对话里做',
  offerSkip: '先不做',
  offerSkipDetail: '先不做',
  offerUnavailable: '没法在界面上询问用户（userQuestions 不可用）。请在回复里直接问用户要不要开讨论串。',
  offerChoseHere: '用户选择在主对话里做：不要开讨论串，直接在这里做这件事。',
  offerChoseSkip: '用户选择先不做这件事：不要开讨论串，也不要开始做。',
  offerChoseOther: (answer: string | undefined) => `用户没有选择开讨论串，回答是：${answer ?? '（无）'}。按用户的回答处理，不要开讨论串。`,
  toolOpenedWorktree: (branch: string, base: string) => `它在自己的 worktree 里工作（分支 ${branch}，从 ${base} 开出）。`,
  toolOpened: (n: number, title: string, id: string, worktree: string) =>
    `已开讨论串 #${n}「${title}」（会话 ${id}），它在后台运行，用户可以在侧栏点开它。${worktree}它做完会把摘要发回这里；不要等待或轮询，继续做别的事或结束本轮。`,
  toolNotOpened: (reason: string) => `没有开讨论串：${reason}`,
  toolRepliedSteer: (n: number, title: string) => `已把追加指令直接插给讨论串 #${n}「${title}」：它下一步就会读到，不用等这一轮结束。它做完会再回报；不要等待或轮询。`,
  toolRepliedFollowup: (n: number, title: string) => `已把追加指令排给讨论串 #${n}「${title}」：它正在跑时会作为下一轮处理（当前这一轮结束后开始），空闲时两种方式都是立刻开跑。它做完会再回报；不要等待或轮询。`,
  toolNotSent: (reason: string) => `没有发送：${reason}`,
  toolReported: '回报已记录，并且已经发给主对话（不用等这一轮结束）。现在用一两句话结束回复，不要再调用工具。',
  toolProposed: (titles: readonly string[]) =>
    `已把 ${titles.length} 个提议放进输入框上方的卡片：${titles.map((title) => `「${title}」`).join('、')}。用户勾选后才会开讨论串；不要等待，也不要在回复里重复列出。`,
  toolNotProposed: (reason: string) => `没有提议：${reason}`,
}

export type Messages = typeof zh

const en: Messages = {
  notAProject: 'Only a project\'s main conversation can open threads. Create a project under "Projects" in the sidebar, or choose "Make project" in the conversation\'s menu.',
  briefHeader: (n, title) => `[Task from the main conversation · thread #${n} "${title}"]`,
  briefFooter: '(Important: call thread_report once before you end this reply. The main conversation receives only what you put in thread_report, not your reply text.)',
  reminderHeader: (n, title) => `[dsh-threads reminder · thread #${n} "${title}"]`,
  reminderBody: 'You ended this round without calling thread_report, so the main conversation has no result. Call thread_report once now to report this round (status, summary, changedFiles, decisions). Do not redo the task and do nothing else.',
  replyHeader: (n, title) => `[Follow-up from the main conversation · thread #${n} "${title}"]`,
  replyFooter: '(Call thread_report once when you are done, as before.)',
  noticeBrief: 'task',
  noticeReply: 'follow-up',
  noticeReminder: 'report reminder',
  noNestedThreads: 'A thread cannot open threads; put what you need in the decisions of thread_report and let the main conversation decide.',
  emptyTask: 'task is empty: write a complete brief.',
  runningLimit: (running, max) => `${running} threads are already running (limit ${max}). Open this one after a thread reports, or do the work in the main conversation.`,
  noPreset: (reason) => `Thread not opened: it could not keep the main conversation's permission mode (${reason}).`,
  noWorktree: (reason) => `Could not give the thread a worktree: ${reason}`,
  emptyMessage: 'message is empty.',
  noThreadNumber: (n) => `This main conversation has no thread #${n}.`,
  notReady: (n, status) => `Thread #${n} was never set up (${status}), so it cannot take follow-ups; open a new one if needed.`,
  archivedNoReply: (n) => `The user archived thread #${n}. To continue it, ask the user to unarchive it in the threads list, or open a new one.`,
  unreachable: (n) => `Thread #${n} cannot be reached now (its session may have been archived or deleted).`,
  failedAtRestart: 'The thread was still being set up when DSH restarted.',
  unreachableAfterRestart: 'The thread could not be reached after DSH restarted.',
  noProposals: 'Give at least one suggestion with a complete brief.',
  proposalLimit: (max) => `At most ${max} suggestions at once; pick the most valuable.`,
  threadNotFound: 'Thread not found.',
  stillStarting: (n) => `Thread #${n} is still being set up; stop it in a moment.`,
  notRunning: (n) => `Thread #${n} is not running.`,
  stopBeforeArchive: (n) => `Thread #${n} is still running; stop it before archiving.`,
  reportFromThreadsOnly: 'Only thread sessions can call thread_report.',
  reportAfterStop: 'This report was not recorded: the user stopped this thread, and it stays "stopped" for the main conversation. Do not continue the task and call no more tools; end your reply in a sentence or two and wait for the user to write here or for a follow-up from the main conversation.',
  cleanupFailed: (n, reason) => `#${n}: removal failed (${reason})`,
  cleanupDirty: (n, path) => `#${n}: ${path} has uncommitted changes, so it was kept; commit or discard them first.`,
  cleanupRemoved: (n, branch, kept) =>
    `#${n}: worktree removed; ${kept ? `branch ${branch} has unmerged commits and was kept` : `branch ${branch} was merged and was deleted too`}.`,

  noSuchThread: (n) => `No thread #${n}.`,
  noThreads: 'This main conversation has no threads yet.',
  archivedMark: ' · archived',
  stoppedMark: ' · stopped by the user',
  describeHead: (n, title, status, archived, id) => `Thread #${n} "${title}" · ${status}${archived} (session ${id})`,
  describeWorktree: (path, branch, removed) => `Worktree: ${path}, branch ${branch}${removed ? ' (worktree removed)' : ''}`,
  describeTask: (task) => `Task: ${task}`,
  describeNoReport: 'Latest report: none',
  describeReport: (at, status, summary) => `Latest report (${at}, ${status}): ${summary}`,
  describeError: (error) => `Error: ${error}`,
  listNoReport: 'no report',
  listLatest: (status, summary) => `${status}: ${summary}`,
  listLine: (n, title, status, archived, latest) => `#${n} "${title}" · ${status}${archived} · ${latest}`,

  noticeSummary: (n, title, status) => `Thread #${n} "${title}" · ${status}`,
  noteHeader: (n, title, status) => `[Thread #${n} "${title}" · ${status} · the thread's own report, not proof]`,
  noteStopped: 'The user stopped the thread before this round was done. Do not reopen or re-dispatch this work unless the user asks.',
  noteLate: 'The thread sent this report after its last round had ended: DSH woke it on its own (usually a background job it left running finished); neither you nor the user asked it to continue. It replaces this thread\'s earlier report.',
  noteBranch: (branch) => `Branch: ${branch} (the thread's own worktree; the changes are not in the project folder; merge only when the user asks)`,
  quote: (text) => `"${text}"`,
  noteUserRound: (said) => `The user asked for this round in the thread themselves; the thread did not act on its own. The user's words: ${said}`,
  noteUserSaid: (said) => `During this round the user said in the thread: ${said}`,
  noteSummary: (summary) => `Summary: ${summary}`,
  changedFiles: (files) => `Changed: ${files.join(', ')}`,
  decisionsLine: (decisions) => `For the user to decide: ${decisions.join('; ')}`,
  noteFallback: (text) => `(The thread did not call thread_report; this is its last reply) ${text}`,
  noteNothing: '(The thread ended without a report or a reply; the user can open the thread to look.)',
  noteDetails: (n) => `Details: thread_status { n: ${n} }, or have the user open the thread in the sidebar.`,
  reportsSummary: (count) => `${count} thread reports`,

  notARepository: (folder) => `The project folder ${folder} is not a git repository, so it cannot have a worktree. Open the thread without a worktree, or ask the user to initialize the repository first.`,
  gitMissing: 'git was not found: there is no git command on DeepSeek Harness\'s PATH, so the thread cannot have a worktree. Ask the user to install Git (Git for Windows on Windows), then quit DeepSeek Harness completely and reopen it; or open the thread without a worktree.',
  gitFailed: (folder, detail) => `git failed in the project folder ${folder}, so the thread cannot have a worktree. git said: ${detail}. Open the thread without a worktree, or ask the user to sort out this git error first.`,
  pathTooLong: (repository) => `The worktree's full paths exceed Windows' default 260-character limit, so git could not create its files (Filename too long). Ask the user to turn on long paths for this repository only (git -C "${repository}" config core.longpaths true), or to move the repository to a shorter path; or open the thread without a worktree.`,
  checkoutFailed: (detail) => `git could not check out the worktree: ${detail}. Open the thread without a worktree, or ask the user to sort out this git error first.`,
  noCommits: 'The repository has no commits yet, so there is no HEAD to start a worktree from.',
  subfolderNotCommitted: (subdir) => `The project folder ${subdir} is not committed to the repository yet, so a worktree would not contain it. Open the thread without a worktree, or ask the user to commit it first.`,
  mainUnreachable: (id) => `the main conversation ${id} cannot be reached`,
  customPreset: 'the main conversation uses custom permission settings that match no mode; choose a permission mode in the main conversation first',
  cannotSetPreset: (id) => `Could not set the permission mode of thread ${id}.`,
  noMainFolder: 'The main conversation\'s folder was not found.',
  cannotEnter: (id, path) => `Could not move thread ${id} to ${path}.`,

  emptyProjectTitle: 'The project needs a name.',
  threadNotProject: 'A thread cannot become a project.',
  notInWorkspace: 'This conversation is in no workspace, so it cannot become a project.',
  absoluteFolder: (example) => `Write the folder's full path, for example ${example}.`,
  badFolder: (reason) => `This folder cannot be used: ${reason}`,
  pickFolder: 'Choose the project\'s folder (workspace).',
  workspaceNotFound: 'Workspace not found.',
  projectNotFound: 'Project not found.',
  modelRefused: (reason) => `The main conversation cannot use this model: ${reason}`,
  archiveWhileRunning: 'Threads are still running; archive the project once they finish.',
  mainBusy: (reason) => `The main conversation cannot be archived now (it may still be running): ${reason}`,
  deleteWhileRunning: 'Threads are still running; delete the project once they finish.',
  badRequest: (issues) => `Invalid request: ${issues.join('; ')}`,

  usage: 'Usage: /thread <task>; /thread -w <task> to work in its own worktree; /thread stop <n> to stop thread #n; /thread cleanup to remove finished worktrees.',
  usageTask: 'Describe the goal, the relevant files and what done looks like.',
  commandStopped: (n, title) => `Stopped thread #${n} "${title}".`,
  stopFailed: (reason) => `Could not stop the thread: ${reason}`,
  commandOpened: (n, title, branch) =>
    `Opened thread #${n} "${title}"${branch === null ? '' : ` (branch ${branch})`}; its summary comes back here when it is done.`,
  openFailed: (reason) => `Could not open the thread: ${reason}`,
  cleanupNone: 'No worktrees to remove (running threads are left alone).',
  cleanupItem: (n, title, branch) => `#${n} "${title}" ${branch}`,
  cleanupList: (items) => `This removes the worktrees of: ${items.join('; ')}. Checkouts with uncommitted changes are skipped; a branch is deleted only when it is merged. To go ahead, type /thread cleanup confirm.`,

  offerHeader: 'Thread',
  offerQuestion: (title) => `Open a thread for "${title}"?`,
  offerOpen: 'Open a thread',
  offerOpenDetail: 'Work on it in a new background session; its summary comes back here',
  offerHere: 'Do it here',
  offerHereDetail: 'Work on it in this conversation',
  offerSkip: 'Not now',
  offerSkipDetail: 'Do not do it for now',
  offerUnavailable: 'The question cannot be shown in the interface (userQuestions is not available). Ask the user in your reply whether to open a thread.',
  offerChoseHere: 'The user chose to do it in the main conversation: do not open a thread; do the work here.',
  offerChoseSkip: 'The user chose not to do this now: do not open a thread and do not start the work.',
  offerChoseOther: (answer) => `The user did not choose to open a thread; their answer: ${answer ?? '(none)'}. Act on their answer and do not open a thread.`,
  toolOpenedWorktree: (branch, base) => `It works in its own worktree (branch ${branch}, started from ${base}). `,
  toolOpened: (n, title, id, worktree) =>
    `Opened thread #${n} "${title}" (session ${id}). It runs in the background and the user can open it from the sidebar. ${worktree}Its summary comes back here when it is done; do not wait or poll, carry on with other work or end your turn.`,
  toolNotOpened: (reason) => `Thread not opened: ${reason}`,
  toolRepliedSteer: (n, title) => `Sent the follow-up straight into thread #${n} "${title}": it reads it at its next step, without waiting for the thread's current turn to end. It reports again when it is done; do not wait or poll.`,
  toolRepliedFollowup: (n, title) => `Queued the follow-up for thread #${n} "${title}": while it is running, it becomes its own next turn after the thread's current turn ends; an idle thread starts either mode right away. It reports again when it is done; do not wait or poll.`,
  toolNotSent: (reason) => `Not sent: ${reason}`,
  toolReported: 'Report recorded and already sent to the main conversation, without waiting for this round to end. Finish your reply in a sentence or two and call no more tools.',
  toolProposed: (titles) =>
    `Put ${titles.length} suggestion(s) in the card above the composer: ${titles.map((title) => `"${title}"`).join(', ')}. Threads open only when the user picks them; do not wait, and do not list them again in your reply.`,
  toolNotProposed: (reason) => `No suggestions made: ${reason}`,
}

const dictionaries: Record<Language, Messages> = { zh, en }
let current: Language = 'en'

/** The browser's locale id (`zh`, `zh-CN`, `en-US`, …) → the language this half writes in. */
export function languageOf(locale: string): Language {
  return /^zh\b/i.test(locale) ? 'zh' : 'en'
}

export function setLanguage(language: Language): void {
  current = language
}

export function language(): Language {
  return current
}

/** The active language's messages. */
export function msg(): Messages {
  return dictionaries[current]
}

/** One message in every language (to recognize an answer whatever language the question was asked in). */
export function inEveryLanguage<K extends keyof Messages>(key: K): Messages[K][] {
  return [zh[key], en[key]]
}
