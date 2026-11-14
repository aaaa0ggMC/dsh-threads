# dsh-threads 详细实施计划

## Context

docs/Plan.md 定了方向：在 DeepSeek Harness（DSH）里做一个插件——主对话当"调度员"，按需开讨论串，每个讨论串是一个真实的子会话，做完把摘要回报主对话。
但 Plan.md 里的接口都写着"写代码前要对照官方源码确认"，参考对象（Claude 的"主对话 + 讨论串"）也没讲清楚原理。
本计划做了三件事：
1. 讲清 Claude 这套机制的原理，并逐条映射到 DSH。
2. 用 DSH 0.2.1-rc.2 桌面版安装包里的源码、一个同类第三方插件（cq-guojia/dsh-task-dispatch-table）确认真实接口。
3. 把 M0–M2 拆到文件级。

已定的三件事：
- **包名**：仓库名叫 `dsh-threads`，npm 用作用域包。`dsh-threads` 在 npm 上已被别人占名。包名暂用 `@fky/dsh-threads`，M0 时确认你的 npm 用户名。2026-10-25 定为 `@kyf-eng/dsh-threads`：`fky` 在 npm 上是别人的组织，作用域改用你的 npm 用户名（和 GitHub 一致）。改名动了 `package.json`、lockfile、`cordis.patch.yml`、浏览器端的面板和样式 ID、README 的卸载命令；存储表 `dsh_threads` 不随包名变，数据不丢。
- **开串权限**：照 Claude 的做法——你点名的任务直接开；模型自己想到的只出提议。
- **批准后的执行范围**：把本计划存为 `docs/IMPLEMENTATION.md`，然后完成 M0。

---

## 一、参考对象的原理：Claude Code 桌面版的"主对话 + 讨论串"

（来源：我当前运行环境里实际拿到的工具和规则。）

**两层委派**
- **子代理**（`Agent` 工具）：本任务的一部分，比如大范围搜索、并行读文件、复核。用户点不进去，结果在本轮内回到主对话。
- **会话**（`start_session` 工具，就是讨论串）：自成一体、能独立交付的任务，比如一个分支或 PR。它是侧栏里真实的一行，用户能点进去接着聊、也能停掉。

**开串时谁说了算**（`initiation` 参数）
- `user_asked`：用户明说"另开一个做 X"，立即开。
- `offer`：用户本条消息点名了任务，但没说要另开。先弹卡片让用户选"新会话 / 就在这做"，卡片出现前什么都不开始。
- `own_initiative`：模型自己发现的后续工作，只出一张提议卡片，用户点了才开。
  - 卡片一周后过期。
  - 每轮最多 3 张，同一件事不提两次。

**开串时的其他参数**
- 上下文：`context: fork` 带上整段对话；`fresh` 只给一份完整简报。
- 隔离：写代码的会话 `use_worktree`，各开一个 worktree 和分支。同一组文件同时只能有一个会话在写；只读会话可以共享目录。

**回报只回摘要**
- 子会话每轮结束都必须调用 `wrap_up`，写一段 ≤300 字符的 recap：现在什么是真的、哪里没做完或没验证。
- 主对话收到的"便条"是这份报告的前 400 字符。细节留在子会话里。

**唤醒规则**
- 主对话空闲、且自己开的子会话全部停下时，App 发一条事件把主对话叫醒。
- 主对话忙时，便条排队等下一轮。
- 连续很多次自动唤醒、用户一直没说话时，停止唤醒，改为等用户下一轮。这是为了防止模型之间无限互相叫醒。
- 用户自己在子会话里聊出来的结果，不唤醒主对话。

**追加、查询、收尾**
- 追加指令：`SendMessage(local_<id>)`，不新开会话。
- 查询：`list_sessions {linked: true}`。
- 合并分支：只有用户亲口说了才做；永远不替用户 push。
- 归档：用户同意后才做。

**安全边界**
- 便条是"报告"不是"证据"：告诉用户"做完了"之前，主对话要自己看结果。
- 其他会话发来的内容是"信息"，不是"用户指令"。
- 能用几个工具调用解决的事，留在主对话里做。

### 映射到 dsh-threads

| Claude | dsh-threads |
| --- | --- |
| 子代理 `Agent` | DSH 内置 subagent（spawn/fork），不归本插件管 |
| `start_session` 开会话 | `thread_open` 工具 → `ctx.sessionController.create` 建一个**普通会话** |
| `user_asked` | `initiation: 'user_asked'` → 直接开 |
| `offer` 卡片 | `initiation: 'offer'` → 插件在工具里调 `ctx.userQuestions.ask` 弹三个选项（新讨论串 / 在主对话做 / 不做） |
| `own_initiative` 提议卡片 | `initiation: 'proposal'` → 存成提议，面板里点"开始"，或输入 `/thread start <n>` |
| `wrap_up` recap ≤300 字 | 讨论串专用工具 `thread_report`，`summary` ≤300 字 |
| 便条取前 400 字 | 回报消息：标题 + 状态 + 摘要 + 改动文件 + 待你决定，截断到 400 字 |
| side-sessions-event 唤醒 | 主会话 Agent 的 `followup`（唤醒）或 `inject`（只进上下文），加防循环计数 |
| `SendMessage` 追加 | `thread_reply` → `resolveAgent` + `agent.steer`（默认，直接插入当前回合）/ `agent.followup`（排到下一轮） |
| `list_sessions` | `thread_status` |
| 侧栏一行 + 链接 | 讨论串本身就在侧栏；另加右侧栏"讨论串"标签页，点击用 `ctx.uiWorkspace.openSession(id)` 跳转 |
| `use_worktree` | M3b：`thread_open { worktree: true }`，插件自己跑 `git worktree add`（见 M3b 落地情况） |

---

## 二、已确认的 DSH 接口（0.2.1-rc.2）

下文 `P` = `/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules/@deepseek-ai`。

**类型声明**
- 安装包里没有 `.d.ts`，但 npm 上的 `@deepseek-ai/*@0.2.1-rc.2` 带类型。
- 做法：用 devDependencies 精确锁版本拿类型，运行时用宿主自带的副本。

### 插件骨架
- **模块**：`export const name / inject / Config / apply(ctx, config)`。
  - `Config` 用 `@deepseek-ai/schemastery` 的 `z`（参考 `P/dsh-tool-ralph/lib/index.js`）。
  - `inject` 里列的服务都是必需的；没列的服务，`ctx.xxx` 一读就抛错。可选服务用 `ctx.get('x')` 读。
- **`package.json`**
  - `"dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web", "inject": [...] } }`
  - exports：`"."`、`"./client"`、`"./cordis.patch.yml"`、`"./locale/*.json"`、`"./package.json"`。插件页靠后两个显示标题和图标。
  - 版本兼容：写了 `engines.dsh` 就只看它；用 `">=0.2.1-rc.2 <0.3.0"`。
- **`cordis.patch.yml`**
  - 写成 `- insert: [{ id, name: '<本包名>', config }]`。
  - 必须有一行的 `name` 是本包名，浏览器那一半才会被发现。
- **安装**
  - CLI 位置：`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`，不在 PATH 上。
  - 命令：`dsh plugin --profile desktop add link:<路径>`。先**完全退出** DSH 再执行。
  - 装好后自动加入 profile 的 bundles。
  - 从 GitHub 安装时，pnpm 11 会拦截 `prepare` 脚本。所以**把 `dist/` 提交进仓库**，不写 `prepare`。
  - 改了代码要重启 DSH，或者在插件页关掉再打开。
- **工具**
  - 定义用 `defineTool`（`@deepseek-ai/dsh-tools`）。它会校验参数；裸的 `tools.register` 不校验。
  - `execute(args, exec)` 里能拿到 `exec.agent`（`id` 就是 session id，另有 `followup/steer/inject/whenIdle`）、`exec.callId`、`exec.signal`。
  - 每个会话单独装工具的写法（参考 `P/dsh-experimental-tool-agent-team/lib/index.js:227-553`）：
    - 先装一遍 `ctx.agents.list()`，再监听 `ctx.on('agent/created')`。
    - 用 `agent.ctx.tools.register(...)` 和 `agent.ctx.systemPrompt.section(...)` 注册。
    - 在 `agent/disposed` 和插件卸载时自己清理。
  - 工具名要加 `thread_` 前缀：启用了 Agent Team（实验性）的 profile 里已有不少全局工具，重名会抛错。
- **斜杠命令**（参考 `P/dsh-command-goal/lib/index.js:174`）
  - 注册：`ctx.commands.register({ definitionId, name, description, input: { hint }, handler })`。
  - `handler` 拿到 `{ agent, rawInput, signal }`，返回 `{ kind: 'success' | 'error', text }`。
- **系统提示**
  - 全局：`ctx.systemPrompt.section({ name, order, text })`。
  - 只给某个会话：用 `agent.ctx.systemPrompt.section(...)`。
- **持久化**
  - `ctx.storageDomain.open(defineDomain({ name: 'dsh_threads', version: 1, layout: 'single', tables: {...} }))`。
  - 文件落在 `~/.dsh/storages/dsh_threads.json`。
  - 名字只能是小写字母、数字和下划线。
- **浏览器 ↔ 宿主**
  - 浏览器调宿主（M0 实机确认）：宿主端在 `ctx.inject(['connection'], …)` 里调 `connection.fetch.register({ path: '/api/dsh-threads', methods: ['POST'], requestBody: 'buffered', fetch })`。浏览器端用相对路径 `fetch('api/dsh-threads', { method: 'POST', body: JSON.stringify({ method, payload }) })`。
  - **不能用 `connection.rpc.handle`**：它要通过调用方自己的 `ctx.webServer` 注册路由，而桌面版的第三方插件看不到 `webServer`。
  - 宿主往浏览器推自定义事件不行（事件是白名单）。会话标题、运行状态、token 浏览器端本来就有，实时可读。

### 讨论串 = 普通会话
- **建会话**：`ctx.sessionController.create({ workspaceId, sessionId, agentPreset })` → `{ sessionId }`。
  - 和用户在界面上点"新会话"走同一条路：自动挂 preset、归入工作区、出现在侧栏。
  - Agent 归会话控制器所有，**插件重载时讨论串不会被销毁**。
  - 不支持写父会话关联，所以"属于哪个主会话"记在插件自己的表里。
- **发任务和追加**：`ctx.sessionController.prompt({ sessionId, content, requestId }, source)` 内部会走 `followup`，但本插件不用它（它把 `source.kind` 写死成 `'user'`）：先用 `resolveAgent` 拿到 Agent，再用 `followup` / `steer` / `inject` 投递，见第五节的「追加指令改为可选 steer / followup」。
  - `agent.followup(message)` = `send(message, 'next-turn', true)`：作为**下一轮**的唯一普通消息，运行中的会话要等这一轮结束才读到。
  - `agent.steer(message)` = `send(message, 'next-step', true)`：运行中的会话在**下一个步边界**读到，空闲的会话直接开一轮。浏览器端输入框的 Ctrl/Cmd+Enter「插话发送」走的是同一件事（`dsh-api-session-controller` 的 `prompt({ mode: 'steer' })` 和 `updateQueue({ kind: 'steer' })`）。队列浮层只列 `inbox['next-turn']`，所以 steer 的消息不会显示成「排队消息」。
  - `agent.inject(message)` = `send(message, 'next-step', false)`：只进上下文，不唤醒。
- **拿 Agent**：`ctx.sessionController.resolveAgent(id)` → `{ agent } | { error }`。冷会话会自动恢复，所以重启后也能用。
- **主会话所在的工作区**：`ctx.workspaceRegistry.list().find(w => w.sessionIds.includes(mainId))`。
- **改标题**：`ctx.sessionTitle.rename(session, title)`。
- **继承审批模式**（对应 Plan.md 第 6 条）
  - 新会话默认被钉成**用户默认** preset，不是主会话当前的 preset。
  - 所以建好后要执行 `ctx.permissionPresets.set(thread.session, ctx.permissionPresets.current(main.session))`。
- **判断完成**
  - 全局监听 `ctx.on('agent/status', ({ agent, status }) => …)`，只看讨论串 id 变成 `idle`。
  - 不能用 `turn/end`：它只代表一轮结束，开了 `/goal` 还会自动续跑。
- **读最终回复**
  - 发任务前记下 `agent.session.seq`；完成后取 `agent.session.snapshotEvents(start)`，交给 `finalAssistantOutput(events)`（`@deepseek-ai/dsh-subagent` 导出）。
  - 结束原因：`foldConsumedWork(events).end?.data.reason.kind`（`@deepseek-ai/dsh-agent` 导出）。
- **唤醒主会话**（照抄 `P/dsh-subagent/lib/index.js:2048` notifySettlement）
  - 消息用 `createUserMessage({ content, source: { kind: 'dsh-threads', form: 'notice', summary } })` 建，来自 `@deepseek-ai/dsh-llm`。
  - 发送：`followup`（唤醒）或 `inject`（只进上下文）。`form: 'notice'` 在聊天界面里显示成紧凑提示。
- **token**：`ctx.sessionProjections.stateOf(session, 'tokenUsage').totals`。
- **弹选择题**（`offer` 用）
  - `ctx.userQuestions.ask({ questions: [{ id, question, header, options }], agent: exec.agent, signal: exec.signal, wait: { callId: exec.callId } })`。
  - 不走 approval 服务：approval 的结果受部署的权限模式影响（full-access 或被改过的安装会直接放行），而开串确认要的是用户每次亲自选择。
- **worktree**（M3）
  - `ctx.worktrees.create(agent, { name })` 建在 `<仓库根>/.agents/worktrees/<name>`，并自动切换工作目录。
  - **没有删除接口**，未提交的文件不会带过去。
  - **桌面版默认没装**：它来自 `@deepseek-ai/dsh-experimental-tool-worktree` 这个 bundle，desktop profile 的 bundles 里没有它。所以 M3b 不用它，自己跑 git。
  - 切工作目录用 `ctx.workingDirectory.set(agent, path)`（`dsh-working-directory`）：会记一条 `working-directory/change` 事件，并给会话塞一条"工作目录变了"的提示。

**为什么不用官方子代理（`ctx.subagents.startActivation`）**
- 它的好处：白送"标题栏子代理树"和自动回报。
- 它的问题：
  - 讨论串只能从主会话标题栏进，不在侧栏；
  - 用户给讨论串发消息时，主会话的 Agent 必须活着；
  - 审批被钉成 `never`，改代码的讨论串一遇到审批就失败；
  - 最多 8 个。

  这些和 Plan.md 要的"真实子会话、点进去接着聊"不符。

### ⚠️ 审批相关的测试要用干净的 DSH
- 有些社区插件会直接改 DSH 安装包里的官方文件，例如让 `dsh-user-approval` 的 `decide()` 恒返回"允许"、关闭沙箱。这种改动和会话选哪个模式、哪个 profile 都无关。
- 做法：
  - 开串、回报、唤醒、面板照常在自己的桌面版上开发和测试；日常测试新开会话时选标准模式，测到的调度提示更接近普通用户的环境。
  - "讨论串继承审批模式、不偷偷提权"这一项验收，在一套**隔离的官方 DSH** 上做：用 npm 上的 `@deepseek-ai/dsh@0.2.1-rc.2`，配一个单独的 `DSH_HOME`。它不读 `~/.dsh`，也不碰 App 安装包（命令见第六节第 8 条）。
  - 插件自己的开串确认用 `userQuestions`，不依赖 approval。

---

## 三、架构

```
主会话 ──thread_open / thread_reply / thread_status──▶ ThreadManager ──sessionController.create/prompt──▶ 讨论串会话
   ▲                                                       │                                        │
   │ followup(notice) / inject(notice)                     │ storageDomain: dsh_threads              │ thread_report 工具
   └───────────── Delivery（唤醒规则 + 防循环） ◀── settle ◀─┴──── agent/status idle ◀────────────────┘
浏览器：右侧栏"讨论串"标签 ──rpc──▶ list / startProposal / dismissProposal / stop
```

**数据表**（`dsh_threads` 域）
- `threads`（键是讨论串 sessionId）字段：
  - `mainSessionId`、`n`（同一主会话里的序号）、`title`、`task`、`initiation`
  - `status`：`starting | running | idle | failed | archived`
  - `lastReport`：`{ status, summary, changedFiles, decisions, at }`
  - `error`：这一轮为什么失败（`failed` 时有值），`thread_status` 的详情里显示成「错误：…」
  - `startSeq`、`createdAt`、`updatedAt`
- `proposals`（键是 uuid）：`mainSessionId`、`title`、`task`、`createdAt`、`expiresAt`、`state`。
- `mains`（键是主会话 sessionId）：`autoWakeStreak`、`pendingNotes[]`。

**主对话的工具**（只装在"非讨论串、非 subagent"的根会话上，讨论串里不能再开讨论串）
- `thread_open { title, task, initiation: 'user_asked' | 'offer' | 'proposal' }`
  - 返回讨论串序号和 id，或者提议的序号。
  - 超过并发上限时直接报错，告诉模型等某个讨论串结束。
- `thread_status { n? }`：列出本主会话的讨论串和提议，或返回一个讨论串的最新回报。
- `thread_reply { n, message, mode? }`：给讨论串追加指令。`mode: 'steer'`（默认）直接插进它正在做的事：运行中的讨论串在下一步就读到，不用等这一轮结束；`mode: 'followup'` 则排成它自己的下一轮，当前这一轮结束后才开始。空闲的讨论串两种都立刻开一轮。
- `thread_mark { n, action: 'resolve' | 'reopen' | 'archive' | 'unarchive' }`：按 #n 标记已解决 / 重新打开、归档 / 取消归档（原来只有用户能在浏览器面板里做）。`resolve` 只改记录状态（不碰会话、不发通知，用户在它里面发消息会重新打开）；`archive` / `unarchive` 走 `setArchived`，在 DSH 里归档 / 取消归档会话。运行中归档被拒绝，要求先停止；重复标记幂等。

**讨论串的工具**
- `thread_report { status: 'done' | 'blocked' | 'needs_decision' | 'failed', summary (≤300 字), changedFiles?, decisions? }`
  - 工具描述写死："本轮回复结束前必须调用一次"。
  - 可以重复调用，以最后一次为准。

**回报怎么形成（settle）**
- 讨论串变成 `idle` 时：
  - 先取本轮的 `thread_report`；
  - 没有就用 `finalAssistantOutput` 兜底，并标注"未提交回报"；
  - 拼成便条，截断到 `noteMaxChars`，放进该主会话的 `pendingNotes`。
