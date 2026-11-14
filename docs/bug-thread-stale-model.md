# 调查：删了模型后线程仍在用、且线程模型列表变多

- 日期：2026-11-14
- 环境：DSH 0.2.1-rc.5（本机运行版源码 `/usr/local/lib/node_modules/@deepseek-ai/dsh`，只读）；
  插件 dsh-threads（本 checkout）；最新源码对照 `~/Projs/dsh-latest`（master `39163dd`，2026-11-13）。
- 约束：本调查不改插件代码、不提交；文档保持 untracked。

## 结论（TL;DR）

**主要是 DSH 的问题，插件有一处韧性缺口（不是本事故的直接原因，但放大了后果）。**
「没钱了」的上报是插件本周上线的失败上报特性，按设计工作，不是 bug。

1. **线程为什么还在用已删除的模型**：插件存储的项目模型配置自项目创建起就是
   `mainModel: null / threadModel: null`（从没给线程设过模型），所以不是插件记录陈旧。
   真正原因是 DSH 的两层持久化都没有校验：
   - **部署默认模型陈旧**：在设置里删掉（provider 保留）精选模型时，`agent-default-model`
     配置原地不动（`currentSelection()` 只读 config，无目录校验、无删除级联）；
   - **新会话用无校验的默认 seeding**：`session-controller` 的 `agentOptions()` 把
     `agentDefaultModel.currentSelection()` 直接作为新会话初始模型，不查目录；
   - **会话级选择耐久且不重校验**：会话一旦发出请求，`model/selection` 投影把
     `{provider, model}` 折成 `lastUsed` 写进会话日志，之后每一轮、每次恢复都复用它，
     永不重新校验——所以设置里删了模型，正在跑和以后开的线程照样继续用，并且**真的在花钱**。
2. **线程模型列表为什么变多**：线程里的模型选择器是 DSH 自己的
   `dsh-client-ui-model-selection`，目录来自 RPC `session.modelCatalog`。
   **插件没有向线程的模型列表注入过任何东西**（插件的 `models.catalog` 只服务本项目
   设置 UI，见 src/client/ProjectModels.tsx）。变多的原因是 DSH 的有意设计：
   `dsh-llm-pi-ai` 的 `resolveRouteModels` 规定「`models` 键缺失与为空是同一意图——
   都表示服务 pi-ai 内置目录」，而 OpenRouter 的内置目录有约 490 个模型
   （386 openai-completions + 15 anthropic-messages + 63 图像 + 28 分类）。
   删空精选列表 ⇒ 选择器突然列出几百个模型。
3. **coordinator 与花钱的关系**：coordinator（主对话会话）全程只用 step-plan/step-5-preview
   （它自己的会话级选择，创建时定型），项目 `mainModel` 为 null、插件从未 apply。
   花 OpenRouter 钱的是子代理会话和 thread #16——它们的模型来自陈旧的部署默认，
   与项目模型配置无关。coordinator「停下来报告没钱了」是插件把 thread #16 的轮次失败
   （402）写进主对话后，主对话转述给用户。
4. **最终判定**：两个根因都在 DSH 侧（删除不级联/不校验 + 空列表暴露全量目录），
   且**最新版未修**（见「最新版对照」）。插件侧缺口：`threadModel` 为 null 时完全继承
   DSH 默认且从不校验、存储的模型选择无自愈、设置 UI 对失效选择无提示。

## 时间线（均为 2026-11-14 UTC，证据见下）

