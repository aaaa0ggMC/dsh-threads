# dsh-context 联动调查：讨论串的 token 用量能不能计入

## 结论（TL;DR）

**按会话的计量一直是自动的，缺的只是"归属"。** dsh-context 按会话收集并展示用量，
讨论串就是普通 DSH 会话（src/host.ts 的 `createSession` 走 `sessionController.create`，
挂在主对话同一个 workspace 下），所以在它的「上下文洞察」页里本来就有自己的一张卡片，
token / 轮次 / 成本都算，标题是 `#N <标题>`（manager 开串时 rename）。

真正没有的是：把讨论串用量**汇总到主对话或项目**。dsh-context 没有"项目 / 主对话"概念，
它的家族口径（Fleet 标签页、Context Stats 的 Agent Network 单元格）只认官方子代理和
Agent Team 成员（会话日志里的 `subagent/catalog`、`subagent/descriptor`、`team/member`
事件），而讨论串按设计不做成官方子代理（理由见 docs/IMPLEMENTATION.md
「为什么不用官方子代理」）。dsh-context 也没有任何"接收外来用量"的服务或 API。

因此选 **B（只交文档）**：小而安全的集成不存在，见下面「真联动需要什么」。

## 调查对象与方法

- dsh-context@0.82.1（npm 包，作者 bowenliang123，仓库 github.com/bowenliang123/dsh-context），
  安装于 DSH web profile 的 node_modules。读的是：README.md、lib/index.js（宿主）、
  lib/client.js（浏览器）、lib/index.d.ts、cordis.patch.yml、locale/*.json。
- 对照 DSH 0.2.1-rc.2 实现源码：`dsh-session-projection`（投影注册表契约）、
  `dsh-session-projection-cache`（持久化投影缓存）、`dsh-api-session-controller`
  （`projections` / `create`）、`dsh-token-meter`（tokenUsage 投影的同类）。
- 本插件侧：src/host.ts、src/projects.ts、src/manager.ts、docs/IMPLEMENTATION.md。

## dsh-context 读什么

1. **会话日志**：`sessionQuery.listSessions()` 列出全部持久化的会话（不只是侧栏里挂着的）；
   单会话明细用 `sessionQuery.observeSession` / `sessionPersistence` 折叠日志。
2. **自己注册的三个会话投影**（`ctx.sessionProjections.register`，宿主 `inject` 只有
   `['sessionProjections']`）：
   - `contextTimeline`——构成、逐请求趋势、事件、文件活动、命令执行（当前构建 stateVersion 38；
     启动时会把持久化行从 36/37 扫到新形状）；
   - `contextHeaders`——请求头里的系统提示 / 工具定义及其 token；
   - `contextActivity`——按天的 token、请求数、成本、工具 / 技能 / 命令计数。
   三个都带 wire view，即在 `SessionProjectionMap` 里，是客户端可见的。
   投影注册表订阅一次 `session/event`，对**所有**会话的已提交事件跑 fold；状态写进
   `session_projcache` 存储域（写点：建会话、`turn/end`、会话销毁，外加节流写回）。
3. **现场会话**：`sessions` 服务（`subagentAddress(id)` 解析父子关系）。
4. **systemPrompt**：把偏好设置里的前缀 / 后缀拼进每个会话的系统提示。
5. **configForms**：插件设置卡片。

## dsh-context 注册 / 暴露什么

- **没有对外服务**：宿主侧不 `ctx.set` 任何服务（index.js 里两处 `e.set` 都是内部 Map），
  没有事件、没有命令、没有"上报用量"的入口。
- HTTP 路由全部挂在 `/api/dsh-context/` 下，只服务它自己的浏览器端：
  `snapshot`（按 sessionId 取投影值，列全部会话）、`backfill`（把缺行的会话从持久日志
  冷折补齐并写回缓存）、`detail`、`fleet`、`commands`、`skills`、`balance`、`recom`、
  `attachment`。
- 浏览器端槽位：`conversation.view`（Context 标签页）、`sidebar.right.pane.tab`
  （Context 面板）、一级侧栏面板（上下文洞察页）、`conversation.input.overlay`
  （`/context` 命令）、`plugins.bundle.config`（设置卡）、
  `conversation.chat.assistant-actions`。
- locale/*.json 只有 meta 标题和描述；界面文案在浏览器端用 `ctx.locale.register` 注册。

## 数据口径

- **按会话**：Context 标签页、`/context` 命令都只看当前会话自己。
- **跨会话**：上下文洞察页。KPI、7 天用量图、活动热力图、组成环、会话卡片，都是从
  `/api/dsh-context/snapshot` 返回的**所有会话**投影值在浏览器端聚合的；分组按
  workspace / 项目路径。有时间范围（今天 / 7 天 / 30 天 / 全部）和会话状态
  （全部 / 活跃 / 归档）筛选。
- **家族**：Fleet 标签页和 Agent Network 单元格 = 当前 Agent + 父级 + 子 Agent，
  证据只来自会话日志里的 `subagent/catalog`、`subagent/descriptor`、`team/member`
  事件，即官方子代理和 Agent Team 成员。

## 讨论串在它眼里是什么

可见，而且是"正常会话"：

- `createSession` 传主对话的 `workspaceId`，`sessionController.create` 会
  `workspace.attachSession(sessionId)`——讨论串是该 workspace 的成员，和主对话同组。
- 讨论串跑起来时是宿主里的活会话，已提交事件照样驱动 dsh-context 的三个 fold；
  `turn/end` 等写点把 `contextTimeline` / `contextActivity` 行写进投影缓存。
  没装 dsh-context 时跑出来的旧会话，由洞察页触发 `backfill` 从持久日志补折。
- 于是：洞察页里讨论串是普通会话卡片（`#N <标题>`，与主对话同一 workspace 组），
  它的 token、轮次、成本进入 KPI、7 天图、热力图和组成环。
- 但主对话的 Context 标签页只有主对话自己；Fleet / Agent Network 不含讨论串。

## 为什么不联动

「无法计入」的实际含义是**没有归属和汇总**：dsh-context 既没有项目 / 主对话概念，
家族口径又只认子代理 / 团队成员，而讨论串两者都不是。它的数据入口只有会话日志本身，
没有任何服务、事件或投影键能让第三方插件把用量"递"进去。

## 真联动需要什么（三条路，都不小）

1. **改 dsh-context**：加"项目 / 父会话归属"概念，或开一个外来用量摄入 API。
   违反本次约束（不得改 dsh-context），应作为上游 feature request 提给它。
2. **把讨论串做成官方子代理 / 团队成员**：能进家族视图，但 docs/IMPLEMENTATION.md
   已记录为什么不这么做（只能从主会话标题栏进、用户回消息时主会话必须活着、审批被钉成
   `never`、最多 8 个），等于重写线程模型。
3. **伪造会话事件或投影缓存行**：会污染 DSH 自己的计量和主会话日志，不可接受。

## 反向可行的一条（未实现）

dsh-context 的三个投影都带 wire view，任何插件都能用
`sessionController.projections({ sessionId })` 的 `values` 读到——本插件读 `tokenUsage`
（由 dsh-token-meter 注册）走的是同一机制。理论上可以在项目设置里补"预估成本"。

没做的原因：那是给本插件加功能，并不是把讨论串用量计入 dsh-context；而且会软依赖
第三方插件的 wire 形态，它的 `stateVersion` 自己在 36 → 37 → 38 翻，形状会随版本变。

（给将来留一笔：本插件可以自己注册一个投影键，比如主会话上的线程汇总，但 dsh-context
今天只读自己的键，注册了也没有消费者。）

## 建议

- 维持现状：要"项目级"总览，用本插件项目设置里的「使用情况」（主对话 + 各线程合计）。
- 要在 dsh-context 里看线程：打开「上下文洞察」页，按 workspace 分组，找 `#N` 开头的
  会话卡片；归档过的线程可能要切一下会话状态筛选。
- 想要真正的归属 / 汇总：去 dsh-context 仓库提 issue（它读什么、为什么不联动，本文档
  可以直接当素材）。

## 未验证事项

- 本次不开浏览器，"洞察页里线程卡片长什么样、筛选默认值是什么"没有实机点选验证。
- "线程的投影缓存行已写入"是从写点策略（建会话 / `turn/end` / 销毁）+ 线程是活会话推出来的，
  没有实机核对 `session_projcache` 的内容。
- 反向读取 `contextTimeline` 没有实跑；dsh-context 的路由和投影键是从 0.82.1 的产物里
  读出来的，换版本可能变。