- **这一轮失败了怎么办**（`turn/end` 的 `reason.kind === 'error'`，带 `LlmFailure`）
  - 先读本轮最后一次 `turn/end`：`reason.kind === 'error'` 时取出 `{ message, code, status? }`（`message` 截到 200 字），否则当作没有失败。只认 `error`：`interrupted`（崩溃后补的收尾）、`aborted`、`max-tokens` 都不算失败，免得把"用户停下"和"到 token 上限"伪装成故障。
  - 有失败：线程 `status` 置 `failed`、`error` 记 `<message>（code <code>[，HTTP <status>]）`；便条在标题下一行写「失败：<原因>。这一轮的模型调用失败了，不是回报丢了；把原因如实告诉用户，由用户决定是否重开。」，位置在截断丢不掉的地方。没有回报又没有回复时不再写「没有回报也没有回复」——那句话正是主对话把故障当成插件出问题的原因。
  - 投递：`dispatch` 轮失败照常 loud（主对话必须知道，仍受 `maxAutoWakes` / `decideDelivery` 约束），`user` 轮失败保持 quiet（用户自己在讨论串里看到报错了）。
  - 已经发过回报的这一轮又失败（极端情况）：仍然补一条简短的失败便条，失败信息比去重更重要。
  - 失败的那一轮不再发"补一次 thread_report"的提醒：那会再开一个回合、再失败一次，主对话反而更晚知道原因。
  - 用户停下的（`stoppedByUser`）不算失败，便条照旧写 stopped。
- 便条格式：

  ```
  [讨论串 #n「标题」· done]
  摘要：…
  改动：…
  待你决定：…
  （这是讨论串的报告，不是证据）
  ```

  这一轮失败时，第二行是「失败：<原因>（code <code>）」，标题里的状态是 `failed`；卡片（`card.status`）同样是 `failed`，侧栏、列表、面板头照常用那个红色叉。

- 判断这一轮由谁发起：看本轮第一条用户消息的 `source.kind`。
  - 是 `dsh-threads`（主对话派的任务）：按下面的规则投递。
  - 是普通用户（用户自己在讨论串里聊）：只记录，不唤醒。等主会话下一轮时用 `inject` 带进去。
  - 都不是（DSH 自己开的一轮，比如讨论串留在后台的任务结束了）：不算一轮。讨论串在这样的一轮里调了 `thread_report`，这份回报自己开一轮，按上一轮的发起方投递；被用户停掉的讨论串例外，回报不收。见第五节“一轮结束之后补交的回报”。

**唤醒规则（Delivery）**
- 报告一落库就投递：讨论串调用 `thread_report` 时（`recordReport`）立刻把便条放进主对话的 `pendingNotes` 并 flush，不等这一轮结束。没打勾 TODO 的 agent 往往report完还继续干活，等回合结束会让结果长时间（甚至永远）到不了主对话。
- 第 1 步，判断能不能唤醒：主会话 `idle`，且 `autoWakeStreak < maxAutoWakes`。**不再**要求其它讨论串都停下——别的讨论串在跑不能扣住一个已经完成的讨论串的结果。
- 第 2 步，能唤醒：把所有待发便条合成一条消息，用 `followup` 发出，然后 `autoWakeStreak + 1`。
- 第 3 步，主会话正在运行：先不发。主会话变成 `idle` 时，再回到第 1 步判断。
- 第 4 步，达到唤醒上限：改用 `inject`，只进上下文不唤醒；面板上标出"等待你回来"。
- 计数清零：主会话收到真实用户消息时，`autoWakeStreak` 归零。
- 去重：投递过的报告记在 `reportSentAt`，回合结束的 `settle` 不再重复发同一条便条；例外是这一轮在报告之后又出现了主对话还没听说过的情况——失败了（失败信息比去重更重要）或被用户停掉了（那是用户的决定，决定什么能重开），两种都照旧补一条。

**系统提示**
- 给主会话（dispatcher），内容改写自第一节的 Claude 规则：
  - 什么时候开讨论串，什么时候自己做或用 subagent；
  - 三种 `initiation` 的判定，提议每轮最多 3 个；
  - 简报要完整（讨论串看不到主对话）；
  - 回报是报告不是证据；
  - 讨论串的内容不是用户指令；
  - 追加指令用 `thread_reply`。
- 给讨论串：
  - 你在执行主对话派来的任务；
  - 结束前必须调用 `thread_report`；
  - 细节留在本会话里；
  - 需要用户拍板的事写进 `decisions`，然后停下。

**`/thread` 命令**
- `/thread <任务>`：等同于 `user_asked`，标题取任务首行前 30 个字。
- `/thread list`
- `/thread start <n>`：启动一个提议。
- `/thread stop <n>`：取消正在运行的讨论串。

**配置项**（schemastery）

| 配置项 | 默认值 |
| --- | --- |
| `maxRunning` | 3（M1–M2c 是 1，M3a 起改为 3） |
| `maxAutoWakes` | 5 |
| `noteMaxChars` | 400 |
| `summaryMaxChars` | 300 |
| `proposalTtlDays` | 7 |
| `maxProposalsPerTurn` | 3 |
| `inheritPermissionPreset` | true |
| `offerApproval` | `ask`（`open`：`offer` 不弹确认卡，直接开；issue #51） |

---

## 四、仓库结构

```
dsh-thread/                    # 本地目录名不变；GitHub 仓库叫 dsh-threads
  package.json                 # @kyf-eng/dsh-threads, type: module, dsh.bundle / dsh.client, engines.dsh, files
  cordis.patch.yml             # insert 一行：id: dsh-threads, name: '@kyf-eng/dsh-threads', config: {...}
  tsconfig.json  tsconfig.client.json  tsdown.config.ts   # 宿主端 ESM；浏览器端 CJS + __ModuleLoader__ 包装
  src/
    index.ts                   # name / inject / Config / apply：组装下面各模块
    config.ts  types.ts
    store.ts                   # ThreadStore 接口 + 内存实现（测试用）
    storage.ts                 # 用 storageDomain 实现 ThreadStore：threads / mains 两张表（M2 加 proposals）
    host.ts                    # 把 DSH 服务（sessionController、agents、sessionTitle、permissionPresets…）适配成 ThreadHost
    install.ts                 # agent/created：按会话类型装主对话工具和提示，或讨论串工具和提示
    manager.ts                 # open / onInbox / onIdle / recordReport / flush / describe（M2 加 reply / stop / startProposal）
    report.ts                  # 便条拼装、截断、finalAssistantOutput 兜底
    delivery.ts                # 唤醒规则 + 防循环（纯函数）
    prompts.ts                 # 主对话和讨论串的系统提示
    tools/{thread-open,thread-status,thread-report}.ts   # M2 加 thread-reply
    command.ts                 # /thread
    services.ts  dsh-types.ts  source.ts   # 可选服务读取、类型声明加载、消息来源类型
    rpc.ts                     # POST /api/dsh-threads {method,payload}：list / startProposal / dismissProposal / stop
    client/index.tsx  client/ThreadsTab.tsx  client/locale.ts
  locale/en.json  locale/zh.json   # { meta: { title, description } }
  tests/                       # vitest：store、delivery 规则、report、状态机，ctx 用假对象
  docs/Plan.md  docs/IMPLEMENTATION.md
  CLAUDE.md  README.md  README.en.md  LICENSE  CHANGELOG.md  .gitignore
```

**依赖**
- devDependencies，精确锁 `0.2.1-rc.2`：
  - DSH 包：`@deepseek-ai/{cordis,dsh-tools,dsh-llm,dsh-agent,dsh-subagent,dsh-storage-domain,dsh-commands,dsh-api-session-controller}`
  - 校验库：`@deepseek-ai/schemastery@3.18.x`
  - 构建和测试：`typescript`、`tsdown`、`vitest`、`react@18.3.1`、`@types/react@18`
- 运行时：全部用宿主自带的副本，打包时标成 external，不打进 `dist/`。

---

## 五、里程碑（文件级）

### M0 骨架与接口验证（本次批准后完成）
1. 把本计划存为 `docs/IMPLEMENTATION.md`，在 `docs/Plan.md` 里修正四处：
   - `--profile web` 改成 `desktop`；
   - 写明 npm 名字被占；
   - 写明安装包不带 `.d.ts`；
   - 写明审批相关的测试要用干净的 DSH。
2. 在本地执行 `git init`，分支为 `main`，写好 `.gitignore`。**`dist/` 不忽略。**
   - 建 GitHub 远程仓库、首次 push 之前，先问你。
3. 写 `package.json`、两个 tsconfig、`tsdown.config.ts`、`cordis.patch.yml`、`locale/*.json`、`CLAUDE.md`（项目约定）。
4. `src/index.ts` 注册一个占位工具 `thread_status`，固定返回 `"dsh-threads ok"`；`src/client/index.tsx` 注册一个空的右侧栏"讨论串"标签页。
5. **接口验证（spike）**，每项写明结论和退路：
   - (a) 用 `link:` 装上的插件，运行时能不能 import 宿主的 `@deepseek-ai/dsh-llm`、`dsh-subagent`、`dsh-tools`、`dsh-storage-domain`。
     - 背景：profile 设置了 `autoInstallPeers: false` 和 `nodeLinker: hoisted`。
     - 退路：改成 dependencies 并精确锁版本。
   - (b) 第三方插件能不能 `inject` 到 `sessionController`；`create` 和 `prompt` 能不能接受自定义 `source.kind`。
     - 退路：改用 `ctx.agents.create({ sessionId, meta: { cwd, agentPreset, parentSession } })`，不传 `parentAgent`。
   - (c) 浏览器端的包装格式能不能加载，右侧栏标签页能不能出现。
   - (d) 浏览器 ↔ 宿主 RPC 能不能用（结论：用 `connection.fetch.register`，不用 `rpc.handle`）。
   - (e) `sessionController` 建的会话会不会触发 `agent/created`，从而能按会话单独装工具。
6. 构建脚本：`npm run build / typecheck / test`，再加一个 `scripts/dev-install.sh`，执行 `dsh plugin --profile desktop add link:$PWD`，并提示先退出 DSH。

**完成标准**
- 插件页里显示 dsh-threads 的标题和图标。
- 新会话的工具列表里有 `thread_status`。
- 右侧栏有"讨论串"标签。
- 接口验证 (a)–(e) 都有结论，写进 `docs/IMPLEMENTATION.md`。

#### M0 接口验证结论（2026-10-23）

"代码确认"= 读了 DSH 源码；"实机"= 在桌面版里跑过。

| 项 | 结论 | 依据 | 状态 |
| --- | --- | --- | --- |
| (a) 运行时 import 宿主的 `@deepseek-ai/*` | 可以。`link:` 装的目录走"按 peer 查找"：本包 `peerDependencies` 里列出的名字用宿主那份，其他名字才用本地 `node_modules`。所以运行时要 import 的包**必须同时写进 peerDependencies**（现在是 cordis、dsh-llm、dsh-tools、schemastery），打包时一律不打进去。 | `dsh-app-boot/README.md` "Linked directories" 一条 | **实机通过**：插件加载，`defineTool`、`createUserMessage` 都能用 |
| (b) `sessionController` 建会话、发任务 | 建会话用 `ctx.sessionController.create({ workspaceId, sessionId: 'session-<uuid>' })`，返回 `agentPreset: 'standard'`。**发任务不能用 `ctx.sessionController.prompt`**：这个对外接口把 `source.kind` 写死成 `'user'`。改成 `resolveAgent(id)` 拿到 Agent，再 `agent.followup(createUserMessage({ source: { kind: 'dsh-threads', form: 'notice', summary } }))`。`summary` 最长 120 字（`boundContextSummary`）。来源类型通过给 `@deepseek-ai/dsh-llm` 的 `MessageSourceMap` 加声明来扩展（`src/source.ts`）。 | `dsh-api-session-controller/lib/index.js:3218`；`dsh-llm` 的 `message.d.ts` | **实机通过**：侧栏出现新会话 "dsh-threads probe"（改名生效），任务显示成一行提示"收到执行请求"，模型回复 OK。注意提示行显示的是通用文案，不是我们的 `summary`，M1 再看要不要换 `form`。 |
| (c) 浏览器端打包格式 | tsdown 输出 CJS，加 banner/footer 包成 `window.__ModuleLoader__.load({ id, factory })`。产物和官方 `lib/client.js` 同构，react 和 `@deepseek-ai/*` 都不打进去。 | `dist/client.js` 头尾；对照 `dsh-client-ui-goal/lib/client.js` | **实机通过**：右侧栏引导页出现入口，标签页能渲染，并拿到当前会话 id。入口显示英文 "Threads"，因为 Electron 的 `navigator.language` 是 en-US；M2 改用 `ctx.locale` |
| (d) 浏览器 ↔ 宿主 RPC | `connection.rpc.handle` **在桌面版用不了**：它通过调用方的 `ctx.webServer` 注册，第三方插件 inject 不到 `webServer`，回调不执行，浏览器拿到 HTTP 405。改用 `connection.fetch.register`，路径 `/api/dsh-threads`，只接受 POST，`{ method, payload }` 由 `dispatchRpc` 分发；浏览器端用相对路径 `fetch('api/dsh-threads')`。桌面版的 `dsh-app://app/*` 会带 cookie 转发给宿主。 | `dsh-client-connection/lib/index.js:723-745, 816-870`；`app/lib/main.js:12455` | **实机通过**：标签页里 `host RPC: {"ok":true,…,"pings":1}` |
| (e) 新会话触发 `agent/created` | 会触发。用户新建的会话和 `sessionController.create` 建的会话，`source` 都是 `'startup'`；重启后恢复的旧会话是 `'resume'`。 | `thread_status` 的 `agentCreated.recent` | **实机通过** |

**M0 实机测试时踩到的坑：DSH 实验性检查器会把宿主整个搞崩**
- 现象：装上插件后宿主崩溃，报错 `inspector: source state exceeds the source-frame byte limit`（dsh-experimental-inspector，`lib/index.js:996`）。
- 原因：检查器先把插件树快照裁到 `maxSourceFrameBytes − 4KB`，写入时又按"全部状态 + 4KB ≤ 上限"再检查一遍，落进夹缝就抛错，没人接住，宿主退出。插件多的 profile 插件树本来就大，新插件多出的几个节点就可能把它推进夹缝。和我们的代码无关，多开会话、再装别的插件也会触发。
- 规避：在 profile 的 `cordis.patch.yml`（桌面版是 `~/.dsh/profiles/desktop/cordis.patch.yml`）末尾加下面一段，把检查器的单帧上限调到 1MB。按 DSH 规则这是整段替换，所以 `captureFetch: true` 要一起写上。树最多 2048 个节点，约 180KB，碰不到新上限；删掉这一段即可还原。
  ```yaml
  - id: experimental-inspector
    config:
      captureFetch: true
      maxSourceFrameBytes: 1048576
  ```
- 对 README 的影响：发布时要提醒用户，如果开着"开发者工具"（实验性检查器）又遇到这个崩溃，按上面的方法处理。**不要**点崩溃对话框里的"禁用第三方插件"，那会把所有第三方插件一起禁掉。

其他已落地的事实：
- npm 未登录，包名暂用 `@fky/dsh-threads`。
- vitest 5 需要单独装 `vite`。
- `.npmrc` 设了 `legacy-peer-deps=true`：DSH 的包对很多官方包写了精确版本的 peer 依赖，不加这一行 npm 会全装一遍。
- `dsh plugin add link:` 会报 "linked in dependency will not resolve the peer dependencies" 的警告。这是 pnpm 的提示，DSH 自己的运行时解析会处理，见 (a)。

### M1 单个讨论串闭环
- 依次写 `store.ts`、`manager.ts`（open/settle）、`report.ts`、`delivery.ts`、`install.ts`、`prompts.ts`，再写四个工具和 `/thread <任务>`。
- 打通两条路径：
  - `user_asked`：直接开；
  - `offer`：先弹 `userQuestions`。
- 讨论串继承主会话的审批模式，`maxRunning = 1`。
- 单元测试覆盖：
  - 唤醒规则的四种情况；
  - 防循环；
  - 便条截断；
  - 没有 `thread_report` 时的兜底；
  - 状态机。

**完成标准**：对主对话说一个任务，它开出讨论串；讨论串结束后调用 `thread_report`；主对话被唤醒，收到不超过 400 字的便条。

#### M1 落地情况（2026-10-23，分支 `feat/thread-open`）

范围上的取舍：
- M1 实现了 `thread_open`、`thread_status`、`thread_report` 三个工具和 `/thread <任务>` 命令。`thread_reply` 按 M2 的安排放到 M2。
- `initiation` 只开放 `user_asked` 和 `offer` 两种。模型自己想到的后续工作，提示词要求它"在回复里提一句、让用户决定"，不调用工具。`proposal` 留到 M2。
- 重启后的恢复（重新挂上运行中讨论串的状态监听）留到 M2。

实现上和计划不同的地方：
- **讨论串会话**：用 `sessionController.create` 建，再用 `resolveAgent` + `followup` 发简报，消息来源标记为 `dsh-threads`。"这一轮是谁发起的"由插件自己记录：主对话派的任务记 `dispatch`；讨论串空闲时收到用户消息，记 `user`。
- **工具和提示按会话挂载**：
  - 普通会话装 `thread_open`、`thread_status` 和调度员提示；
  - 讨论串装 `thread_report` 和讨论串提示；
  - 子代理和 Agent Team 成员（`origin: 'subagent'`）什么都不装。
- **存储**：拆成 `store.ts`（接口和内存实现）和 `storage.ts`（基于 storageDomain 的实现），这样单元测试不用加载 DSH 的存储包。

实机测试（本机桌面版，标准模式）：

| 路径 | 结果 |
| --- | --- |
| 用户说"开个讨论串：…" | 模型选 `user_asked` 调用 `thread_open`，侧栏出现"#1 …"。讨论串调用 `thread_report`（done）后，主对话被自动唤醒，并按"报告不是证据"自己复核了一遍。✅ |
| `/thread <任务>` | 立即开出 #2。这次讨论串**没调用** `thread_report`，兜底把它最后一条回复写进便条，主对话照常被唤醒。✅（兜底生效） |
| 加强措辞后再次 `/thread` | 讨论串的系统提示、工具描述、任务简报三处都改成"主对话只能收到 thread_report，结束前必须调用"。#3 主动回报了 done。✅ |
| `offer` | 弹出"要为「…」开一个讨论串吗？"卡片，三个选项加自定义输入。选"在主对话里做"后没有新建会话，主对话自己完成了任务。✅ |
| 防循环计数 | 两次自动唤醒后用户发了一条消息，`autoWakeStreak` 清零；之后再唤醒一次，计为 1。✅ |

还没在实机上覆盖的（已有单元测试）：
- 主对话忙时先压住便条、空闲后再送达；
- 用户在讨论串里自己聊出来的结果只进上下文、不唤醒；
- 超过 `maxRunning` 时拒绝；
- 建会话失败时把讨论串标记为 failed。