| 时间 | 事件 |
| --- | --- |
| 05:06 | 事发项目创建；项目记录此后未再更新（`mainModel/threadModel` 保持 null） |
| 16:04:06 | 一个**非插件线程**的会话被显式选择 `openrouter/~anthropic/claude-opus-latest`（`model/selection` 事件）。`selectModel` 会顺带把默认模型存成它——**部署默认从这一刻起变成 OpenRouter Claude** |
| 16:06–16:19 | 该会话完整跑了一轮（日志中 104 处 openrouter 引用，约等于整轮请求数）——「干了点活、花了 2.4 USD」的部分 |
| ~16:20–16:49 | 用户在设置里删掉该模型（provider 保留）：profile 的 `llm-pi-ai.providers` 失去精选列表；`agent-default-model` 仍是 openrouter/claude（无级联） |
| 16:49:20 | coordinator 派发 thread #16。项目 `threadModel` 为 null ⇒ 插件不 applyModel ⇒ 新会话被 DSH 用**陈旧的部署默认** seeding |
| 16:49:21–17:02:42 | thread #16 第 1 轮：43 条 assistant 消息 / 44 步，全部走 `openrouter/~anthropic/claude-opus-latest`（真实计费请求，不是报错后空转），末了 `turn/end` reason=error：**402 "This request would exceed your available credits…"（code PI_AI_ERROR）**。线程记录置为 failed，error 字段即该失败原因 |
| 17:02 之后 | 插件失败上报把「失败：402 …（code PI_AI_ERROR，HTTP 402）。这一轮的模型调用失败了……」送进主对话——coordinator 转述为「没钱了」 |
| 17:07:43 | 用户在选择器里把该线程模型换成 `step-plan/step-5-preview`（`model/selection` 事件 + DSH 的 `[model changed: …]` 提示）；默认随之存回 step-plan（profile patch 文件 mtime 17:07） |
| 全程 | thread #16 派生的两个子代理会话（…c640925b、…f92d44d0）也跑在 openrouter/claude 上并「failed before it finished」——同一条陈旧路由 |

> 注：删除模型的确切时刻在磁盘上不可直接取证（profile patch 只保留最后一次写入，
> 即 17:07 存回默认那一次）；「先删模型、再派活」按用户口述，机制分析不依赖该顺序——
> 无论删除发生在派发之前还是 402 之后，根因相同。

## 证据链

### A. 插件侧（本 checkout，只读）

- 插件存储 `~/.dsh/storages/dsh_threads.json`（tables.projects）：事发项目
  `mainModel: null`、`threadModel: null`，`updatedAt` 停留在项目创建时刻 ⇒
  **插件从未给任何线程设过模型**，threadModel 陈旧说不成立。
- 同文件 threads 表：thread #16 记录 `status: failed`，
  `error: '402: {"message":"This request would exceed your available credits…","code":402,…(code PI_AI_ERROR)'`。
- src/manager.ts `openNow`（244–249 行）：只有 `threadModel !== null` 才
  `host.applyModel`；为 null 时静默继承 DSH 默认。
- src/host.ts `applyModel`（126–143 行）：读 DSH 默认 → `selectModel` → 存回上一个默认。
  本事件中它**没有被调用过**（项目两个模型字段都是 null），所以「默认存回逻辑把旧选择写回」
  在本事故里不成立（它只是一个相关隐患，见下）。
- src/projects.ts `update`（204–210 行）：仅当 `mainModel` 变化时才 applyModel。
- src/index.ts 73 行 + src/api.ts 135 行：`models.catalog` 的唯一消费者是
  src/client/ProjectModels.tsx（项目设置 UI）。**插件不写线程的模型列表。**
- 失败上报路径（特性）：src/manager.ts `onIdle` → `host.roundFailure`
  （src/host.ts 237–255 行，读 `turn/end` 的 `reason.error` 即 LlmFailure）→ `settle`/`noteOf`
  → src/messages.ts `failureReason`/`noteFailure`。上线于提交 `fbf8df3`
  （2026-11-07，「report why a round failed to the main conversation」）。

### B. DSH 侧（0.2.1-rc.5 安装版，与最新源码逐条对照）

1. **新会话的模型 seeding 无校验**：`dsh-api-session-controller/lib/index.js`
   `agentOptions()`（527–533 行）直接取 `ctx.agentDefaultModel.currentSelection()`
   的 provider/model；`createAgent`（511–526 行）把它交给 `agents.create`。