审批继承要在隔离的官方 DSH 上验收（第六节第 8 条），这次还没做。

### M2（2026-10-23 重排）：Claude 式「项目」界面

原来的 M2（侧栏列表 + 追加 + 提议 + 恢复）按用户要求改成和 Claude 原版一致的项目体验，拆成三个 PR。

**项目是什么（已确认）**
- **一个项目 = 一个本地文件夹（DSH 工作区）+ 一个常驻主对话**，有名字、置顶、项目说明。点项目直接进它的主对话。
- 讨论串只属于项目：
  - 只有项目主对话会装 `thread_open` / `thread_reply` / `thread_status` 和调度员提示，普通会话什么都不装；
  - 项目说明作为系统提示段，加给主对话和它所有的讨论串。

**界面扩展点**（`R` = `app/dsh/node_modules/@deepseek-ai`；所有插槽的类型、作用域和属性见 `R/dsh-cordis-client-runner/lib/client.js:2434` 的 `CLIENT_SLOT_API`）

| 需求 | 做法 | 参照 |
| --- | --- | --- |
| 左侧"项目"入口和项目页 | 侧栏入口插槽 `sidebar.panellist`（order 20）+ 整页面板插槽 `main`；进主对话用 `ctx.uiWorkspace.openSession`，回项目页用 `ctx.layout.selectPanel` | `R/dsh-client-ui-schedule/lib/client.js:7473-7490` |
| 置顶 | 项目记录存在插件表里，置顶时同时 `ctx.workspaces.pinSession(main)` | ui-workspace-controller 381-437 |
| 右侧讨论串面板（M2b） | 注册自己的资源协议 `dsh-threads` 和标签页；正文是 `SessionProvider` 包住 `renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active' })`。**不复用 `subagentchat`** | `R/dsh-client-ui-subagent/lib/client.js:699-839` |
| 回报渲染成讨论串卡片（M2c） | `ctx.uiConversation.events.register` 注册独占的事件解释器，把我们的消息变成自己的节点类型，再用 `conversation.chat.node` 渲染 | `R/dsh-client-ui-user-questions/lib/client.js:1349-1402` |
| "N 条回复"（M2c） | 按轮建事件解释器，把本轮 `thread_open` 打开的讨论串发布成轮数据，用 `conversation.chat.turnTail` 显示在这一轮的末尾 | schedule 2301-2358 |
| 提议卡片（M2c） | 输入框上方的 `conversation.input.dock` | goal 604-651 |
| 已解决后锁输入框（M2b） | `conversation.composer` 插槽链里加一个条目 | user-questions 1905-1925 |
| 左侧会话列表 | 不能把讨论串折叠或隐藏到主对话下；只能加小标记（`sidebar.session.row.leading`）、悬停卡片（`row.hover`）、菜单项（`session.menu.item`）。M2c 只做了小标记 | ui-workspace 964-974、2254-2368 |

**排期**
- **M2a（PR `feat/projects`）**：项目骨架、`thread_reply`、重启恢复、左侧"项目"入口和项目页、"设为项目"菜单。
- **M2b**：右侧讨论串面板（内嵌对话 + 输入框）、"标记已解决 / 重新打开"、主对话标题栏"讨论串 · N"。
- **M2c**：回报卡片、"N 条回复"、`thread_propose` + 提议卡片（超过上限的排队，空出名额时自动开始）、左侧标记。

#### M2a 落地情况（2026-10-23）

宿主端：
- 新增 `projects.ts`（新建、改名、置顶、移除、列表统计）和 `projects` 表；新字段都带默认值，M1 的旧记录照常能读。
- `install.ts` 按角色挂载（`roles.ts`）：项目主对话 = dispatcher，讨论串 = thread，其他 = none；项目变动后，正在运行的会话会重新计算角色。
- 新增 `thread_reply`：讨论串空闲时开新一轮；正在跑时排到下一轮，结果按唤醒规则回报。（2026-11-04 改成默认 `steer` 直接插入当前回合，见下面的「追加指令改为可选 steer / followup」。）
- 新增 `recover()`：启动时把 `starting` 的讨论串标记为 failed；`running` 的用 `resolveAgent` 拿回 Agent，空闲就结算；待发的便条重新投递。
- `api.ts` 提供 `projects.*`、`sessions.role`、`threads.list`。

浏览器端：
- 左侧"项目"入口；
- 项目页：卡片、搜索、排序、置顶、移除确认；
- 新建项目对话框：名字、选工作区、项目说明；
- 会话菜单里的"设为项目"；
- 文案走 `ctx.locale`，样式用 `--dsw-alias-*` 主题变量；
- 公共组件用宿主共享的 `@deepseek-ai/dsh-client-ui-primitives`（`Button`、`Modal`、`MenuItemButton`）。

实机测试（桌面版，标准模式）全部通过：
- 左侧出现"项目"，项目页和空状态正常。
- 新建项目后直接打开它的主对话。主对话发出第一条消息后，标题变成项目名。
- 项目主对话里开讨论串（编号按项目从 #1 开始），做完唤醒主对话。
- 普通会话里 `/thread` 被拦下，并提示"先设为项目"。
- `thread_reply` 把追加任务发给了原来的 #1：开了新一轮、交了回报、主对话被唤醒。
- 重启恢复：在讨论串运行 `sleep 40` 时退出 DSH，再打开后，恢复逻辑结算了被中断的那一轮（无回报，用兜底），主对话被唤醒并自己重派了任务。
- 置顶后，卡片出现图钉，左侧列表里主对话移到最前。
- "设为项目"会把已有会话（连同它在 M1 开过的 3 个讨论串）变成项目；移除项目后会话仍保留。
- 没有新的崩溃日志。

注意：退出 DSH 时如果有任务在跑，会弹"当前正在运行的任务将会中断"的确认框；脚本里的 `quit` 会被它拦住。

#### M2b 落地情况（2026-10-23，分支 `feat/thread-pane`）

右侧讨论串面板：
- 资源协议 `dsh-threads`（`dsh-resource://dsh-threads/session/<id>`），打开时用 `sessions.retain(id, { source: 'dshThreads' })` 持有会话，标签页关掉才释放。
- 标签类型 `dsh-threads.chat`：
  - 正文 = 头部 + `SessionProvider` 包住自己声明的会话作用域子插槽 `dsh-threads.chat.conversation`，子插槽里是 `renderFactorySlot('conversation.content', { variant: 'embedded' })`，照抄 ui-subagent 的 `SidebarChatTab` / `ConversationSlotPanel`；
  - 不显示空白会话的开场页，避免出现工作区选择器。
- 头部：状态点、`#n 标题`、项目名、"标记已解决 / 重新打开"、"在主区域打开"。
- 原来的占位标签页换成"讨论串"列表（kind `dsh-threads`，引导页可进）：列出项目主对话的讨论串（状态点、最新摘要、时间、已解决标记），点击在右侧打开对话。
- 主对话标题栏（`conversation.session.header.actions`，order 15）：项目主对话显示"讨论串 · N（· M 个运行中）"，点击打开列表；讨论串显示"回到主对话"。

已解决锁定：
- 宿主端新增 `manager.setResolved`，接口 `threads.get` / `threads.resolve` / `threads.reopen` / `threads.resolved`。
- 浏览器端给每个已解决的讨论串发布一个低优先级的待处理交互（`ctx.uiSession.registerPendingInteraction`，kind `dsh-threads-resolved`）；输入框插槽链 `conversation.composer` 看到它就换成 `ResolvedComposer`（"此讨论串已解决 · 重新打开"）。
- 左侧列表只显示审批、计划确认、提问这三种待处理状态，所以不会多出标记。
- 有会话开始或结束运行、或者本浏览器标记 / 重开之后，重新同步已解决列表。

实机测试（桌面版，后台操作，没有接管屏幕）全部通过：
- 项目主对话标题栏显示"讨论串 · 1"，点击打开右侧列表。
- 点列表里的 #1，右侧打开它的实时对话，自带输入框。
- 在右侧直接给讨论串发消息：讨论串完成并回报；主对话没有被唤醒，唤醒计数也没增加，结果只进了上下文。
- "标记已解决"后，输入框换成锁定栏；"重新打开"后恢复。左侧列表没有多余标记。
- "在主区域打开"让讨论串占据中间区域，标题栏出现"回到主对话"；点回去后，主对话的右侧标签（列表 + #1）都还在。
- 没有新的崩溃日志。

#### M2c 落地情况（2026-10-23，分支 `feat/thread-cards`）

主对话里的卡片：
- 我们发进收件箱的每条消息（简报、追加、回报）在来源上带 `role`、`threads`（`threadId`、`n`、`title`，回报还有状态和摘要）和 `wake`（会唤醒的投递：`followup` / `steer` 为 true，`inject` 为 false）。
- 浏览器端用 `ctx.uiConversation.events.register` 注册 `noticeDefinition`：独占匹配 `source.kind === 'dsh-threads'` 的 `user/message`，生成节点 `dsh-threads-notice`，`conversation.chat.node` 渲染成卡片：
  - 回报："讨论串回报（N）"，每个讨论串一行：状态点、`#n 标题 · 状态`、摘要（去掉 markdown 标记）、"查看讨论串"；
  - 简报和追加："来自主对话的任务 / 追加指令 · #n 标题"，正文折叠显示。
- **踩到的坑**：没有 `groupTree` 的节点在已结束的轮里会被过滤掉（`dsh-client-ui-chat` 的 client.js:188），第一版卡片因此看不见。现在照 Chat 自己的 turn-trigger：`wake` 的消息设 `groupTree: 'input'`（坐在这一轮的输入位置），其他设 `'turn'`。M2c 之前的旧消息没有这些字段，显示成通用卡片。
- "N 条回复"：`openedDefinition` 按轮收集 `thread_open` 的工具结果（`presentationMeta` 带 `{ threadId, n, title }`），用 `buildLocationData` 发布成轮数据；`conversation.chat.turnTail`（order 25）在这一轮末尾显示"N 条回复"，每行的状态实时取 `threads.list`。没有用小数 `anchorSeq`，因为 turnTail 更稳，也不会和正文抢位置。

提议：
- 新工具 `thread_propose { items: [{ title, task }] }`，只装给项目主对话；调度员提示改成"自己想到的事用 `thread_propose`，不要直接开"。
- 提议存在 `proposals` 表：每次最多 `maxProposalsPerTurn`（3）个，`proposalTtlDays`（7）天后过期。
- 输入框上方的 `conversation.input.dock`（order 15）显示勾选卡片："都不要" / "开始 N 个讨论串"。点开始走 `proposals.start`：先全部标成 `queued`，再在 `maxRunning` 以内依次开；排不上的显示"排队中：有讨论串结束后自动开始"。
- 讨论串结束时**先开排队的提议，再投递回报**：这样这条回报会等排队的那个也做完，主对话一次收到整批，而不是每个讨论串各唤醒一次。

左侧标记：`sidebar.session.row.leading` 给讨论串行加讨论串图标、给项目主对话加项目图标（`sessions.kinds` 接口）。悬停卡片没做。

实机测试（桌面版，接管屏幕）全部通过：
- 回报显示成"讨论串回报（1）· 已完成"卡片，"查看讨论串"在右侧打开它。
- 用户消息那一轮末尾出现"1 条回复"，状态点跟着讨论串变化。
- 讨论串面板里的第一条是"来自主对话的任务 · #2 …"卡片。
- 左侧讨论串行和主对话行有各自的图标。
- 提议：主对话调 `thread_propose` 提两个，输入框上方出现勾选卡片；点"开始 2 个讨论串"，第一个立即开，第二个显示"排队中"，第一个结束后自动开始。
- 第一轮测试发现两条回报分两次唤醒了主对话（第一个结束时第二个还没开）；改成先开排队再投递后重测：第一个的回报等到第二个结束，主对话只被唤醒一次，卡片是"讨论串回报（2）"。
- 没有新的崩溃日志。

已知问题：DeepSeek Flash 经常不调 `thread_report`（这次 3 个里有 2 个没调），卡片显示"没有回报"，内容来自兜底的最后一条回复。之后考虑在没回报时提醒讨论串补一次。

### M3 并行与隔离；M4 发布

#### M3a 并行（2026-10-23，分支 `feat/parallel-threads`）

照 Claude 的做法：多个讨论串共用项目文件夹同时跑，靠规则避免冲突，worktree 留到 M3b。
- `maxRunning` 默认改为 3。
- 开讨论串按主对话串行：`thread_open` 和排队提议的启动走同一把锁（`manager.opening`）。同一步里并行调用多次 `thread_open`，也不会超过上限或拿到相同编号；两个讨论串同时结束时，排队的提议只会启动一次。
- 回报照旧"没有讨论串在跑才唤醒"。新增 `settling`：讨论串已标成空闲、但回报还没进队列的那一小段时间，投递仍把它算作运行中。否则两个讨论串几乎同时结束时，先到的回报会单独唤醒主对话。
- 提示：
  - 调度员：讨论串共用文件夹，只读的工作可以随便并行；会改文件的讨论串不能碰同一批文件，有依赖或改同一批文件就合成一个，或等前一个回报再开；回报会等所有讨论串都结束后一起到。
  - 讨论串：可能有别的讨论串同时在这个文件夹工作；只改任务需要的文件，不动别人的改动；除非简报要求，不提交、不切分支、不 stash、不 reset、不做全目录的格式化或批量改写。
- 实机测试（桌面版，后台操作，没有接管屏幕）通过：
  - 一句话让主对话开三个只读讨论串，三个在 0.2 秒内先后开出、同时运行，分别在 16、24、27 秒后结束，都调了 `thread_report`；
  - 前两个结束时回报被扣住（待发 1 → 2），第三个结束后主对话只被唤醒一次，卡片是"讨论串回报（3）"；
  - 那一轮末尾显示"3 条回复"；
  - 没有新的崩溃日志。

#### M3b worktree 隔离（2026-10-24，分支 `feat/thread-worktrees`）

照 Claude 的 `use_worktree`：会改文件的讨论串各开一个 git worktree 和分支，只读的照旧共用项目文件夹。
- `thread_open` 和 `thread_propose` 的每一项多了 `worktree`（布尔）；`/thread -w <任务>` 是手动入口。
- `src/worktree.ts` 自己跑 git（DSH 的 worktree 服务桌面版没装，也删不掉 worktree）：
  - 从项目文件夹的 HEAD 开新分支 `dsh-threads/<n>-<6 位 id>`，检出到 `<仓库根>/.agents/worktrees/dsh-threads-<n>-<id>`；
  - 池子和 DSH 用同一个目录，第一次建时写一个内容为 `*` 的 `.gitignore`，所以项目文件夹的 `git status` 看不到它；
  - git 调用都带 `-c core.hooksPath=/dev/null`（和 DSH 一样，不跑仓库自己的钩子）。
- 先建 worktree 再建会话：文件夹不是 git 仓库或还没有提交时直接拒绝，不留下空会话。会话建好后用 `workingDirectory.set` 切过去。
- 讨论串的系统提示按记录生成：有 worktree 时写明路径和分支，要求回报前把改动提交到这个分支，不推送、不合并、不切分支；没有 worktree 时照旧"别动别人的改动、不提交"。
- 回报便条在标题下一行写分支（放在最前面，截断时不会丢）；卡片数据带 `branch`，界面在 M3c 显示。
- 调度员提示：改文件就开 worktree；回报后把分支告诉用户，用户要求才合并，合并后可用 `/thread cleanup` 清理。
- 清理：`/thread cleanup` 列出不在运行的讨论串的 worktree；`/thread cleanup confirm` 才执行。`git worktree remove` 不加 `--force`，有没提交改动的跳过；分支用 `git branch -d`，有没合并的提交就保留。
- 测试：`tests/worktree.test.ts` 在临时仓库里跑真 git（开分支、池子自带 ignore、没提交的文件不带过去、非仓库和空仓库拒绝、干净的删掉、没合并的分支保留、有改动的不删）；manager 测试覆盖开串、拒绝、提议带过去、清理。
- 实机测试（桌面版，新 clone 的 playground 仓库，push 地址设成了 `no-push`）通过：
  - 主对话开了 `worktree: true` 的讨论串，讨论串在 `.agents/worktrees/dsh-threads-1-6edc0d` 里新建 `docs/PLAYGROUND.md` 并提交到 `dsh-threads/1-6edc0d`；
  - 项目文件夹 `git status` 干净，文件只在分支上；
  - 回报唤醒主对话，主对话自己核对了分支和提交，提示用户可以 `git merge` 再 `/thread cleanup`；
  - `/thread cleanup` 列出 #1，`confirm` 后 worktree 被删、分支因为没合并而保留；
  - 没有新的崩溃日志。

#### M3c Claude 式界面（2026-10-24，分支 `feat/claude-style-ui`）

用户要求：讨论串不出现在左侧会话列表；颜色、布局照 Claude（黄色举手、呼吸状态灯、绿色 md 文件图标），做一套完整、有高级感的界面。

左侧栏：
- DSH 的会话列表整个是 `sidebar.workspaces` 一个插槽，`sessionVisible` 是闭包，没有按行过滤的扩展点；把讨论串设成 `origin: 'subagent'`（DSH 会自己隐藏）不行，那样用户就不能直接给讨论串发消息；归档也不行，归档会话不能运行。
- 做法：`kinds.ts` 按 `sessions.kinds` 生成一段样式，用 `[data-row-key="session:<id>"]{display:none}` 隐藏讨论串行，并在主对话行的时间格前加 `↳ N`（行结构是 `slot | title | time | actions`）。
- 主对话行的前置格（`sidebar.session.row.leading`）：有讨论串在等用户时显示黄色举手，有讨论串在跑时显示呼吸点，否则空着；主对话自己忙时 DSH 会用它自己的状态点占这一格。
- 已知小问题：每个工作区默认只显示 5 行，DSH 计数时把隐藏的讨论串也算进去，所以讨论串多的工作区里可见行会变少，"展开其余 N 个会话"的 N 也包含讨论串。