2. **默认模型服务无校验、无级联**：`dsh-agent-default-model/lib/index.js`
   `currentSelection()`（38–45 行）只读 config；`saveSelection`（53–66 行）写 profile 配置。
   删除设置里的模型不会触动它。
3. **`selectModel` 的副作用**：`dsh-api-session-controller/lib/index.js` 793–821 行——
   先 `requireModel`（`modelAvailable`：provider 在 `listProviders()` 且 model 在
   `listModels(provider)` 里），再 `agents.selectForNextRequest(agent, selected)`
   （**追加耐久的 `model/selection` 事件**），并**在后台** `agentDefaultModel.saveSelection(selected)`。
   这就是 16:04 那次选择把部署默认改成 OpenRouter 的机制。
4. **会话级选择的复 hydration**：`dsh-api-session-controller/lib/types/agent.js`
   `selectionFor(agent).current`（279–319 行）：有记录的选择 ⇒ 用记录；否则有请求头 ⇒
   **用请求头里的 provider/model**；都没有才回落到默认。`dsh-agent` 的
   `modelSelection` 投影（`dsh-api-session-controller/lib/index.js` 2136–2169 行）把
   `model/selection`/`request/header` 折成 `lastUsed`——**设置里删模型不会改它**。
5. **目录组装**：`buildModelCatalog`（563–611 行）= `llm.listProviders()` ×
   `llm.listModels(provider)`；pi-ai adapter 的 `listModels`
   （`dsh-llm-pi-ai/lib/index.js` 1887–1904 行）返回 profile 解析出的模型。
6. **删空精选 ⇒ 全量目录**：`resolveRouteModels`
   （`dsh-llm-pi-ai/lib/index.js` 656–678 行）
   `const entries = configured.length > 0 ? configured : [...defaults.values()]…`。
   pi-ai 安装目录 `dist/providers/data/openrouter.json`：386 + 15 + 63 + 28 ≈ 490 个模型，
   其中就包含 `~anthropic/claude-opus-latest`——所以删掉精选模型后，该模型**仍然可路由、
   仍然在目录里**，请求照发，直到余额耗尽才报 402。
7. **会话日志取证**（解压 `session.v4.jsonl.zstd`）：
   - thread #16：seq 19 `request/header` config = `{openrouter, ~anthropic/claude-opus-latest}`
     （第一个请求头，之前没有任何 `model/selection`——继承来的）；131 处 openrouter 引用；
     17:02:42 `turn/end` error 402；17:07:43 `model/selection` → step-plan。
   - 主对话会话：只有 step-plan 的请求头，**没有任何 `model/selection` 事件**。
   - 子代理会话 …2554ff90：16:04:06 `model/selection` = openrouter（显式选择，
     `selectModel` 后台存默认）；16:06–16:19 整轮 openrouter。
   - 投影缓存 `~/.dsh/storages/session_projcache/sessions/*.json`：thread #16 的两个子代理
     `modelSelection.lastUsed = openrouter/~anthropic/claude-opus-latest`。
8. **profile 配置现状**：`~/.dsh/profiles/web/cordis.patch.yml` 的 `llm-pi-ai.providers`
   只剩 xiaomi / xiaomi-token-plan-cn / step-plan（**openrouter 已不在**）；
   `agent-default-model` 现为 step-plan/step-5-preview（17:07 存回的结果）。

## 四个问题的逐条结论

### Q1 线程为什么还在用 Claude

**不是插件存储的 threadModel 陈旧，也不是 applyModel 的默认存回逻辑；是 DSH 的
「陈旧默认 seeding + 会话级选择耐久」两层持久化，都没有任何目录校验。**

- 插件记录：项目两个模型字段自创建起为 null，`openNow` 因此从不调用 applyModel。
- DSH 默认：16:04 某次显式 `selectModel` 把部署默认改成 openrouter/claude（后台存默认）；
  16:20–16:49 用户在设置里删模型时没有任何东西更新或校验这个默认。
- 新会话：16:49:20 thread #16 被创建，`agentOptions()` 用陈旧默认 seeding；
  第一个请求头记录后，`modelSelection.lastUsed` 把它变成会话的耐久状态。