设计（`glyphs.tsx`、`ui.tsx`、`styles.ts`）：
- 状态记号统一由 `glyphState` 算：运行中 = 蓝色呼吸点（`prefers-reduced-motion` 时不动），等用户 = 黄色举手，完成 = 空心圆，已解决 = 绿色对勾，失败 = 红色叉，排队 = 时钟。侧栏、卡片、列表、面板头、标题栏按钮都用同一套。
- 组件：`ThreadItem`（状态、`#n` 标题、状态词、摘要、"等你决定"琥珀色块、分支和文件小标签；等用户时显示"查看讨论串"，否则悬停出现箭头）、`FileChip`（文档绿、代码蓝、数据黄）、`BranchChip`（紫色、等宽字）、`Pill`（普通 / 反色主按钮 / 图标）、`CardHead`。
- 颜色用 DSH 的主题变量，只自定义几种状态色（`--dsht-*`），深浅色都能用。
- 回报卡片：等用户的排前面；卡片里的状态是**实时**的（像 Claude），讨论串之后被标记已解决就不再显示举手；摘要、文件、分支保持回报当时的内容。同一会话里多张卡片同时刷新时共用一次请求。
- "↳ N 条回复"改成紧凑的一行一个讨论串（像 Claude 的内联讨论串卡片），细节留给回报卡片。
- 提议卡片照 Claude："建议的讨论串"，每行有自己的开始按钮（↩）和悬停出现的"不要这个"，底部"都不要" / "开始 N 个讨论串"；带 worktree 的提议有紫色"独立 worktree"标签。
- 讨论串面板头：状态记号、`#n 标题`、项目名、分支标签（worktree 删掉后划线变淡）、"标记已解决 / 重新打开""在主区域打开"。已解决的输入框照 Claude："✓ 此讨论串已解决。请重新打开以发送更多消息。[重新打开]"。
- 讨论串列表：等用户的在前、运行中其次、已解决最后。
- 标题栏按钮：有等待时显示举手和"N 个等你回复"，有运行时显示呼吸点。
- 项目页卡片：悬停微微上浮，运行中带呼吸点；输入框和图标底色提高对比度。

新建项目可以直接填文件夹路径（照 Claude）：
- 下拉框多一项"其他文件夹…"，填完整路径；宿主用 `ctx.workspaceRegistry.create(path, title)`（已是工作区就复用，否则新建）。

实机测试（桌面版）通过：
- 侧栏：讨论串行全部隐藏，"Playground ↳ 4""测试项目 ↳ 9"；讨论串运行时主对话行和标题栏出现蓝点，等用户时出现黄色举手。
- 一次开两个讨论串（一个 worktree 并以 needs_decision 回报、一个只读）：回报卡片里等待的排第一，有琥珀色"等你决定"、紫色分支、绿色 md 文件标签和"查看讨论串"；标记已解决后，这张旧卡片变成绿色对勾"已解决"。
- 紧凑的"↳ 2 条回复"、提议卡片（单个开始、全部开始）、面板头分支标签、已解决输入框、列表排序都正常。
- 用"其他文件夹…"按路径建项目，复用了已有工作区；测试项目随后移除。
- 没有新的崩溃日志。

#### 回报提醒（2026-10-24，分支 `fix/report-reminder`）

M2c 时 DeepSeek Flash 常常不调 `thread_report`（3 个里 2 个），卡片只能显示"没有回报"。
- 主对话派的一轮（`dispatch`）结束时如果没有本轮的回报，先不结算：给讨论串发一条 `role: 'reminder'` 的提醒（"你结束了这一轮，但没有调用 thread_report……现在调用一次"），这一轮保持 `running`，主对话的回报继续扣着。
- 每轮只提醒一次（`ThreadRecord.reminder`，新一轮开始时清空）。提醒前先把讨论串这一轮的最后一条回复存进 `reminder.fallback`：如果提醒后还是没回报，兜底用的是**提醒之前**的那条回复，而不是它对提醒的回答。
- 用户自己在讨论串里聊的一轮（`user`）不提醒。
- 配置 `reportReminder`（默认开）。界面上提醒显示成"提醒回报"卡片。
- 测试：提醒后回报正常送达；提醒后仍不回报时用提醒前的回复兜底；用户轮不提醒。
- 实机：这次怎么也没让模型漏掉回报（简报和追加里都明确说"不要调用 thread_report"，它两轮都还是调了），说明 M2c 之后加强的提示已经很有效；提醒这条路径由单元测试覆盖，完整流程测试时继续观察。

#### M4 发布 v0.1.0-rc.1（2026-10-24，分支 `release/v0.1.0-rc.1`）

- 用户确认：公开发 `v0.1.0-rc.1` 预发布版；awesome-dsh-plugin 收录等稳定版 `v0.1.0` 再提交。npm 没登录，先只发 GitHub Release（Plan.md 也是这个顺序）。
- `package.json`：版本 `0.1.0-rc.1`，补 `keywords`（含 `dsh-plugin`）、`homepage`、`repository`、`bugs`；`files` 加上 `README.zh.md`、`CHANGELOG.md`。仓库话题早就有 `dsh-plugin`。
- README（中英）：功能、安装（Release 的 `.tgz` 地址或 `github:` 地址）、使用、配置表、已知限制。
- **用打包出来的 `.tgz` 在官方原版 DSH 上验证过**：
  - 隔离环境 `DSH_HOME=~/dsh-clean`，`npx @deepseek-ai/dsh@0.2.1-rc.2 plugin --profile web add <tgz>`；本机没有 `pnpm`，用一个小脚本指向桌面版自带的 pnpm 11.28.5。
  - pnpm 只装了插件本身（peer 依赖没有被另装一份），宿主照样把 `@deepseek-ai/*` 解析到自己的那份。
  - `dsh web` 打开后：左侧有"项目"，项目页走 `POST /api/dsh-threads` 正常读出空列表，新建项目会打开主对话，`/thread` 命令（带新的 `-w` / `cleanup` 说明）在命令列表里。
  - 审批继承还是没法在这里验证：隔离环境没有模型登录，需要用户自己登录后再测。
- 发布：合并后在 `main` 上打 `v0.1.0-rc.1` 标签，`gh release create --prerelease`，附 `npm pack` 出来的 `fky-dsh-threads-0.1.0-rc.1.tgz`，说明取自 CHANGELOG。

- **v0.1.0-rc.2**（同日，用户确认后发布）：只加 rc.1 之后合并的两个修复（唤醒计数清零的竞态 #10、主题颜色变量失效 #11）和对应的界面小改动；版本号、README 安装地址、CHANGELOG 跟着改。
- **v0.1.0-rc.3**（同日，用户确认后发布）：照 Claude 重做的项目页、新建项目对话框和卡片菜单（#13），项目设置里的模型和使用情况（#14），项目桌面通知（#15）；版本号、README 安装地址、CHANGELOG 跟着改。
- **v0.1.0-rc.4**（同日，用户确认后发布）：运行灯改成原地明暗呼吸（#17），侧栏单独的“项目”分组，以及讨论串状态晚一步刷新的修复（#18）；版本号、README 安装地址、CHANGELOG 跟着改。
- **v0.1.0-rc.6**（同日）：发布前复查后的全部修复和新功能（#22–#32），用于在 Windows 上实测；第一次走打 tag 自动发布。
- **v0.1.0-rc.5**（同日，用户确认后发布）：回报里引用用户在讨论串里的原话、方案交给讨论串去出、主对话保持空闲（#20）；版本号、README 安装地址、CHANGELOG 跟着改。

#### 完整流程实测（2026-10-24，v0.1.0-rc.1）

在 playground 仓库（push 已关）的 Playground 项目里，像普通用户一样提了一个两件事的真实请求：修 `plainLine` 对 markdown 链接和表格的处理并补测试；审查 `src/delivery.ts` 的唤醒规则（只读）。
- 主对话自己决定分工：审查开成讨论串 #6（只读，没开 worktree），`plainLine` 这件小改动自己做（照 Claude 的"几个工具调用就能做完的事自己做"）。两边并行。
- #6 正常回报（`done`），主对话被唤醒一次，自己复核后给出结论，还补了两点；`plainLine` 改完 113 个测试全过。按用户要求提交到本地 `main`（`beff024`，没推送）。
- `/thread cleanup` → `confirm`：删掉了 #2 的 worktree，分支因为有没合并的提交而保留。
- 这次审查找出插件自己的一个真问题，已修（分支 `fix/streak-reset-race`）：
  - **用户开口时清零唤醒计数不在投递链里**。`flush` 先读主对话记录，等 `host.resolve` 返回后再把读到的那份写回；这中间用户说话做的清零会被覆盖，之后自动唤醒继续被压着。修法：`onMainUserMessage` 也走 `serial`。测试先复现（失败），修后通过。
  - `maxAutoWakes: 0` 的含义写进配置说明和 README："从不自动唤醒"。
- 审查的另外几点，判断后没改：
  - "streak 到顶后 note 从 `pendingNotes` 里删掉、只靠 inject"：quiet 的 note 一直都是 inject 进收件箱，靠 DSH 把收件箱记进会话日志；和"用户自己聊的轮次"走的是同一条路。
  - "dispatch 轮里用户插话也该算安静"：主对话派的任务按设计要大声回报，主对话在等结果。
  - "两个讨论串同时结束时 settling 有竞态"：M3a 已经处理，并有测试（第二个在第一个投递途中结束）。

#### 界面细节打磨（2026-10-24，分支 `polish/ui-details`）

逐个界面在深色（桌面版）和浅色（隔离的 Web 版，浏览器模拟浅色）下过了一遍：
- **修了一个真 bug**：派生的颜色变量（边框、悬停、按钮底色、焦点环）写在 `:root` 上，但 DSH 把主题变量（`--dsw-alias-*`）定义在 `body` 上，`:root` 那里取不到值，这些变量整个失效。之前看到的"按钮底色太淡""输入框边框看不见"都是这个原因；浅色模式下项目卡片甚至没有边框，和背景混在一起。现在固定颜色留在 `:root`，派生变量在 `body` 和插件自己的元素上计算。
- "↳ N 条回复"紧凑卡片按内容宽度显示（像 Claude 的内联讨论串卡片），不再拉满。
- 讨论串面板头的按钮加了图标（✓ 标记已解决、↺ 重新打开、⤢ 在主区域打开）。
- 项目卡片静止时也有很淡的阴影，浅色模式下更清楚。
- 看过、没改：侧栏的 `↳ N` 用文字字符（换成图标得用 CSS 遮罩，就没法同时显示数字）；回复卡片和回报卡片之间的空隙是 DSH 自己的轮次间距。

#### 项目页照 Claude 重做（2026-10-24，分支 `feat/projects-like-claude`）

用户拿 Claude 的截图提了几点：新建项目对话框太丑，要像 Claude 那样直接弹系统文件夹选择器；项目卡片要有 Claude 的"⋮"菜单、通知档位和项目设置。计划分三个 PR，这是第一个。

- **查到的 DSH 能力**：
  - 系统文件夹选择器：桌面版 `globalThis.__DSH_DIRECTORY_PICKER__.pick()`（Electron 的 `dialog.showOpenDialog`），其他情况 `ctx.uiWorkspace.pickDirectory()`；Web 版是 browse 模式时会抛 `directory-picker/unavailable`。
  - 组件：`Menu` 支持快捷键提示、子菜单、`danger`、分隔线、`label`；`Modal` 的 `headless` 能自己排版。
  - 会话归档：`workspaceRegistry.archiveSession` / `unarchiveSession`。
- **新建项目对话框**（`NewProjectDialog.tsx`，`headless` 的 `Modal`）：
  - 名称，加一整行"选择文件夹…"按钮：点击弹系统选择器，取消不变；选好后显示文件夹名、灰色路径和"更改"，名称还空着时自动填文件夹名。
  - 右上角"最近的文件夹"列出已有工作区。
  - 没有选择器时（Web 的 browse 模式）这一行变成路径输入框。项目说明从这里拿掉，放到设置的"记忆"页。
- **项目页**（`ProjectsPage.tsx`）：
  - 标题右边是"排序方式 最近活动 ⌄"（按钮 + `Menu`，当前项打勾）和分体的"新建项目 | ⌄"（⌄ 里可以用已有工作区新建）。
  - 卡片：图标方块、名称加蓝色图钉、"时间 · N 个讨论串 · 运行中"；文件夹路径挪进设置页。
  - 悬停出现竖排的"⋮"，菜单有：置顶 P、通知 ▸（四档，带说明，当前项打勾）、设置 S、归档 A、删除 D（红色，确认后只删项目记录）。菜单打开时直接按字母键就生效（我们自己监听键盘）。
  - 底部可展开"已归档 · N"。
- **归档**（宿主 `Projects.archive` / `unarchive`）：
  - 有讨论串在跑就拒绝；主对话归档失败（还在运行）也拒绝。
  - 成功后主对话和所有讨论串在 DSH 里归档（从侧栏消失、不能运行、数据不删），项目取消置顶。取消归档反过来。
  - DSH 发现"当前会话"被归档时会把主区域切到新会话，所以归档后页面会把自己重新选回来。
- **项目设置**（`ProjectSettings.tsx`，大约 820px 的 `headless` `Modal`，左侧导航）：
  - **通用**：名称和图标（图标按钮展开 24 个图标的网格）、目标（`0 / 8,000` 计数，只加进主对话的系统提示）、文件夹（只读）。
  - **记忆**：项目说明（`0 / 4,000`）。
  - 文本失焦或关闭对话框时保存，图标立即保存。模型和使用情况在下一个 PR。
- **侧栏**：主对话行没有举手或运行中时，前置格显示项目图标。
- **数据**：`ProjectRecord` 加了 `icon`、`goal`、`archived`、`notify`、`mainModel`、`threadModel`，都带默认值。通知档位这次先存下来，下一个 PR 接上系统通知。
- **测试**：新字段默认值和更新、归档和取消归档（会话被归档 / 恢复）、有讨论串在跑或主对话忙时拒绝、目标只进主对话的提示，共 74 个。
- **实机测试**（桌面版，浅色）通过：
  - 页面和卡片的样子与 Claude 截图一致；菜单项、快捷键提示、通知子菜单（打勾和说明）都对；改通知档位后菜单右侧跟着变。
  - S 打开设置；换图标、写目标都保存了（存储里能看到）。
  - 新建项目：系统选择器弹出，取消不变，选好后名称自动填，"最近的文件夹"可以换。
  - A 归档：测试项目连同 9 个讨论串一起归档，页面留在项目页；在"已归档"里 A 取消归档后恢复。
  - 侧栏主对话行显示项目图标；没有新的崩溃日志。

#### 项目设置：模型和使用情况（2026-10-24，分支 `feat/project-settings`）

计划的第二个 PR。
- **模型**（"通用"页的"模型"分组，照 Claude 的四行）：
  - 协调器模型和思考强度、讨论串模型和思考强度。下拉用"按钮 + `Menu`"，DSH 没有 Select；选项来自 `models.catalog`（转发 `sessionController.modelCatalog()`），按服务商分组。
  - 第一项是"默认（当前 DSH 默认模型）"；思考强度只列所选模型支持的档位，第一项是"默认（这个模型的默认档）"。跟随默认时思考强度不可选。
  - 协调器模型改了就立刻对主对话生效；讨论串模型存在项目上，新讨论串开出来、发简报前套用（`manager.openNow`），DSH 用不了这个模型时记一条 warn，照常开串。
- **不改用户的全局默认模型**：DSH 的 `sessionController.selectModel` 会顺带把选择存成"新会话默认模型"。`agentDefaultModel.saveSelection` 按提交顺序执行，所以先记下原来的默认、调用 `selectModel`、再把原值存回去，结果不变。
  - 实测：协调器换成 Pro、讨论串换成 Pro + Low 之后，profile 里的默认仍是 `deepseek-flash / high`；文件被 DSH 重写过，但其他内容（注释、预设、检查器那段）都在。
- **使用情况**（新的导航页）：
  - 宿主 `projects.usage` 对主对话和每个讨论串调 `sessionController.projections(...)`，读 `tokenUsage`（会话没加载也能读）。
  - 输入 = 未缓存 + 缓存读 + 缓存写（和 DSH 自己的用量标签一样）。顶部是合计，下面一张表：主对话在前，讨论串按用量从多到少；DSH 不记费用，所以只有 token。
- **测试**：协调器模型生效、DSH 拒绝时项目记录不变、讨论串模型只存不立即生效；开讨论串时套用讨论串模型、失败照常开；用量汇总和排序。共 77 个。
- **实机测试**（桌面版，浅色）通过：
  - 模型目录读出 DeepSeek Account 的 Flash / Pro。
  - 协调器换成 Pro 后，主对话输入框的模型标签变成"DeepSeek-V4-Pro · High"；讨论串设成 Pro + Low 后，`/thread` 开出的 #7 的请求头是 `deepseek-v4-pro / low`。
  - 全局默认没变；使用情况显示合计 3.4M / 55K 和每个会话的明细。
  - 测完把 Playground 的两个模型都改回默认；没有新的崩溃日志。

#### 项目通知（2026-10-24，分支 `feat/project-notifications`）

计划的第三个 PR：让卡片菜单里的通知档位真正生效。
- DSH 自己没有任何会话通知，所以由插件的浏览器端（`src/client/notify.ts`）来发：
  - 订阅 `uiSession.sessionStatus`，记下从"运行"变成"空闲"的会话；同一批（讨论串一起结束、它们唤醒的主对话）600ms 内合并。
  - 只在 DSH 窗口不在前台时（`document.hasFocus()` 为假或页面不可见）才问宿主要通知内容；在前台时不打扰，侧栏的记号已经够了（Claude 也是这样）。
  - 宿主 `notifications.describe { ids }` 用纯函数 `notifyTarget` 说明每个会话：属于哪个项目、档位、是不是在等用户决定，以及一句去掉 markdown 的正文（等待的讨论串用要用户决定的问题，做完的讨论串用摘要，主对话用最后一条回复）。不属于项目或项目已归档的会话不通知。
  - 档位规则（`wantsNotification`）：所有新消息 = 主对话和每个讨论串；主对话与需要你处理的（默认）= 主对话 + 等你决定的讨论串；仅需要你处理的 = 等你决定的讨论串；无 = 不发。
  - 用网页自己的 `Notification`：标题是项目名（讨论串加"#n 标题"），`tag` 按会话，同一会话的新通知替换旧的。点击通知会把窗口带到前面，打开主对话；如果是讨论串，再在右侧打开它。
  - 权限还是 `default` 时先 `requestPermission()`；桌面版里是 `granted`（Electron 的权限处理只管 media）。
- **测试**：档位规则表、`notifyTarget`（主对话用最后一条回复的纯文本、等待的讨论串用问题、不属于项目和已归档的忽略），共 81 个。
- **实机测试**（桌面版）：
  - 把 Playground 设成"所有新消息"，发一条 `sleep 8` 的消息后把访达放到前台。
  - 用临时调试日志（之后删掉了）确认：主对话结束时窗口在后台，权限是 `granted`，`new Notification(...)` 确实为主对话调用了。
  - 我的截图工具会隐藏白名单以外的窗口，看不到系统通知横幅本身。横幅是否显示还取决于 macOS 对 DeepSeek Harness 的通知设置，需要用户自己看一眼。