- 结果：设置里已删除的模型，线程照用不误，并且**持续发出真实计费请求**
  （第 1 轮 43 条 assistant 消息 / 44 步）直到 OpenRouter 余额耗尽报 402。
- `applyModel` 的「存回上一个默认」逻辑（src/host.ts 137–142 行）在本事件未参与；
  它依赖「保存按提交顺序执行」的注释假设，是个值得留意但独立的隐患。

### Q2 线程里模型列表为什么有很多模型

**DSH 的有意设计 + 插件完全无关。**

- 线程模型选择器（`dsh-client-ui-model-selection`）的目录来自 DSH 自己的
  `session.modelCatalog` RPC；插件的 `models.catalog` 只给项目设置 UI 用，
  没有任何代码路径向线程的模型列表注入模型。
- provider 保留、精选模型被删空后，`resolveRouteModels` 的
  「空/缺失 `models` ⇒ 服务内置目录」规则生效，OpenRouter 一次性暴露约 490 个模型。
  规则本身有明确注释（为了 `providers: { deepseek: { apiKeyEnv: … } }` 这类极简配置可用），
  属设计取舍；缺失的是**设置 UI 删除最后一个模型时的提示**。

### Q3 coordinator 自己继续花钱与其模型选择的关系

- coordinator 的模型 = 它自己的会话级选择（step-plan/step-5-preview，创建时定型，
  日志中无任何 `model/selection` 事件）；项目 `mainModel` 为 null，插件从未 apply。
  **coordinator 自己没有花 OpenRouter 的钱。**
- 花钱的是：16:06–16:19 被直接使用的子代理会话，以及 16:49–17:02 的 thread #16
  （含其子代理）。它们的模型既不是项目 mainModel 也不是项目 threadModel，
  而是**陈旧的部署默认**经「新会话 seeding / 子代理继承」扩散的结果。
- coordinator「停下来报告没钱了」= 插件失败上报特性把 402 送进主对话，主对话转述。
  路径：`manager.onIdle` → `host.roundFailure`（LlmFailure）→ `settle` → `noteOf`
  （`msg().noteFailure`）。特性，不是 bug。

### Q4 最终判定

**两者皆有，但根因和主责在 DSH：**

- **DSH bug / 设计缺口（根因）**
  - R1：删除设置里的 provider 模型时，不校验、不级联 `agent-default-model`；
    新会话用无校验的默认 seeding；会话级选择耐久且永不重校验。
    ⇒ 「删了模型线程还在用，而且真的在花钱」。
  - R2：精选模型删空 ⇒ 该 provider 暴露 pi-ai 全量内置目录（有意设计，无 UI 提示）。
    ⇒ 「模型列表突然很多」。
- **插件韧性缺口（放大后果，非直接原因）**
  - P1：`threadModel` 为 null 时完全继承 DSH 默认，开线程时从不校验有效模型。
  - P2：存储的 `mainModel/threadModel` 永不与目录对账（DSH 设置删除不经过插件，
    只能校验，无法联动清理）。
  - P3：项目设置 UI 对已失效的存储选择无提示（静默显示原始 model id）。
- **不是 bug**：失败上报（「没钱了」）；插件未向线程模型列表注入任何内容。

## 插件侧可行修复（按性价比排序；均不要求升级 DSH）

1. **开线程时校验 + 自愈**（src/manager.ts `openNow`，直接挡住继续花钱）：
   `host.createSession` 之后读该会话的**有效模型**——
   `ctx.sessionController.projections({ sessionId })` 的 `values.modelSelection.lastUsed`
   （插件已在 src/host.ts `sessionUsage` 用过同一个 RPC；新会话无记录时用
   `modelCatalog().default`）——对照 `modelCatalog()` 的 groups 校验 provider/model
   是否仍在目录里；不在就 `host.applyModel(session, 目录默认/首个可用模型)` 并
   `deps.warn`。同时把项目里失效的 `threadModel` 清成 null（自愈）。