#### 侧栏单独的“项目”分组（2026-10-24，分支 `feat/sidebar-projects`）

用户说还不够“项目”：主对话混在“工作区 → 文件夹 → 会话”里，看起来就是一条普通对话。要像 Claude 那样，侧栏有单独的“项目”分组，每个项目一行，点进去就是主对话。
- **DSH 没有给插件在侧栏加分组的插槽**：
  - 侧栏是 新会话 → `<nav>`（`sidebar.panellist`）→ `regionArea` 里的 `sidebar.workspaces` → 底部。
  - `sidebar.workspaces` 是 single 插槽，DSH 的 `WorkspaceBrowser` 占着。
- **实验：包住 `sidebar.workspaces`，失败。**
  - `ctx.slots.entries('sidebar.workspaces')` 能拿到官方登记项：`component`、`inject`、5 个子插槽声明、`store`（持久化键 `dsh.workspace.view.v5`）、`locale: 'workspace'`。
  - 登记同名项要显式 `priority: -1`；否则报“single slot already has a registration at priority 0”。
  - 照抄子插槽声明会报 `slot "sidebar.workspaces.directoryFlow" is already declared`：一个子插槽只能声明一次。不声明的话，官方组件自己的会话菜单、行前置格都渲染不了（`SlotOwnershipError`）。所以不能包。
- **做法：portal 插到 `<nav>` 后面**（`src/client/SidebarProjects.tsx`）。
  - 我们“项目”导航图标（`PanelIcon`）用 `useSidebarAnchor` 报告它所在的 `<nav>`，以及侧栏是否展开（图标 16px 是展开，18px 是窄条）。
  - `shell.overlay`（list 插槽，常驻、可叠加）里登记 `SidebarProjectsHost`：在 nav 后面插一个 `div.dsht-side`，`createPortal` 渲染分组。`react-dom` 在宿主模块表里（first-party 包都在 `require("react-dom")`），类型来自新加的 devDependency `@types/react-dom`。
  - 找不到 nav 就不渲染。侧栏隐藏再打开时，图标重新挂载，分组跟着回来。
- **分组**：
  - 样式照 DSH 的“工作区”量过：标题 36px、14px 灰字；行高 32px、左右 8px、16px 前置格；悬停和选中用 `--dsw-alias-interactive-bg-hover`。
  - 前置格：讨论串等你 → 举手；主对话或讨论串在跑 → 呼吸点；否则显示项目图标。右侧显示置顶图钉和 ↳N，悬停时换成“⋯”。
  - 排序：置顶在前，再按最近活动；不显示已归档的。超过 8 个时显示“展开其余 N 个”。
  - 标题点一下可以折叠，状态存 `localStorage`。“+”新建项目。
  - 高亮照 DSH 自己的规则：没有选中的面板时，`retainedBy.mainView > 0` 的会话就是当前会话（`dsh-client-ui-workspace` 的 `FlatList`）。
  - 卡片的“⋮”菜单、设置对话框、删除确认框抽成 `src/client/ProjectActions.tsx`，项目页卡片和侧栏行共用。
- **从“工作区”里拿掉项目**（`src/client/kinds.ts`）：
  - 主对话的行和讨论串一样，用生成的 CSS 按 `data-row-key="session:<id>"` 隐藏。原来主对话行的 ↳N 和 `MainRowMark` 删掉了。
  - DSH 的行 key 还有 `workspace:<id>`（工作区标题行）和 `overflow:<id>`（“展开其余 N 个会话”）。
  - 只剩项目会话的工作区整组隐藏，在浏览器端算（`projectOnlyWorkspaces`），规则照抄 DSH 的 `sessionVisible`：
    - 不算的会话：列表里没有的、空的（当前打开的除外）、子代理的、归档的；
    - 一开始放在宿主算，结果默认工作区里一个没用过的空会话让它“不空”，所以改到浏览器端，用 DSH 的工作区快照（`items[].sessionIds`、`archivedSessionIds`）和会话列表（`blank`、`origin`）。
- **测试**：`sidebarCss`、`sidebarProjects` 排序、`projectOnlyWorkspaces`（空会话、归档、子代理、当前空会话），共 84 个。
- **实机**：
  - 桌面版：Playground（置顶，↳7）、test1（↳3）、测试项目（↳9）出现在“项目”里；dsh-threads-playground 和 dsh-threads-test1 两个工作区整组消失，默认工作区（有普通会话）照常。
  - 点行打开主对话并高亮；“⋯”菜单能用，点它不会误开项目；“+”打开新建对话框；折叠、展开正常；侧栏隐藏再打开后分组还在。
  - 隔离的 Web 版：浅色、深色都正常。
- **整体实测**（用户要求：不提讨论串，给几件事；开串后马上再提新需求），test1 项目：
  - 一次给三件事：最高分记录、GitHub Pages 部署调研文档、README。主对话自己开了 #4（最高分）和 #5（部署文档），README 说等两个分支合并后按最终代码写。
  - 开串后马上提“把网页标题改成 Snake · 霓虹版”。主对话 6 秒就回了：转给正在改 `index.html` 的 #4，没有重复开串，理由是避免合并时撞同一行。
  - #5 先做完，回报按规则压着（还有讨论串在跑就不唤醒）。#4 做完后主对话被唤醒，合并两个分支，写 README 和截图，`node test.js` 13 个全过。侧栏 test1 一直显示呼吸点和 ↳5，做完变回项目图标。
  - **发现的问题**：#5 先做完时，主对话里的回复卡片和标题栏还显示它“运行中”。
    - 原因：卡片只在运行集合变化时重新加载，加载时宿主还没把 #5 记成完成。之后 #4 一直在跑，运行集合没再变化，所以一直没刷新。
    - 修法：`syncKinds` 发现有会话停下，1.5 秒后再 `threadsRevision.bump()` 一次，所有讨论串视图都会重新加载。

#### 用户在讨论串里要的改动写进回报；方案交给讨论串（2026-10-24，分支 `fix/dispatch-user-words`）

用户照测试指令跑了一遍 test1，发现两处和预想的不一样。
- **主对话以为是讨论串自作主张**：
  - 用户直接在 #6 里说“困难模式起步提到 60ms”，#6 改好并回报了。
  - 这一轮是用户发起的，回报照规则静默送进主对话，内容和普通回报一样。主对话正在合并 #6，看到后写“#6 又追加了一个我没要求的提交 7623a65，我没有合并它”，然后让用户确认。
  - 修法：`ThreadRecord.userMessages`（zod 默认 `[]`）记下这一轮里用户在讨论串里说的话：`onInbox` 现在也拿消息正文（`textOf(message.content)`），最多留最近 5 条，新一轮开始和结算时清空。
  - `composeNote` 紧跟在标题和分支行后面写一行：用户发起的一轮写“这一轮是用户自己在讨论串里要求的，不是讨论串自作主张。用户的原话：「…」”；派发的一轮里用户插话，就写“这一轮中用户在讨论串里说过：「…」”。每条最多 200 字。
  - 调度提示：带用户原话的回报就是用户的决定，照之前处理这条讨论串的方式接着做（合并过就把新提交也合并），告诉用户，不再让用户确认。
- **皮肤方案没交给讨论串**：
  - 用户要“先给三个方案选，我选了再做，单独开讨论串”。主对话自己想了三个方案，用 DSH 的 `ask_user_question` 在主对话里问；用户选了 A 才开 #8。讨论串从来没举手。
  - 同一时间主对话醒来后自己做了两分多钟的重活：合并、78 项浏览器断言、截图、改 README。用户的新需求排了大约半分钟队。
  - 调度提示改了三处：
    - 要用户挑方案的事，直接开讨论串，让讨论串给出方案、`needs_decision` 停下，主对话不先出方案、不先问。
    - 新增“Keep this conversation free”：主对话的回合要短，收到回报只合并用户要的、跑项目自带的测试、告诉用户进度；浏览器、截图、长脚本和新写文档交给讨论串。
    - “回报不是证据”改成“便宜地核对（diff、项目测试）并说明哪些没验证，深的核对交给讨论串”。
  - 讨论串提示：任务书要求先给方案时，把每个方案写清楚、列进 decisions、`needs_decision`，用户选之前什么都不做。
- **实机（桌面版）**：
  - test1 里重发同类需求（“标题 logo，先给三个方案选，单独开讨论串”），主对话还是自己出方案、用提问框问。思考里写的是“Same pattern as skin”，打断重发后写“The question was aborted. Re-ask”：这段对话里已经有两次同样的先例，模型照先例做。所以把规则写得更硬：点名不许用 `ask_user_question` 做这种选择，并注明“即使这段对话之前这样做过”。长对话里已有的先例仍可能压过规则。
  - Playground（没有这种先例）：“README 开头标语，先给三个方案选，单独开讨论串”。主对话直接开 #10，任务书要求“交三个方案、needs_decision、选定之前不动文件”；#10 举手，卡片显示“待你决定”。
  - 在 #10 里直接回复“选方案 2，中英文两个 README 都改”。#10 提交后的回报写着“这一轮是用户自己在讨论串里要求的……用户的原话：「选方案 2……」”。问主对话“#10 那边现在什么情况”，它的思考第一句是“The user chose plan 2 in the thread”，照常问要不要合并（这个分支之前没合并过）。
  - 发现 #10 举手后，主对话又用提问框把同一个问题问了一遍，占住了主对话。补一条：讨论串等用户决定时，主对话用一两句话说明，不再用 `ask_user_question`。重测（#11，CHANGELOG 副标题）：主对话只用文字说“你选 1/2/3，我转给 #11”，输入框一直可用。
- 用户先前怀疑那个提交丢了，我起初也判断成“丢了”；实际是主对话看到了、等用户确认。“静默回报压到下一轮”“回报写明未合并的提交”这两个想法这次没做。
- **测试**：`composeNote` 引用用户原话（用户发起的一轮、派发的一轮里插话、没有原话），`onInbox` 记录并在结算后清空，共 85 个。

#### 正式版前的修复（2026-10-25 起，docs/RELEASE-PLAN.md 阶段 1）

- **删除项目后讨论串回到会话列表**（分支 `fix/orphaned-threads`）：
  - 原来删除项目只删项目记录，讨论串记录还在：`sessions.kinds` 照旧把它们从 DSH 的列表里藏起来，`roleOf` 照旧给它们装 `thread_report`，和确认框说的“保留为普通会话”不符。
  - 现在“讨论串”按两种算：`isThread` 只看有没有记录（讨论串不能设为项目、不能再开讨论串，照旧）；`isProjectThread` 还要求它的主对话仍是项目的主对话，角色、侧栏隐藏、已解决锁定都看这个。用户在这种会话里说话不再开一轮、也不再往原主对话送回报。
  - 删除项目和归档一样，有讨论串在跑时拒绝。
  - 把原来的主对话重新“设为项目”，这些讨论串会自动回来。
- **审批继承取不到主对话就不开串**（分支 `fix/inherit-permission`）：
  - 原来 `inheritPermission` 只用 `ctx.agents.get` 拿已加载的主对话，拿不到就什么都不做。新会话由 `pinInitialPermission` 钉成**用户默认**模式，所以 DSH 重启后由 `recover()` 启动的排队提议、或主对话被卸载时开的讨论串，可能比主对话更宽。
  - 现在开串第一步（建 worktree 和会话之前）就用 `resolveAgent` 读主对话的模式（`host.permissionOf`），读不到就拒绝，什么都不留下；会话建好后 `setPermission`，失败则讨论串记为 failed，简报不发。
  - 主对话是 `custom`（沙箱和审批开关对不上任何模式）时也拒绝：`permissionPresets.set` 只接受真实的模式名，原来这种情况会在建好会话后抛错，留下一个失败的讨论串。
  - DSH 没有 `permissionPresets` 服务时照旧开串，记一条 warn。
- **项目是仓库子目录时，worktree 讨论串进对应的子目录**（分支 `fix/worktree-subfolder`）：
  - worktree 从仓库根检出，原来讨论串也进 worktree 根。monorepo 里项目是 `repo/packages/app` 时，简报里的相对路径全都对不上。
  - `createWorktree` 用 `git rev-parse --show-prefix` 记下项目文件夹在仓库里的相对路径（`ThreadWorktree.subdir`，旧记录默认 `''`），讨论串进 `worktreeFolder(worktree)`；讨论串提示写明“项目文件夹（packages/app）在你自己的 worktree 里”。用 git 算相对路径，不受 macOS `/tmp` 这类软链接影响。
  - 项目子目录还没提交进仓库时（HEAD 里没有它），开 worktree 前就拒绝，不建分支。
- **补测试**（分支 `test/tools-command-storage`）：
  - `tests/tools.test.ts`：五个 `thread_*` 工具走 `defineTool` 自带的参数校验（错的 `initiation`、缺 `task`、`status` 不在列表里都抛 `ToolArgsError`），`offer` 的三种回答和没有 `userQuestions` 的退路，拒绝以文字返回给模型。
  - `tests/command.test.ts`：`/thread` 的标题取首行、`-w` / `--worktree`（`-wat` 不算选项）、空任务给用法、非项目会话报错、上限报错、`cleanup` 只列不删、`cleanup confirm` 才删。
  - `tests/install.test.ts`：按角色装工具和提示段；删除项目后主对话和讨论串的工具被收回，重新设为项目后装回；会话销毁和插件卸载时清理。
  - `tests/storage.test.ts`：用 git 历史里最早的记录形状（M1 的讨论串和 mains、M2a 的项目、M2c 的提议、没有 `subdir` 的 worktree）过一遍 `valueSchema`，确认新字段都有默认值。
  - `ThreadManager` 的假宿主挪到 `tests/fixtures.ts`，几份测试共用。跑真 `defineTool` 和 storage-domain 需要 `@deepseek-ai/dsh-scope`、`dsh-sandbox`、`dsh-storage`，作为 devDependencies 精确锁 `0.2.1-rc.2`（只给测试用，运行时仍是宿主那份）。
  - 写测试时注意到：`maxProposalsPerTurn` 实际是“每次调用”的上限，一轮里调两次 `thread_propose` 不会被拦。提示词要求“每轮最多几个”，暂不改。
- **停止和归档单个讨论串**（分支 `feat/thread-stop-archive`）：
  - **原来的问题**：讨论串面板里用 DSH 自带的停止按钮停掉主对话派的一轮，插件看到“没回报”就发提醒，讨论串又被叫醒接着干；而且讨论串从会话列表藏起来以后，DSH 自己的会话菜单用不了，只能“标记已解决”，项目用久了列表只增不减。
  - **认出“用户停的”**：用户停止的一轮以 `turn/end`、`reason: { kind: 'aborted', reason: { kind: 'user' } }` 结束。`host.stoppedByUser` 从本轮起点往后找最后一个 `turn/end`；是用户停的就不提醒，按“已停止”结算：便条状态 `stopped`，写明“用户在这一轮做完之前停止了讨论串，不要自己重开或重派”，安静地送进主对话（和用户自己在讨论串里聊的轮次一样，不唤醒）；卡片状态“已停止”。调度员提示也加了同一句。DSH 的停止按钮和我们的“停止”走同一条路。
  - **停止**：面板头运行中显示“停止”（`threads.stop`），`/thread stop <n>` 是命令入口。用 `agent.cancel({ kind: 'user' })`，不带停止按钮的 `keepInbox`，排在后面的追加指令一起丢掉（和 DSH 归档会话时停会话一样）。没在跑就报错。
  - **归档**：`ThreadRecord.archived`（默认 `false`）。不在运行时，面板头的归档按钮调 `workspaceRegistry.archiveSession`；“取消归档”反过来。已归档的讨论串不出现在讨论串列表（底部可展开“已归档 · N”）、不计入 ↳N 和项目卡片的数量、不举手；`thread_reply` 拒绝并让模型请用户先取消归档。整个项目取消归档时，单独归档的讨论串保持归档。
  - **顺手修的**：讨论串列表的容器没有高度和滚动，讨论串多了以后下面的看不到（实测 Playground 有 12 个时就截掉了），现在列表自己滚动。
  - **实机（桌面版）**：
    - 归档 #10：面板头变成“已归档 · 取消归档”，列表里消失、底部出现“已归档 · 1”，标题栏和侧栏的数量 11 → 10；取消归档后恢复。
    - `/thread` 开 #12（`sleep 120`），面板头点“停止”：讨论串显示“已停止”，没有收到提醒；主对话没被唤醒，日志里多了一条安静送达的 `· stopped ·` 便条。
    - #13（`sleep 90`）用讨论串输入框里 DSH 自带的停止按钮：结果同上。原来这里会被提醒叫醒。
  - **观察到、没改**：安静便条 `inject` 进主对话收件箱后要等主对话下一轮才被带上，这段时间退出 DSH 会弹“当前正在运行的任务将会中断”。便条已写进会话日志，重启后照样在；用户自己在讨论串里聊出来的回报一直都是这样。
- **宿主端文案中英双语**（分支 `fix/host-locale`）：
  - 原来浏览器端有中英两套，宿主端写的东西全是中文：`offer` 弹出的选择卡、`/thread` 的回复、界面上显示的错误、讨论串里的简报和追加卡片正文，还有给模型看的工具结果和回报。README 以英文为主，英文用户第一眼看到的就是中文。
  - `src/messages.ts`：一份带类型的中文字典（逐字保留原来的文案）和一份英文字典，`msg()` 取当前语言。所有宿主端文案都走它，包括给模型看的部分：中文用户的行为和原来完全一样（之前的实测都是在中文下做的），英文用户整条链路都是英文。系统提示照旧是英文。
  - **语言从哪来**：DSH 宿主只存用户显式选的语言，没选时由浏览器决定，所以宿主自己不知道页面用的是哪种。浏览器端每次调 `POST /api/dsh-threads` 都带上 `ctx.locale.getLocale().active`，`dispatchRpc` 据此切换；页面切语言时发一次 `ping`。浏览器还没调过时默认英文，实际上页面一打开就会调（侧栏要读项目列表），用户能看到的文案出现之前语言就定了。
  - `offer` 的回答按两种语言的选项文字都认，防止问题弹出后页面切了语言。
  - `/thread` 的命令说明只在启动时注册一次，写成中英两种。
  - 新建项目时“文件夹要写完整路径”的示例按平台给（Windows `C:\Users\me\code\app`、macOS `/Users/me/code/app`、Linux `/home/me/code/app`），原来是清单跨平台第 6 条。
  - 测试：`tests/setup.ts` 让原有测试照旧按中文断言；`tests/messages.test.ts` 覆盖语言识别、RPC 切换语言、英文的拒绝 / 简报 / 回报，以及英文提问、中文回答。
  - 实机（桌面版，中文界面）：重启后 `/thread stop 99` 回“这个主对话没有讨论串 #99。”（宿主默认英文，说明语言确实是浏览器传过来的），项目页和侧栏正常。