2. **存储选择对账 + UI 提示**：`projects.update` 收到 `mainModel/threadModel` 时对照目录，
   失效则拒绝或清空并提示（可复用 `msg().modelRefused` 文案）；客户端
   ProjectModels.tsx 的 `findModel` 已经能识别失效选择，给它加「已删除，恢复默认」
   的标记和一键重置。
3. **可观测性**：`thread_status` / 开串日志带上线程当前有效模型（同一 projections 读法），
   下次类似问题可直接定位；如需更强，可在每次 dispatch 前轻量复校验（目录是本地读，成本低）。
4. **顺带收紧 applyModel 隐患**（与本事故无关但同源）：`applyModel` 存回旧默认依赖
   保存顺序，失败时主对话/线程的默认可能被悄悄改掉；可在存回失败时 warn。

## DSH 侧应上报什么

1. `agentDefaultModel.currentSelection()` 应对模型目录校验，或设置删除 provider 模型时
   级联更新默认：当前默认的模型被删时，UI 明确警告并/或回退到首个可用模型；
   最低要求是**不要用无法路由的默认给新会话 seeding**。
2. 设置 UI 删除 catalog-known provider 的最后一个精选模型时提示
   「删除后该 provider 将暴露 pi-ai 内置目录的全部 N 个模型」。
3. 轮次开始（或会话恢复）时重新校验会话级选择：模型不再可用则快速失败并给出明确错误，
   而不是让请求真的打到 provider、花了钱才报 402/配额。
4. （可选）`selectModel` 后台保存默认时，若原默认已失效应一并处理或告警。

## 最新版对照（是否已修）

- 最新源码：master `39163dd`（2026-11-13；npm `latest` 0.2.2-rc.1、`next` 0.2.2-rc.3），
  clone 于 `~/Projs/dsh-latest`。
- 逐条对照，**语义与 0.2.1-rc.5 完全一致，均未修**：
  - `packages/api/session-controller/src/commands.ts` `selectModel`（166–195 行）：
    `requireModel` → `agent.model.select` → 后台 `saveSelection`，照旧。
  - `packages/api/session-controller/src/agent.ts` `agentOptions()`（453–461 行）：
    改为惰性 getter（「无记录/无请求的会话跟随默认变化」），**仍无目录校验**。
  - `packages/core/agent-default-model/src/index.ts`（68–74 行）：`currentSelection()`
    照旧只读 config。
  - `packages/llm/llm-pi-ai/src/catalog.ts` `resolveRouteModels`（858–900 行）：
    「absent models key and an empty one are the same request … both mean 'serve the
    installed catalog'」照旧，且注释把该取舍写得更明确。
  - `git log` 无删除级联/默认校验相关修复；仓库无 CLI CHANGELOG（仅 experimental 子包有）。
- **结论：升级 DSH 不解决本问题**；在「暂不升级」前提下，插件侧修复（上面 1–3 条）
  是唯一现实路径，DSH 侧问题按上面清单上报。

## 附：取证方法（复现/自查）

- 插件状态：`~/.dsh/storages/dsh_threads.json`（tables: projects/threads/mains/proposals）。
- DSH 会话日志：`~/.dsh/sessions/<workspace 目录>/<session-id>/session.v4.jsonl.zstd`，
  `zstd -dc` 解压后按行 JSON。关键事件：`model/selection`（显式选择）、
  `request/header`（该轮实际使用的 provider/model）、`turn/end` 的
  `reason.kind === 'error'` 与 `reason.error`（LlmFailure）。
- 会话有效模型（无需解压）：`~/.dsh/storages/session_projcache/sessions/<id>.json` 的
  `record.rows.modelSelection.val.lastUsed`。
- 部署默认与 provider 配置：`~/.dsh/profiles/web/cordis.patch.yml` 的
  `agent-default-model` 与 `llm-pi-ai` 两节。
- pi-ai 内置目录规模：`node_modules/@earendil-works/pi-ai/dist/providers/data/openrouter.json`。