- **跨平台 CI 和打包检查**（分支 `ci/cross-platform`）：CI 加了 `windows-latest`、`macos-latest`（Node 24）跑类型检查、测试（worktree 测试跑真 git）、构建和 `dist/` 一致性；第一次跑 Windows 就全过。`.gitattributes` 统一 LF；`scripts/check-pack.mjs` 检查 `.tgz` 的内容。DSH 包的 peer 范围改成和 `engines.dsh` 一样的 `>=0.2.1-rc.2 <0.3.0`（DSH `0.2.1-rc.3` 已在 2026-10-23 发布）。Ubuntu 两个任务名不变，分支保护不用改；Windows 和 macOS 暂时不是必需检查。
- **打 tag 自动发布**（分支 `ci/release`）：照 Plan.md 的 CI 规划，推 `v*` 标签触发 `.github/workflows/release.yml`：`npm run check`、`dist/` 一致、打包检查，再用 `scripts/release.ts` 核对 tag、`package.json` 版本、CHANGELOG 小节标题、中英 README 的安装地址四处一致，然后 `npm pack` 并 `gh release create`（版本带 `-` 的是预发布）。Release 说明按 rc.1–rc.5 手写的格式生成：CHANGELOG 小节的开头一段、安装命令、改动列表。发版步骤写进了 `CLAUDE.md`。

#### 之后
- 发布：
  - GitHub Release 附 `.tgz`；
  - npm 用作用域包。

---

#### 调度规则收紧（2026-10-24，分支 `fix/dispatcher-rules`）

v0.1.0 阶段 1 合并后，在 test1 跑完整流程时，主对话没让合并就合并了讨论串的分支、自己提交，还自己截图做长检查。为了分清是长对话里的先例还是规则本身的问题，用 test1 在同一提交（`404abbc`）的副本建了新项目，按同样的流程（一次给三件事、不提“讨论串”，中途再提一个需求）对比：

| 现象 | test1（长对话） | fresh（新对话，旧规则） | fresh2（新对话，第一版新规则） |
| --- | --- | --- | --- |
| 没让合并就合并 | 合并了 | 没合并，问用户 | 没有讨论串可合 |
| 自己提交 | 提交了 2 次 | 没提交 | 没提交 |
| 写音效方案文档 | 开讨论串 | 交给 DSH 的子智能体，本轮里轮询等它 | 自己在主对话里写 |
| 主对话截图 | 截了 | 用 headless Chrome 截了 | 没截界面（只为文档调研跑了一次音频 API） |
| 中途需求排队 | 约 1.5 分钟 | 约 8 分钟 | 屏幕锁了，没发出去 |

- 合并和提交是 test1 的先例带出来的；截图和“不开讨论串”是规则本身压不住。
- DSH 子智能体工具的描述是“把自成一体的任务交给子智能体……研究、限定范围的实现、分析”，和 `thread_open` 正面冲突，新对话里模型自然选它。
- fresh2 的思考里写着读到了“写文件、超过几分钟的交给讨论串”，但判断文档工作量“中等”、开讨论串有“协调成本”，于是自己做。

改动（`src/prompts.ts`、`thread_open` 的描述）：
- 新写或重写的文档、改多个文件的事一律交给讨论串，不论大小，也不论是不是和别的事写在同一条消息里；开头就决定，不先替讨论串读代码；写简报的成本不是自己做的理由。
- 讨论串而不是子智能体：子智能体的结果要在本轮里等，用户找不到主对话；子智能体只用于本轮回答里马上要用的快速检索。`thread_open` 的描述里也写了。
- 主对话不开浏览器、不跑 headless Chrome、不截图，自己的小改动也不截；要看效果就说明没做视觉验证，或交给讨论串。
- 新的“Git in the project folder”：没用用户自己的话要求（这次或长期的），不提交、不合并、不 rebase、不推送、不切分支；这段对话里之前的提交合并、git 历史里的合并提交都不算许可。自己的改动留在工作区并说明，worktree 讨论串回报时问要不要合并。

第一版之后又改了三次，每次都用同样的流程复测：

| 版本 | 复测 | 结果 |
| --- | --- | --- |
| 第一版（上面四条） | fresh2，新对话 | 不再用子智能体，不截界面图，不提交；但三件事全在主对话里自己做，一轮 6 分钟。思考里写着读到了规则，但判断文档“中等”、开讨论串有“协调成本”。 |
| 第二版：文档和多文件改动一律开讨论串，开头就决定，写简报的成本不是理由 | fresh3，新对话 | 第一轮 99 秒：文档开讨论串（worktree），漏测清单交给子智能体在后台做（不阻塞），页脚自己改；中途需求等约 35 秒、22 秒做完。没截图，没提交。讨论串回报后抽查 20 秒，**没合并**，问用户。通过。 |
| 第三版：调度段开头加“你是项目的负责人，不是动手的人”的角色，只有一两个工具调用的小改动自己做 | test1，长对话（之前多次让它提交、合并、截图） | 文档一上来就开讨论串，第一轮 76 秒，中途需求 12 秒。但照旧自己提交 3 次、用 headless Chrome 和截图验证，讨论串回报后**自己合并了**。长对话里的先例压过了系统提示。 |
| 第四版：每条新消息后附一份简短的负责人守则（runtime context） | test1，同一段长对话 | 第一轮 30 秒：更新记录开讨论串（worktree）、样式审计开只读讨论串，自己只改了一行按钮文字；中途需求 8 秒。**没提交**（“按你之前‘别乱提交’的约定，改动留在工作区”，并问要不要提交），没截图（“没在这边开浏览器截图，所以没有视觉确认”）。讨论串回报后 12 秒抽查，**没合并**，列出“两件待你决定的事（我不擅自动手）”。通过。 |

第四版的做法：DSH 在每一步开始前把各插件的 runtime context 拼成一份快照，放在刚收到的消息后面，内容和上一份相同就不再追加（`dsh-agent-loop` 的 `runtimeContext.project`）。守则里带着主对话收到的消息数（`manager.inboxCount`，用户消息和我们的回报都算），所以每条新消息之后都会出现一份新的守则，离模型“最近”，不会被长对话淹掉；同一回合的后续步骤不会重复追加。代价是每条消息多几百字。

复测里还看到一个问题，没在这次改：样式审计的结论超过回报 300 字的上限被截断，主对话让讨论串“完整重贴一遍”，但回报照样会被截断。主对话需要细节时应当让用户打开讨论串，或者读讨论串留下的文件；之后考虑让 `thread_status { n }` 带上讨论串最后一条回复的更长摘录。

#### 讨论串面板照 Claude 重做；等审批也算“等你”（2026-10-24，分支 `feat/threads-panel`）

- **面板**（用户给了 Claude 的“讨论串”面板截图）：右侧栏的讨论串列表改成标题“讨论串”加搜索，下面按“等待您处理 / 运行中 / 空闲 / 已解决 / 已归档”分组，每组带数量、可以折叠；“等待您处理”和“已解决”没有内容时显示虚线框（“决策、审阅和权限请求。”“已完成的讨论串。”），已归档默认收起。每条只留状态记号、`#n` 标题、时间，下一行是等你决定的内容、改动文件数和分支。分组和搜索在 `groupThreads`（`src/client/threads.ts`），按最近活动排序，搜编号、标题和摘要。
- **等审批 / 提问 / 计划确认也算“等你”**：讨论串从会话列表藏起来以后，DSH 在会话行上显示的“等待审批”标记就看不到了；原来我们的举手只认 `needs_decision` / `blocked` 回报，讨论串卡在审批上时只显示“运行中”。DSH 浏览器端的会话状态里有 `pendingInteraction.kind`，它自己的会话列表只认 `approval`、`question`、`plan-review` 三种（`dsh-client-ui-workspace` 的 `visiblePendingKind`），我们照抄：`liveKey` / `parseLive` / `useLive` 把“谁在跑、谁在等你”编成一个稳定的字符串供选择器用（我们自己给已解决讨论串挂的 `dsh-threads-resolved` 不算）。等你的讨论串在面板、回报卡片、“↳ N 条回复”、面板头、标题栏都显示举手，面板里写“等你批准一项操作 / 等你回答一个问题 / 等你确认计划”。侧栏的项目行在主对话或任一讨论串等你时举手（`sessions.kinds` 的每个主对话多了 `threadIds`）。窗口在后台时，会话开始等你也按项目的通知档位发通知（“仅需要你处理的”档现在也包括主对话等你）。

#### DSH 0.2.1-rc.3 上的冒烟测试和审批验证（2026-10-24）

- **升级**：桌面版用自带的更新（更新源 `dsh-desk/feeds/mac-arm64`，nightly 通道）从 0.2.1-rc.2 升到 0.2.1-rc.3。升级后 App 重新打包成 `app.asar`，dsh-purge 解包后打在宿主上的补丁全部不在（dsh-purge 1.6.53 起支持 rc.3，需要用户在“Purge → 状态”里重新“应用”）。所以下面的测试是在原版宿主上做的；profile 里 dsh-purge 插件本身还装着，但审批由原版 `dsh-user-approval` 决定。
- **开发依赖**：把 `@deepseek-ai/*` 开发依赖换成 rc.3 后类型检查、测试、构建都过。中途一次类型错误是删掉 lockfile 重新安装时根目录的 zod 浮到 4.6.7，和 DSH 包锁定的 4.4.3 成了两份类型；保留 lockfile（或根目录也用 4.4.3）就没问题。
- **界面**：rc.3 在左侧导航最后加了“更多”菜单，“项目”分组照常排在它后面；讨论串面板、面板头、回报卡片都正常。
- **审批继承（清单 P0-1）验证通过**：fresh3 的主对话切到“仅可查看”，`/thread -w` 开一个要写文件的讨论串。讨论串的会话日志里先是 DSH 钉的用户默认 `danger-full-access`，接着被我们设成 `read-only`（审批策略 `ask`），都在发简报之前；它要写文件时 DSH 发出 `approval/asked`（“提权到 workspace-write”），挂了几分钟没有自动通过，直到在面板里点“拒绝”（`approval/decided: rejected`）。README 的这条已知限制去掉了。
- 同一轮里看到的另一个行为：讨论串 #2 因为审批被取消而回报“受阻”后，主对话醒来想自己写那个文件（一行），在“仅可查看”下也弹了审批（用户点了允许）。按“只有一两个工具调用的小改动自己做”这不算违规，但它接手了讨论串受阻的活而没先问。第二次（#3 被拒绝后）它就先问“要我在主工作区建这个文件吗”。

#### Windows 实测第一轮（2026-10-25，v0.1.0-rc.6）

朋友的 Windows 10 Pro（DSH 0.2.1-rc.3 装在 D 盘），由 Codex 照 docs/WINDOWS-TEST.md 操作。做完了 1–4 项的全部或一部分，5–13 项没做。安装、新建项目、普通讨论串和回报都正常。区分出来的问题：

- **插件的问题**：
  - 机器上只有 Codex 自带的 git，不在系统 PATH 里，`/thread -w` 却报“项目文件夹不是 git 仓库”。原因是 `createWorktree` 把 `git rev-parse` 的所有失败都说成“不是仓库”。现在找不到 git（`ENOENT`）时直接说找不到 git；git 报了别的错（Windows 上常见的是 `detected dubious ownership`）时引用 git 的原话。README 加了对应的排错说明。（#37）
  - worktree 讨论串被要求提交时，碰上会失败的 pre-commit hook，就用 `--no-verify` 绕过去，还删了 hook 写的文件。主对话看到 DSH 沙箱的权限错误后，自己去修文件夹权限，还临时放开了 PowerShell 的执行策略。现在两边的提示词都写明：不跳过 hook，不改 hook，不删 hook 写的东西；不为了让命令跑通去改权限、ACL、执行策略、沙箱或全局 git 设置。讨论串遇到这种情况回报 `blocked`；主对话把错误告诉用户，不自己修，也不开讨论串去修，除非用户要求。（#38）
- **测试写错了**：第 3 项把“讨论串提交时 pre-commit hook 执行了”当成插件关不掉 hook。实际上插件只在自己调用 git（开、删 worktree）时用 `core.hooksPath=/dev/null` 关掉 hook，讨论串自己的提交本来就该走仓库的 hook。测试改成两部分：用 post-checkout hook 测插件开 worktree 时关没关掉 hook，用失败的 pre-commit hook 测讨论串是不是回报“受阻”。第 0 步也改成用系统 PATH 检查 git。
- **DSH 或环境的问题**：`SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\dsh-test\playground)` 是 DSH 的 Windows 沙箱没能给项目文件夹加写权限，讨论串因此只能用只读工具，可能和 `D:\dsh-test` 是 Codex 建的有关，第二轮会只读记录 `icacls` 和文件夹所有者。下载进程异常退出、winget 源报错、Git 安装器不认 `/DIR` 都是环境问题。存储里 `worktree.repositoryRoot` 是 git 输出的 `D:/…`，`worktree.path` 是 `D:\…`；前者只用作 git 的工作目录，两种写法都能用，不是问题。
- **#38 在 macOS 上实测**（2026-10-24，fresh2 项目，仓库装了一个必定失败的 pre-commit hook）：`/thread -w … 然后提交到你的分支` 开出的讨论串提交被挡后回报 `blocked`，引用了 hook 的输出，没用 `--no-verify`，没删 hook 写的文件，分支上没有新提交；会话日志里只跑过一次 `git commit`。主对话收到回报后说不会改 hook、不会跳过，并给用户三个选项。再让主对话自己提交（“提交不了你看着办”）：它的思考里想到“用户可能想让我关掉 hook，但规则不允许”，只把文件暂存，引用报错，给出用户移除 hook 后可以直接运行的提交命令。
- 同一次实测里看到的界面现象：`/thread` 命令在对话里只显示成一行 `thread · <结果>`，不显示成消息气泡（DSH 的设计，输入框不回显命令）；它上面的空白是上一轮回复被隐藏的操作按钮（复制、在新对话中分支），DSH 只在最新一轮常显这一排，不是丢了消息。
- **操作失误**：同一条 `/thread` 命令每次都发了两到五遍（#1–#5，#6 和 #7），开出了重复的讨论串。用户确认是操作者发错了，不是插件的问题。

#### Windows 实测第二轮（2026-10-25，v0.1.0-rc.7）

同一台电脑，按 docs/WINDOWS-TEST.md 的第二轮提示词，后半程由 Codex 用电脑操作代替操作者。13 项里通过 8 项，部分通过 3 项，失败 1 项，未执行 1 项。

- **通过**：升级（先卸 `@fky/dsh-threads` 再装 rc.7，项目和讨论串都在，上次停在“运行中”的 #7 已收尾）；清理（预览不删；确认后删掉干净的 worktree、保留没合并的分支、跳过有改动的并说明原因）；子目录项目（文件在分支的 `packages/app/hello.txt`）；审批沿用（“仅可查看”下写文件弹审批、不自动通过，列表“等你批准一项操作”、侧栏举手，拒绝后没写）；停止（停后 85 秒仍空闲、没回报、主对话没被唤醒）；归档和取消归档；完整流程（主对话为写文档和代码审查各开一个讨论串，追加的要求约 10 秒后落地，没有提交、合并或改权限）。
- **hook，按规则通过**：插件开 worktree 时 post-checkout 没执行；#8 提交被失败的 pre-commit 挡住，回报“受阻”，没绕过。之后操作者在 #8 里回了「同意」（回答它“需要你处理钩子，或者明确同意我跳过它”），#8 才用 `--no-verify` 提交，主对话也知道这是用户的原话。这是用户的决定，符合 #38 的规则。但主对话接着说“跳过钩子哪怕你同意也不行”：#38 只给讨论串写了“除非用户明确要求”，主对话那条没写。已改成一样（#42）。
- **长路径失败（插件的问题已修）**：仓库根目录 172 个字符，`.agents\worktrees\dsh-threads-…` 里的路径超过 260，`git worktree add` 报 `Filename too long`。界面上直接显示了 `Command failed: git -c core.hooksPath=/dev/null worktree add …` 原文，`-b` 建的分支也留了下来。现在检出失败时会收回这次新建的文件夹、登记和分支（之前就有的不动），`Filename too long` 时说明 260 字符限制和用户的选择（只为这个仓库打开 `core.longpaths`、换短路径、不用 worktree），其他失败引用 git 自己的报错（#41）。插件不替用户改 git 设置。
- **新项目的第一条 `/thread` 像没反应（已修）**：deep 和 mono 两个新项目第一条就发 `/thread`，界面一直停在 DSH 的欢迎页，讨论串其实已经开了（侧栏 ↳1、举手）。第一轮同一条命令被发了好几遍，多半也和这个有关。原因：DSH 把命令画成一行，聊天视图只在有非命令节点时才算“有内容”，宿主只在一轮开始时把会话从 blank 改掉。现在 `/thread` 那一行下面会加一张讨论串卡片（实时状态、分支、改动文件、打开按钮，和“↳ N 条回复”卡片里的条目一样），卡片是插件自己的节点，界面随即离开欢迎页（#43）。
- **部分通过、未执行**：文件被占用时清理（记事本那步做不了，改用 PowerShell 进程占着目录和文件；占用和释放后两次都跳过有改动的 worktree，不报错、不卡住）；Windows 通知（项目设成“所有新消息”，讨论串做完了，但测试工具截不到通知、也打不开系统设置核对）；界面语言（停在设置里，没测完）。
- **DSH 或环境**：终端命令仍报 `SetNamedSecurityInfoW failed (Win32 5): grantWrite(...)`，讨论串提交要靠一次性提权。playground 文件夹上有 Low 完整性标签、`Everyone` 拒绝删除子项、一个 `S-1-4-…` 的写权限条目，父目录没有，说明是某个沙箱后加的。这些是 DSH Windows 沙箱的事，不是插件的。
- **#42、#43 在 macOS 上实测**（2026-10-25）：新建项目 card-test，第一条就发 `/thread`，界面马上离开欢迎页，命令行下面出现 #1 的卡片（运行中，做完变成已完成），回报卡片和主对话的回复接在后面。同一个对话里，仓库装着必定失败的 pre-commit hook：用户说“这一次我同意你用 `--no-verify` 跳过它”，主对话只提交了那一个文件；接着再要一次提交、只说“提交不了你看着办”，它没有跳过，说明“上一次的 `--no-verify` 是你明确限定了这一次的”，并给出三个选择。

#### `offerApproval`：`offer` 可以不弹确认卡（2026-11-10，分支 `feat/offer-approval`，issue #51）

用户 fallout6099 提的：主对话像组长一样自己判断哪些活该开讨论串，但只要用户没明说“开讨论串”，`initiation: 'offer'` 就一定弹“开讨论串 / 在主对话里做 / 先不做”的卡片并等着；一条消息里有几个任务，就要点几次。

- 配置项 `offerApproval: 'ask' | 'open'`，默认 `ask`（和以前一样）。`open` 时 `thread_open` 收到 `offer` 不再调 `userQuestions.ask`，直接走 `manager.open`，和 `user_asked` 一样；存下来的 `initiation` 还是 `offer`，卡片和历史的含义不变。没有 `userQuestions` 服务的宿主在 `open` 下也能开。
- 提示词跟着配置走：`dispatcherPrompt(maxRunning, offerApproval)` 里 `offer` 那一条，`ask` 是原文（“The user is asked to choose first; respect the answer.”），`open` 换成“直接开，并在回复里说清开了哪些、为什么，方便用户停掉不想要的”；`thread_open` 的 `initiation` 参数说明也分两种。模型自己想到的活仍然走 `thread_propose`，两种模式都一样。
- 默认没改成 `open`：确认卡是“用户没要求另开”时征得同意的那一步（照 Claude 的 `offer`），补丁版本里悄悄去掉不合适；提 issue 的人也说保留 `ask` 为默认可以，他要的是能关掉。
- 测试：`tests/tools.test.ts`（`open` 不问就开、记录仍是 `offer`、没有 `userQuestions` 也能开；参数说明两种写法；默认值和非法值），`tests/prompts.test.ts`（`ask` 和不传完全相同，`open` 换了那一句、`thread_propose` 那条还在）。
- **实测**（桌面版 0.2.2-rc.1，`cordis.patch.yml` 里临时加 `offerApproval: open`，在插件页把“讨论串”关掉再打开让它就地重载）：在 smoke-022 的主对话里发“帮我做两件事：整理一份文档；审查一个文件（只读）”，没提“讨论串”。主对话没有弹卡片，直接用 `offer` 开了 #5（带 worktree），回复里说明了开了什么；第二件事点名的文件在这个旧 clone 里不存在，它没有硬开，而是列了三个替代目标让用户选。讨论串还在跑的时候回“选 1，另外告诉我版本号”，它又用 `offer` 开了 #6（只读），没弹卡片。存储里两条记录的 `initiation` 都是 `offer`。
#### DSH 0.2.2-rc.1 上的冒烟测试（2026-11-10，分支 `chore/dsh-0.2.2-rc.1`）

本机桌面版已经是 0.2.2-rc.1（cordis 4.1.0、schemastery 3.19.0）。按 §七 的清单走了一遍，三个环境：全新的隔离原版 `dsh web`（`npx @deepseek-ai/dsh@0.2.2-rc.1`，装打出来的 `.tgz`，没有模型登录）、本机桌面版（有模型，宿主被 dsh-purge 改过）、两个版本的源码对照（npx 缓存里的原版包）。

- **第 1 项**：开发依赖换成 0.2.2-rc.1 后类型检查、测试、构建都过，`dist/` 一字不差。
- **安装和兼容性判断**：`engines.dsh` 的 `>=0.2.1-rc.2 <0.3.0` 能匹配 0.2.2-rc.1（宿主用 `semver.satisfies(…, { includePrerelease: true })`，写了 `engines.dsh` 就不看 peer）。pnpm 只装插件本身，所有 peer 都报“missing”，和 0.2.1 一样；宿主按**名字**把 peer 解析到自己的那份，不比较范围（`dsh-app-boot` 的 `profile-resolution-bootstrap.js` 两个版本只差注释）。所以 `cordis ~4.0.5`、`schemastery ~3.18.5` 对不上新版也不会出事；这次还是把这两个范围放宽成 `>=4.0.5 <5`、`>=3.18.5 <4`，免得声明和实际不符。
- **隔离原版（第 2、3、4、5、7、10、11 项）**：插件页有“讨论串”，左侧有“项目”入口和分组，控制台没有报错；新建项目后工作区列表里看不到它；第一条 `/thread` 马上离开欢迎页，出卡片、侧栏 ↳1、回报卡片，主对话被唤醒（讨论串和主对话都停在“缺少 API Key”，这是没登录）；`/thread -w` 建出 worktree 和分支，`/thread cleanup confirm` 删掉；归档、取消归档讨论串和项目；切到 English 后 `/thread stop 99` 的回复跟着换；700px 宽时项目页一列、菜单里直接列通知档位、项目设置能滚动、新建项目对话框不超出窗口。系统文件夹选择器没点（会在这台 Mac 上弹系统对话框），项目是用 `projects.create` 建的。
- **审批沿用（第 9 项）做了一半**：隔离原版里把主对话改成“只读”，新开的讨论串输入框显示的也是“只读”（默认是“工作区内修改”），说明 `permissionPresets.current()` / `set()` 还管用。“讨论串写文件时弹审批、不自动通过”没法测：隔离环境没有模型，桌面版的审批被 dsh-purge 改成永远允许。要补这一步，得在隔离环境里登录模型。
- **桌面版（第 3、4、5、6、8 项，有模型）**：新建项目（用“最近的文件夹”）；第一条 `/thread` 开出 #1，回报后主对话醒来复核；`/thread -w … 提交到你的分支` 的讨论串在自己的分支提交，回报带分支和文件，主对话核对后问要不要合并，没有自己合；`/thread cleanup confirm` 删掉 worktree、保留没合并的分支；`sleep 60` 的讨论串分别用面板头“停止”和输入框里 DSH 自带的停止按钮停，都显示“已停止”，没有“提醒回报”，主对话没被叫醒；项目设置里把协调器模型和讨论串模型换成 V4-Pro，主对话输入框跟着变，`cordis.patch.yml` 里的全局默认模型还是原来的。
- **第 12 项（dsh-web-mobile）没测**：没有在这台机器上装第三方插件。0.2.2 自己在 768px 以下有了抽屉（frame 上多了 `data-sidebar-drawer`，`layout.selectPanel` 会顺手收起它），点项目行时宿主已经把抽屉收了。担心 `closePhoneDrawer` 再 `toggleSidebar()` 一次会把它又打开，就在隔离原版里给 frame 手动加上 `data-mobile-nav="frame"` 模拟：抽屉照常收起，没有被重新打开。真装了 dsh-web-mobile 的情况仍然没有实测。

源码对照（§七 第一张表逐行，加上 `defineTool`、`userQuestions.ask`、`defineDomain`、命令事件、插槽目录）：没有哪一项被删掉或改名。变了但不影响我们的：

- 侧栏的内边距从 12px 改成 8px，差的 4px 挪进了行里（`--dsh-sidebar-row-padding:12px`、`--dsh-sidebar-label-gap:6px`）。“项目”分组的标题、图标、标题文字因此比宿主的工作区列表靠左 3–7px，“+” 靠右 5px。**已修**：`src/client/styles.ts` 里这几处改成按宿主的变量算，0.2.1 的值做回退；在 0.2.2-rc.1 上量过和工作区列表对齐（标题 19px、图标 20–36px、文字 42px），在 0.2.1-rc.2 上量过和原来一样（16px、20–36px、40px）。
- 导航区多了面板的“取消固定”机制（只在内存里，原版没有入口）和一行“更多”；`nav.after()` 的位置不变。
- `selectModel` 现在按原样保存请求的选择（原来保存解析后的配置），仍然是先存默认再返回，`saveSelection` 仍然排队，`host.applyModel` 的“记下默认、再改回去”照常工作（上面实测过）。
- `pinInitialPermission` 从 `session/created` 改成 `agent/created` 触发；我们是在 `resolveAgent` 之后才 `set()`，顺序没变。
- `sidebar.workspaces.session.menu.item` 成了“旧式”菜单插槽：我们的“设为项目”还在会话菜单里，位置从“置顶和重命名之间”变成“归档之前的一组”。
- `dsh-tools` 拆成了 `index.js` 和 `pipeline.js`，`defineTool`、`tools.register`、`exec.agent/callId/signal` 都没变；`conversation.chat.node` 的 `fileMentions` 没了，我们没用。

这一轮顺带看到、没在这里改的：

- **停掉的讨论串可能被 DSH 自己叫醒**（0.2.1 也有，不是这次升级带来的）：#4 把 `sleep` 放进了后台任务，用 DSH 的停止按钮停掉后，后台命令照常跑完，DSH 给会话发“后台任务状态更新”又开了一轮，讨论串汇报了 `done`。主对话没被叫醒。**已修**，见下一节“停掉的讨论串保持‘已停止’”。
- 右侧栏标签的标题是打开时存下来的字符串，切换界面语言后旧标签还是原来的语言。
- 英文界面的项目卡片写的是“1 threads”。
- 0.2.2 的 `dsh` 包声明了 `engines.node >=24.9.0`；跑隔离的 `npx @deepseek-ai/dsh@0.2.2-rc.1` 需要 Node 24.9 以上。

#### 停掉的讨论串保持“已停止”（2026-11-10，分支 `fix/stopped-thread-stays-stopped`）

上一节最后留下的问题。两条停止路径都复现了（桌面版 0.2.2-rc.1，项目 smoke-022）：讨论串用 `bash` 的 `run_in_background` 跑 `sleep 50`，再 `job_output { wait: true }` 等它；用 `/thread stop <n>`（和面板头“停止”是同一个 `manager.stop`）或 DSH 输入框里的停止按钮停掉；约 50 秒后讨论串自己又跑了一轮，`thread_report` 交了 `done`，卡片从“已停止”变成“已完成”，主对话那边只有先前那条 stopped。

**DSH 里是怎么回事**（读的是 npx 缓存里两个版本的原版包，行为一样）：

- 后台任务归 `ctx.jobs`（`dsh-jobs` 的 `JobRegistry`，实现是 `dsh-jobs-local`）管，按会话 id 记属主。停止一轮（`agent.cancel`）只中断这一轮和正在等的 `job_output`，**不动后台任务**；任务只在被 `job_kill`、会话归档（`workspace/session-stop`）或属主销毁时结束。前台的 `bash` 不一样：调用被中断时它自己把进程停掉，所以前台 `sleep` 的讨论串停了就是停了。前台命令超时后会被“转入后台”（`promoteOnTimeout`），之后和后台任务一样。
- 任务结束时 `dsh-tool-jobs` 给属主会话发一条 `createUserMessage`，`source.kind` 是 `tool-jobs`（界面上显示成“后台任务状态更新”）：会话空闲就 `followup`（开新一轮），在跑就 `inject`。只有三种结束不发：模型自己 `job_kill` 的、有人正在 `wait` 的、属主销毁（`teardown`）的。
- 所以插件从外面 `ctx.jobs.kill()` 也拦不住这次唤醒：被杀的任务一样会发“finished [status: killed]”，空闲的讨论串照样被叫起来。

**取舍**：不杀后台任务，只让停止这件事在插件里保持成立（任务说明里的方案 b）。

- DSH 自己的“停止”就是只停这一轮、任务留着（可能是用户还要用的开发服务器）；插件替用户多杀一层，和宿主的行为不一致。
- 杀了也没用（上面第三条），而且用 DSH 的停止按钮时，我们是在这一轮已经结束之后才知道的。
- `ctx.jobs` 是宿主内部的服务约定，不是给第三方插件的接口；方案 b 一个新接口都不用。

**做法**：

- 讨论串记录多一个 `stopped`：一轮以“用户停止”结算时置上；用户在讨论串里发话（新的一轮 `user`）、主对话 `thread_reply` / 重新派发时清掉。旧记录读出来默认 `false`。
- DSH 自己开的那一轮本来就不算一轮（`onInbox` 只认 `source.kind === 'user'`），不结算、不提醒、不给主对话发东西；这点没变，补了测试。
- `stopped` 期间的 `thread_report` 不记录，工具回复告诉讨论串：用户已经停了它，不要继续，等用户或主对话发话。`lastReport` 不变，卡片不会翻成“已完成”。停止之前已经交的回报照旧保留在 stopped 那条回报里。
- 讨论串多一个运行时上下文 `dsh-threads-stopped`（`systemPrompt.context`，和主对话的提醒同一个机制）：只在 `stopped` 时有内容，跟着叫醒它的那条消息一起出现，告诉它这不是继续任务的请求、不要调 `thread_report`、说一两句就结束。没停时是空的，不产生快照。
- 界面：卡片、“↳ N 条回复”、列表、面板头的状态都先看 `stopped`（显示“已停止”，不举手），再看 `lastReport`。以前停掉的讨论串如果更早一轮有回报，卡片会显示那一轮的“已完成”，现在也对了。`thread_status` 在状态后面加“· 用户已停止”。桌面通知里这种讨论串的状态是“已停止”。
- `manager.stop` 不再要求记录是 `running`：DSH 自己开的那一轮没有记录状态，用户照样能用面板头“停止”或 `/thread stop` 停掉它。

**没做的**：没有阻止 DSH 开那一轮（要动宿主的收件箱，属于内部接口）；讨论串会醒来说一两句话，然后停下。正常结束（没被停止）的讨论串之后被后台任务叫醒、又交了一份回报的情况在这一节没有变（`lastReport` 会更新，主对话收不到新消息），下一节“一轮结束之后补交的回报”修了。

#### 一轮结束之后补交的回报（2026-11-10，分支 `fix/late-report-delivery`）

上一节留下的另一半：讨论串这一轮**正常结束**（没被用户停），之后 DSH 自己把它叫醒（它留在后台的任务结束了，机制同上一节），它在这一轮里又调了一次 `thread_report`。

**修之前**（桌面版 0.2.2-rc.1，项目 smoke-022，#11）：简报是“`run_in_background` 跑 `sleep 40; echo late-done`，启动后先回报，结束后再回报”。第一份回报“后台任务已启动，还没结束”照常唤醒了主对话；40 秒后讨论串被 `tool-jobs` 通知叫醒，第二份回报“后台任务已结束，输出：late-done”写进了 `lastReport`，卡片和 `thread_status` 跟着变，主对话的日志里之后一条消息都没有。工具回复还对讨论串说“结束本轮时会发给主对话”，其实不会。换成真实场景：讨论串说“构建已启动”，十分钟后说“构建失败”，没人知道。

**取舍**：补交的回报自己算一小轮，按正常规则给主对话发便条。

- 要守住的是一条不变量：**记下来的回报都会送到主对话**。卡片和 `thread_status` 显示的，不能和主对话听到的不一样。“只标记、不投递”做不到这一点，所以没选。
- 讨论串的系统提示要求每次回复结束前都调 `thread_report`，所以被叫醒的讨论串通常会回报；它交的就是这件任务真正的结果，主对话作为项目负责人需要它。
- 由回报触发，不由收件箱里那条通知触发。只凭一条不是 `user` 的消息就开一轮，要是那条消息没有真的开出一轮（别的插件对空闲会话 `inject`），讨论串会一直停在 `running`，挡住这个主对话所有的唤醒，还占一个 `maxRunning` 名额。回报是在正在跑的一轮里调的工具，后面一定有 `idle`，一定能结算。也不依赖通知的 `source.kind` 具体叫什么。
- DSH 开的这一轮里讨论串没回报：什么都不发，也不提醒。没有新回报，主对话知道的和记录一致；为“后台任务结束了，没什么要说的”再叫醒两边不值得。
- 响还是静，跟上一轮走（新字段 `lastRound`）：上一轮是主对话派的，后台任务是那件任务的一部分，按唤醒规则投递（主对话空闲才唤醒，在跑就先留着；**不再**要求其它讨论串都停下，见「追加指令改为可选 steer / followup」同一轮的投递改动；受 `maxAutoWakes` 限制，超过后只 `inject`）；上一轮是用户自己在讨论串里发起的，用户就在那儿看着，安静投递，和用户发起的轮次一样。
- 被用户停掉的讨论串不变：`stopped` 时回报照旧拒收，保持“已停止”（上一节）。

**做法**：

- `manager.recordReport`：讨论串不在任何一轮里（`round === null`）、没被停、项目还在时，这份回报开一轮：`status: 'running'`、`round` 取 `lastRound`（没有就按 `dispatch`）、`late: true`、`roundStartedAt` 等于回报时间（所以 `currentReport` 认它）。之后走原来的路：这一轮 `idle` 时 `onIdle` → `settle` → 便条 → `flushNotes`。已有回报，所以不会触发“提醒回报”。
- 记录多两个字段，旧记录读出来是默认值：`lastRound`（上一轮结算时的发起方，`null` 当 `dispatch`）、`late`（这一轮是补交的回报开的，结算时清掉）。
- 便条在标题下面多一行（`noteLate`）：这是上一轮结束后补交的回报，是 DSH 自己叫醒的，不是主对话或用户让它继续的，它取代这个讨论串之前的回报。之前那份如果还留在待发队列里（别的讨论串在跑、主对话在忙），两条一起发，先旧后新，不合并，免得丢掉旧便条里引用的用户原话。
- 这一轮和普通一轮一样对待：用户这时停掉它，按“已停止”结算（回报留在 stopped 便条里，之后再被叫醒就拒收）；主对话这时 `thread_reply`，它变成普通的任务轮（`late` 清掉）；DSH 重启时它还开着，`recover` 照常结算。
- `manager.reply` 等 `host.resolve` 回来后重新读一次记录再写。原来用的是等待之前读到的记录，讨论串恰好在这时回报的话，回报会被旧记录盖掉。
- 系统提示：讨论串那份多一条，说后台任务会在回复结束后继续跑、结束时 DSH 会开新一轮；任务要等它的结果就尽量在这一轮里等；没等就结束的话，在摘要里写明结果还没出来，被叫醒后再调一次 `thread_report`。主对话那份的“Reports”多一条：讨论串可能在一轮结束后再回报，以新的为准，照样核实。

**实测**（桌面版 0.2.2-rc.1，项目 smoke-022，把这个分支的 `dist/` 拷到链接的检出里、插件关开一次）：

- #12，主对话派的，`sleep 40` 放后台后就结束这一轮：第一份回报唤醒主对话；任务结束后讨论串被叫醒、再回报，主对话又被唤醒一次，收到带“补交的回报”那一行的便条，对用户说“后台任务完成……已取代之前的『已启动』回报”。`autoWakeStreak` 从 1 到 2。
- #12，接着由我在讨论串里发话让它再跑一个后台 `sleep 30`（用户发起的一轮）：两份回报都没有唤醒主对话，记录里 `lastRound: 'user'`，待发队列是空的（已 `inject`）；主对话下一轮开始时收到了这两条。
- #13，`run_in_background` 后用 `job_output { wait: true }` 等，`/thread stop 13` 停掉：任务结束后讨论串被叫醒，带着 `dsh-threads-stopped` 上下文，说了一句、没调工具，记录保持 `stopped: true`、没有回报，主对话没被唤醒。
- 没在桌面版上测的：别的讨论串还在跑时补交的回报被留住、到 `maxAutoWakes` 后只 `inject`、补交那一轮里停止 / `thread_reply` / 重启（都有单元测试）；前台命令超时后转入后台的任务；隔离的官方 DSH。

**没做的**：

- DSH 开的那一轮，从开始到讨论串调 `thread_report` 之前，记录里还是 `idle`：这段时间别的讨论串结算时不会等它，主对话可能被先后唤醒两次，而不是合成一次。
- 用户在讨论串**还没回报**时停掉 DSH 开的这一轮：这一轮不算一轮，所以讨论串不会被记成“已停止”，下一个后台任务结束时它还能回报。回报之后停的，会按“已停止”结算。
- 没有“进行中”这种回报状态：后台任务没结束就结束一轮的讨论串，第一份回报只能用现有的四种状态之一，靠摘要说明结果还没出来。

#### 追加指令改为可选 steer / followup（2026-11-04）

用户报的问题：主对话给正在运行的讨论串发追加指令（`thread_reply`）时，消息只是排进收件箱的 `next-turn`，界面把它显示成输入框上方的“排队消息”一行，要等讨论串当前这一轮结束才会被读到；回合长的时候要好几分钟，改一句要求却“不具备时效性”。用户的意思是让主对话自己决定这次要排下一轮，还是直接插进去。

DSH 的两种投递（核对的是 `@deepseek-ai/dsh-agent` 的类型声明和 `dsh-agent-loop` 的 `AgentLoop`；运行时装的是 0.2.1-rc.5，类型锁的是 rc.2，两边都有）：
- `agent.followup(message)` = `send(message, 'next-turn', true)`：成为下一轮的唯一普通消息，运行中的会话要等这一轮结束。
- `agent.steer(message)` = `send(message, 'next-step', true)`：运行中的会话在下一个步边界读到；空闲的会话直接开一轮。浏览器端 Ctrl/Cmd+Enter「插话发送」用的就是这个（`dsh-api-session-controller` 的 `prompt({ mode: 'steer' })`、`updateQueue({ kind: 'steer' })`）。
- 步边界指模型每次请求之前（`preStep` 里 `inbox.claim('next-step')`）。如果当前轮在最后一步，插话会留在收件箱里；`turn()` 结尾看到 `inbox.hasPending` 会接着开一轮把它带走，不会丢。
- 浏览器端的排队浮层只列 `inbox['next-turn']`（`dsh-client-ui-conversation` 的 InputZone 队列快照），所以 steer 的消息不会显示成“排队消息”，而是下一步直接出现在讨论串的对话里；我们的 `noticeDefinition` 照旧把它渲染成“追加指令”卡片（`role: 'reply'`、`wake: true`）。

改动：
- `thread_reply` 增加可选参数 `mode: 'steer' | 'followup'`，**默认 `steer`**；`manager.reply(mainSessionId, n, message, mode)` 按模式调 `agent.steer` / `agent.followup`。空闲的讨论串两种都立刻开一轮（steer 在空闲时也会唤醒），所以 `followup` 只在“这是下一件事、要等当前这件事做完”时才有意义。
- `ThreadAgent`（`src/manager.ts`）和 `src/host.ts` 的 `wrapAgent` 增加 `steer`；通知消息的来源元数据不变。
- 工具描述、`src/prompts.ts` 的“Follow-ups: thread_reply”都写明什么时候用哪个；工具结果分开成“已把追加指令直接插给讨论串”和“已把追加指令排给讨论串……作为下一轮处理”，让模型知道自己刚才选的是哪种。
- 测试：`FakeAgent` 增加 `steers`；`ThreadManager.reply` 覆盖默认 steer 和显式 followup；`thread_reply` 覆盖默认、显式 followup、拒绝未知 mode。
- 实机验证（待做）：在用的 DSH 里发 `thread_reply`，正在运行的讨论串应在一两步内读到（不再出现在排队消息一行），并照常回报。

#### 主对话标记已解决 / 归档：thread_mark（2026-11-06）

用户报的问题：「标记已解决」和「归档」只有用户能在浏览器讨论串面板里点（`threads.resolve` / `reopen` / `archive` / `unarchive`，见 `src/api.ts`），主对话想让列表干净一点、或想把做完的讨论串收起来时没有工具可用。

改动：
- 新工具 `src/tools/thread-mark.ts`：`thread_mark { n, action }`，`action` 取 `resolve | reopen | archive | unarchive`，按 #n 找讨论串（和 `thread_reply` 一样，不用 session id）。只注册给 dispatcher（`src/install.ts`），讨论串会话里没有它。
- `ThreadManager.markNumber(mainSessionId, n, action)`（`src/manager.ts`）：照 `stopNumber` 的写法按 n 找线程，找不到抛 `ThreadError(msg().noThreadNumber(n))`，然后转调已有的 `setResolved` / `setArchived`。`resolve` 只改记录状态，不碰会话、不发通知；`archive` / `unarchive` 会归档 / 取消归档 DSH 会话。运行中归档沿用 `stopBeforeArchive` 拒绝（「先停止再归档」）。两个方法都带幂等短路，重复标记不会重复写存储、也不会重复调宿主。
- 工具结果文案中英双语（`src/messages.ts`）：`toolResolved` / `toolReopened` / `toolArchived` / `toolUnarchived` / `toolNotMarked`，失败时给出拒绝的原因（例如「讨论串 #n 还在运行，先停止再归档」「这个主对话没有讨论串 #n」）。
- `thread_status`（`manager.describe`）在状态后面补一个 `resolvedMark`（「 · 已解决」/「 · resolved」），和原来的 `archivedMark` 并列；`describeHead` / `listLine` 的第四个参数改成合并后的 marks。
- `src/prompts.ts` 的 dispatcherPrompt 加一节「Marking threads solved, and archiving them」：任务做完且用户看过之后再 `resolve`（不要用它结束一轮、也不要在活没做完时标）；不再需要的线程用 `archive`（移出列表、DSH 会话归档、不删除，运行中会被拒绝）；这些用户都能在面板里做，主对话只在需要整理列表时做，并告诉用户。
- 测试：`tests/manager.test.ts` 的 `ThreadManager.markNumber`（按 n 解析、四种 action、重复标记幂等不写存储、运行中归档被拒、只标记本主对话的线程）；`tests/tools.test.ts` 的 `thread_mark`（成功文案、未知 n 和未知 action、运行中归档的拒绝文案）；`tests/install.test.ts` 的 dispatcher 工具清单加上 `thread_mark`。
- 实机验证（待做）：在桌面版里让主对话对做完的讨论串调 `thread_mark`，检查列表、标题栏计数、输入框锁定和 `thread_status` 的显示。

## 六、验证

1. 本地自动检查：`npm run typecheck && npm test && npm run build`，全部通过；`dist/` 里的 `client.js` 以 `window.__ModuleLoader__.load(` 开头。
2. 安装：完全退出 DSH，执行 `scripts/dev-install.sh`，再打开 DSH。
   - 插件页能看到插件；
   - 新会话的工具列表里有 `thread_*`；
   - 右侧栏有"讨论串"标签。
3. M1 端到端：
   - 对主对话说："开个讨论串：列出 src 下的文件并各用一句话总结"。
   - 侧栏出现新会话，标签页里显示 running。
   - 结束后主会话出现一条 notice 并自动继续，摘要不超过 400 字。
4. `offer` 路径：只说任务、不提"讨论串"。如果模型选了 `offer`，会弹出三个选项；选"在主对话做"，不应该新建会话。把 `offerApproval` 设成 `open` 再试一次：不弹选项，直接开，记录里的 `initiation` 仍是 `offer`。
5. 点击标签页里的条目能跳到讨论串；在讨论串里直接发一条消息，主会话不应该被唤醒。
6. 防循环：把 `maxAutoWakes` 设为 2，连续派 3 个短任务，第 3 条只进上下文、不唤醒。
7. 重启 DSH：讨论串列表还在，对旧讨论串 `thread_reply` 成功。
8. **在官方原版 DSH 上**（2026-10-24 已在桌面版 0.2.1-rc.3 验证，见“DSH 0.2.1-rc.3 上的冒烟测试和审批验证”）。隔离环境的做法：
   - 启动：
     - `export DSH_HOME="$HOME/dsh-clean"`
     - `npx -y @deepseek-ai/dsh@0.2.1-rc.2 plugin --profile web add "link:$PWD"`（在仓库根目录执行）
     - `npx -y @deepseek-ai/dsh@0.2.1-rc.2 web --port 8787`
   - 第一次打开要在网页里自己登录 DeepSeek 账号；测完删掉 `~/dsh-clean` 即可。
   - 主会话设成 ask 模式，讨论串执行写文件时会弹出审批；
   - 不能出现"后台讨论串自动通过"。

## 七、依赖的 DSH 内部行为和升级冒烟清单

下面这些不是 DSH 公开承诺的接口，是读 0.2.1-rc.2 源码或实测得出的；0.2.2-rc.1 逐行对照过源码，仍然成立（见“DSH 0.2.2-rc.1 上的冒烟测试”）。DSH 升级后最先坏的就是它们，每次换 DSH 版本都按第二张表走一遍。

| 依赖 | 用在哪里 | 坏了会怎样 |
| --- | --- | --- |
| 侧栏会话行的 `data-row-key="session:<id>"`、`workspace:<id>`、`overflow:<id>` | `src/client/kinds.ts` 生成 CSS 隐藏讨论串、项目主对话和只剩项目会话的工作区 | 讨论串和主对话重新出现在“工作区”列表里 |
| 侧栏结构：`sidebar.panellist` 所在的 `<nav>` 后面能插元素；导航图标 16px 表示展开；侧栏的间距变量 `--dsh-sidebar-inline-padding`（0.2.1 是 12px，0.2.2 是 8px）、`--dsh-sidebar-row-padding`、`--dsh-sidebar-label-gap`（0.2.2 才有） | `src/client/SidebarProjects.tsx` 用 portal 插“项目”分组；`src/client/styles.ts` 按这些变量对齐标题、图标和“+” | “项目”分组不显示，或者窄侧栏时位置不对；间距再变的话，分组和工作区列表差几个像素 |
| `retainedBy.mainView > 0` 的会话就是当前会话 | 侧栏项目行的高亮 | 高亮错行 |
| `globalThis.__DSH_DIRECTORY_PICKER__.pick()`（桌面版）；`uiWorkspace.pickDirectory()` 在 browse 模式抛 `directory-picker/unavailable`，Web 版 0.2.1-rc.5 抛的是普通 Error（`… needs the native capability …`，没有错误码） | 新建项目选文件夹；`src/client/picker.ts` 只认这两种写法 | 弹不出系统文件夹选择器，退回手填路径；DSH 换了说法的话，Web 上会显示成报错而不是退回手填 |
| **第三方插件 dsh-web-mobile（手机布局，按 3.2.1 实测）**：它给宿主的 frame 元素加 `data-mobile-nav="frame"`；在主面板左上角浮一个返回键（10,12，38×38，粗指针下到 1023px 宽）；点宿主自己的会话行才收起抽屉；把 `[aria-modal="true"]:has(> :first-child > :last-child > button)` 当成它的设置面板改成横排；提供 `--dsh-web-mobile-vh` | `src/client/styles.ts` 只在有这个标记时给项目页留 58px 顶部空间；`closePhoneDrawer`（`src/client/index.tsx`）点项目行后用 `layout.toggleSidebar()` 收起抽屉；新建项目对话框把表单包在 `.dsht-np-body` 里躲开那个选择器 | 手机上项目页标题被返回键盖住；点项目行后抽屉不收；新建项目对话框被横过来。桌面版和没装这个插件的环境不受影响 |
| `sessionController.selectModel` 顺带把选择存成新会话默认模型；`agentDefaultModel.saveSelection` 按提交顺序执行 | `host.applyModel` 先记下默认、再改回去 | 换项目模型会改掉用户的全局默认模型 |
| `permissionPresets.current()` 对不上任何模式时返回 `custom`；`set()` 只接受真实模式名；新会话由 `pinInitialPermission` 钉成用户默认模式（0.2.1 在 `session/created`，0.2.2 在 `agent/created`，都早于我们的 `set()`） | 讨论串沿用主对话的审批模式 | 讨论串开不出来，或者用了更宽的默认模式 |
| 用户停止的一轮以 `turn/end`、`reason: { kind: 'aborted', reason: { kind: 'user' } }` 结束 | `host.stoppedByUser`：停掉的一轮不提醒 | 停掉的讨论串又被“提醒回报”叫醒 |
| 停止一轮不结束会话的后台任务；任务结束时 `dsh-tool-jobs` 用 `source.kind = 'tool-jobs'`（不是 `user`）的消息唤醒空闲会话 | `manager.onInbox` 只把 `user` 消息当成新的一轮；`stopped` 的讨论串在这种轮次里拒收 `thread_report`，并带上 `dsh-threads-stopped` 上下文；没被停的讨论串在这种轮次里交的回报另开一轮投递（`recordReport`） | DSH 的通知如果改成 `user` 来源，停掉的讨论串会被当成用户让它继续：回报照收、状态翻成“已完成” |
| `agent.cancel({ kind: 'user' })` 不带 `keepInbox` 会丢掉排队的输入 | “停止”按钮和 `/thread stop` | 停止后讨论串接着跑排队的追加指令（插话中、还没被读到的也会一起丢） |
| `agent.session.snapshotEvents(seq)` 加 `finalAssistantOutput`（`dsh-subagent`） | 没回报时用最后一条回复兜底；通知正文 | 兜底和通知正文变空 |
| 没有 `groupTree` 的聊天节点在已结束的轮里会被过滤（`dsh-client-ui-chat`） | 讨论串卡片设 `groupTree: 'input' / 'turn'` | 卡片在历史轮次里消失 |
| 命令记成 `command/run`（`name`、`args`）和 `command/done`（`kind`、`text`，没有命令名），DSH 画成一行；聊天视图只要有一个不是 `command` 的节点就算“有内容”，宿主只在 `turn/start` 时把会话从 blank 改掉，只有命令的对话停在欢迎页 | `threadCommandDefinition`：`/thread` 那一行下面的讨论串卡片，也让新项目第一条 `/thread` 离开欢迎页；讨论串编号从 `/thread` 自己的回复里读 | 卡片不出现，新项目第一条 `/thread` 又像没反应 |
| `agent.inject` 的消息留在收件箱，直到主对话下一轮；这期间退出 DSH 会提示“任务将会中断” | 安静回报（用户自己聊的、被停止的轮次） | 只是提示，回报已写进日志 |
| `workspaceRegistry.archiveSession(id, { stopActivity: false })` 在会话运行时抛错；归档的会话从侧栏消失、不能运行 | 归档项目、归档讨论串 | 归档时把运行中的讨论串一起停掉，或者归档失败 |
| `sessionController.projections({ sessionId })` 的 `values.tokenUsage`（会话没加载也能读） | 项目设置里的“使用情况” | 用量全是 0 |
| `connection.fetch.register` 只放行 owner principal；桌面版 `dsh-app://app/*` 带 cookie 转发 | 浏览器 ↔ 宿主的唯一通道 `POST /api/dsh-threads` | 整个界面拿不到数据 |
| 插槽名和作用域（`CLIENT_SLOT_API`）：`sidebar.panellist`、`main`、`shell.overlay`、`sidebar.right.pane.tab`、`conversation.session.header.actions`、`conversation.chat.node`、`conversation.chat.turnTail`、`conversation.input.dock`、`conversation.composer`、`sidebar.workspaces.session.menu.item`（0.2.2 起是“旧式”菜单插槽，排在归档之前） | 浏览器端所有入口 | 对应的入口不显示 |

**升级冒烟清单**（新 DSH 版本，先在隔离环境 `DSH_HOME=~/dsh-clean`，再在桌面版）：

| # | 操作 | 期望 |
| --- | --- | --- |
| 1 | `npm run check`，devDependencies 换成新版本后再跑一次 | 类型检查和测试都过 |
| 2 | 装 `.tgz`，打开 DSH | 插件页有 dsh-threads；左侧有“项目”入口和“项目”分组；没有新的崩溃日志 |
| 3 | 新建项目（系统文件夹选择器） | 打开主对话；工作区列表里看不到它 |
| 4 | 新项目的主对话里，第一条就发 `/thread 列出根目录的文件` | 马上离开欢迎页，`thread ·` 那一行下面出现 #1 的卡片；开出 #1，回报唤醒主对话；卡片、侧栏 ↳1 都对 |
| 5 | `/thread -w 新建一个文件并提交` | worktree 和分支建好，回报带分支；`/thread cleanup confirm` 能删 |
| 6 | 开一个 `sleep 60` 的讨论串，分别用面板头“停止”和输入框里 DSH 自带的停止按钮停；再各来一次，让讨论串把 `sleep` 放进后台任务（`run_in_background`），停掉后等它跑完 | 都不被提醒叫醒，主对话收到安静的 stopped 回报；后台任务跑完后讨论串最多说一两句，卡片一直是“已停止”，`thread_status` 带“用户已停止”，主对话没有收到 `done` |
| 6b | 开一个讨论串：把 `sleep 40; echo x` 放进后台任务，不等它，先回报“已启动”就结束这一轮，任务结束后再回报 | 主对话被唤醒两次；第二条便条带“补交的回报”那一行，卡片显示第二份回报 |
| 7 | 归档、取消归档一个讨论串；归档、取消归档项目 | 列表、计数、侧栏都跟着变 |
| 8 | 项目设置：换协调器模型和讨论串模型 | 生效，DSH 的全局默认模型不变 |
| 9 | 主对话设成 ask 模式，开一个写文件的讨论串（隔离的官方 DSH，§六 第 8 条） | 讨论串弹审批，不自动通过 |
| 10 | 切换 DSH 的界面语言 | `/thread stop 99` 的回复跟着换语言 |
| 11 | 把窗口缩到 767px 以下（没装 dsh-web-mobile）：项目页、新建项目、项目设置、项目菜单 | 一列卡片，对话框不超出窗口、内容能滚动，通知档位直接列在菜单里；项目页顶部没有多出的空白 |
| 12 | 装了 dsh-web-mobile 的 Web 版，用手机宽度（或浏览器的触屏模拟）：项目页、从抽屉点项目行、新建项目（“选择文件夹…”） | 标题不被返回键盖住；抽屉收起；对话框是居中的卡片，选文件夹退回手填路径并有说明 |
| 13 | 展开的侧栏里看“项目”分组和下面的“工作区”列表 | 分组标题、行图标、行文字、右边的“+”和工作区列表各自对齐 |
