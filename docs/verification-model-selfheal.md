# 真实验证：「开线程时校验并自愈模型」（提交 9b54373）

- 日期：2026-11-14
- 被验证对象：`fix: check and self-heal a thread's model when it opens`（9b54373，dist 同步于 5fac30f）
- 环境：DSH 0.2.1-rc.5（`/usr/local/bin/dsh`，与用户 live 版一致）；隔离 home
  `~/ai-workspace/dsh-verify`（自选理由：AGENTS.md 规定临时/实验产物放 `~/ai-workspace/`，
  且它明显不是 live home，误操作面最小）；**用户 live home `~/.dsh` 全程未用作运行环境**
  （live 的 web 进程 3080 一直在跑，未受影响）。
- 结论：**场景 1（回归）、场景 2（P1 主场景）、场景 3（P2）在真实 DSH 里全部通过**；
  场景 4（目录读取失败）未在真实环境强制触发，见「未覆盖」。

## 一、实际走通的驱动路径

### 1.1 为什么不是 headless

最初按任务书走 `dsh headless`，撞上三个墙，记录如下（都是 DSH 的真实行为，不是插件问题）：

1. **headless profile 装不上本插件**：插件 `inject` 里有 `sessionController` / `workspaceRegistry`，
   而这两个服务只有 web-app bundle 会挂（`dsh-api-session-controller`、`dsh-workspace` 只出现在
   web-app 的 patch 里）。解决办法：在隔离 home 的 patch 里直接 `insert` 这几个插件行
   （session-controller → fileUploads → connection，是一条 inject 链，还要把 headless 禁掉的
   `credentials` 放回来）。见 `patches/base.yml`。
2. **headless 一次性 runner 会把主对话的请求钉死在「启动时的部署默认」上**：runner 自己
   `installModelSelection({ current: 启动时的 default })`，`agent/request` 用它覆盖请求头，
   会话自己的耐久选择（request/header）会被盖掉。所以「默认模型失效时主对话靠自己的耐久选择
   活着、只有新会话（线程）继承失效默认」这个事故形状，在 headless 下复现不了——主对话第一个
   请求就用失效模型直接失败。
3. **runner 主对话一空闲就退进程**：线程是同一进程里的另一个会话，主对话回合结束进程就退，
   线程可能还没发出第一个请求（要额外给 mock 加延时拖住主对话，很脆）。

### 1.2 最终路径：SDK profile + stdio JSON-RPC（`dsh --profile sdk`）

SDK runtime 的模型由**客户端**在 `initialize` 时给（`{provider, model}`），会话也用客户端指定的
session id 创建——正好是「主对话有自己能用的模型、部署默认是失效的」这个形状，也和 web profile
里主对话保有自己的会话级选择一致。

- 驱动脚本：`sdk-driver.mjs`（spawn `dsh --profile sdk --patch …`，说换行分隔的 JSON-RPC：
  `initialize` → `session/prompt` → `session/wait` → 收 `session.event` 通知 → `shutdown`）。
- 项目记录：插件要求「只有项目的主对话能开线程」，headless/sdk 下没有 UI 也没有 RPC
  （`connection` 在 sdk profile 里没有浏览器端），所以直接按存储域格式手写
  `storages/dsh_threads.json` 的 projects 表（`seed.mjs`，字段严格按 `src/storage.ts` 的 zod
  schema；workspaceId 用该目录真实 workspace 的 id）。
- LLM：本地 mock OpenAI 兼容端点（`mock-llm.mjs`，127.0.0.1:3741，零成本、确定性）。
  它按「会话的第一个用户消息 + 该会话实际拿到的工具」决定回复：主对话 → `thread_open` /
  `thread_status` 工具调用，线程 → `thread_report`，工具结果原样回显（这样 headless/driver
  的 stdout 就是工具输出）。**每一次请求的 model 字段都落盘**（`mock-requests.jsonl`），
  这是「线程绝没用失效模型」的直接证据。
- warn 可见性：sdk/headless profile 里 `ctx.logger.warn` 只有内存缓冲、没有 stderr exporter，
  所以在隔离 home 里挂了一个只读探针插件 `probe-logger`（`ctx.logger.exporter` → stderr），
  纯粹为了观察，不改变任何行为。

patch 骨架（脱敏；key 全是占位 env 名，未出现任何真实 key 值）：

```yaml
# patches/base.yml（每次运行都加）
- id: llm-pi-ai                       # 本地 mock provider：两个可用模型
  config: { providers: { mock: { apiKeyEnv: MOCK_API_KEY, api: openai-completions,
           baseURL: http://127.0.0.1:3741/v1, models: [mock-1, mock-2] } } }
- id: agent-default-model             # 有效部署默认
  config: { provider: mock, model: mock-1 }
- insert: [workspace, session-controller, connection, file-upload, verify-probe-logger]  # 插件依赖链
- id: credentials
  disabled: false                     # headless/sdk 默认关掉，file-upload 需要它
```

```yaml
# patches/invalid-default.yml（仅场景 2 追加）
- id: llm-pi-ai                       # 追加一个没有凭据的 provider
  config: { providers: { …, stale: { apiKeyEnv: STALE_PROVIDER_KEY_UNSET, models: [stale-1] } } }
- id: agent-default-model             # 部署默认指向目录里没有的模型
  config: { provider: stale, model: stale-1 }
```

运行命令原文（脱敏）：

```bash
DSH_HOME=~/ai-workspace/dsh-verify MOCK_API_KEY=<占位> DSH_PERMISSION_MODE=danger-full-access \
  node sdk-driver.mjs s2b \
  --patch patches/base.yml --patch patches/invalid-default.yml \
  -- "Open another thread that checks the git status of this working directory and reports back what it finds. Use the thread_open tool with initiation user_asked."
```

## 二、三个场景的结果

线程都是 `worktree: false`、`initiation: user_asked`；每个场景一个独立的主会话/项目/线程，
证据 = 驱动 stdout + probe 捕获的 warn + 线程会话日志 + 插件 store + mock 请求日志。

### 场景 1：回归（有效默认）——通过

- 部署默认 `mock/mock-1`（在目录里）。主对话 `thread_open` → 开出 #1，线程跑完 `thread_report`
  （status=idle，report=done），线程照常打开。
- **没有 `dsh-threads` 的 warn**（probe 只看到无关的 workspace-registry / goal-round-driver 提示）。
- **线程会话日志里 0 条 `model/selection` 事件** ⇒ 插件没有调 `applyModel`，与修复前行为一致。
- 线程的请求头 = `mock/mock-1`（继承默认），投影 `modelSelection.lastUsed = mock/mock-1`。
- `thread_status { n: 1 }` 详情带模型行：

  ```
  Thread #1 "mock thread" · idle (session session-ef50e83c-…)
  Model: mock/mock-1
  Task: Check `git status` in the working directory …
  Latest report (2026-11-14T18:33:58.967Z, done): Mock thread round finished …
  ```

### 场景 2：P1 主场景（部署默认指向目录里没有的模型）——通过

- 部署默认 `stale/stale-1`：`stale` provider 配了模型但没有凭据，`llm.listModels('stale')`
  返回空 ⇒ 该 provider 从 `sessionController.modelCatalog()` 的 groups 里消失——这正是
  「设置里删了模型」之后目录的形状（模型还在配置里、还能给新会话 seeding，但目录不再提供它）。
  主对话由 SDK 客户端指定跑 `mock/mock-1`（模拟 web profile 里主对话保有自己的会话级选择）。
- 开线程时插件 warn（probe 捕获，原文）：

  ```
  [probe 2026-11-14T18:33:39.749Z] warn dsh-threads: This thread would have used stale/stale-1
  by default, but it is no longer in DSH's model catalog, so it uses mock/mock-1 instead.
  ```

- 线程会话日志（自愈指纹 + 实际请求头）：

  ```
  {"type":"model/selection","seq":3,…,"data":{"provider":"mock","model":"mock-1"}}   ← applyModel→selectModel
  {"type":"request/header","seq":13,…,"config":{"provider":"mock","model":"mock-1",…}}  ← 线程唯一的请求头
  ```

  `model/selection` 在第一个 `request/header` 之前，全日志没有任何 `stale` 的请求头；
  mock 请求日志里**没有任何一个请求的 model 是 stale-1**——失效模型一次都没被用过。
- 线程照常打开、跑完、回报 done；`thread_status` 详情 `Model: mock/mock-1`（自愈后的模型）。
- 附带观察（测试装置副作用，非插件问题）：`selectModel` 后台 `saveSelection` 在默认被
  `--patch` 覆盖时会失败并 warn「Configuration for "agent-default-model" is overridden by a
  home patch or command-line overlay」——因为验证用 patch 改默认，真实部署里配置可写、不会这样。

### 场景 3：P2（项目存储的 threadModel 是伪造选择）——通过

- 种子把项目记录写成 `threadModel = {provider: "gone-provider", model: "gone-model"}`。
- 开线程时插件 warn（probe 捕获，原文）：

  ```
  [probe 2026-11-14T18:32:55.857Z] warn dsh-threads: The project's thread model
  gone-provider/gone-model is no longer in DSH's model catalog, so it was cleared;
  this thread uses mock/mock-1 instead.
  ```

- **项目记录被清成 null 且 updatedAt 被改写**（store 实测：seed 时
  `updatedAt=18:32:54…`，运行后 `threadModel=null, updatedAt=18:32:55.679Z`）——自愈写回生效，
  下次开线程不再被同一个失效选择绊一次。
- 伪造选择没有交给 DSH（没有 `session/model-unavailable` 类的报错），线程回落到目录默认
  `mock/mock-1` 并跑完；`thread_status` 详情 `Model: mock/mock-1`。
- 若没有修复，这条路径会走 `applyModel(gone-provider/gone-model)` → `selectModel` 的
  `requireModel` 拒绝 → 插件 catch 后 warn「keeps the default model」；修复后是「清记录 + 自愈 +
  明确 warn」，语义更好且下次干净。

### 场景 4：退化路径（目录读取失败）——未在真实环境触发

`threadModelFor` 的 try/catch 包住 `modelCatalog()` 和 `effectiveModel()`，任一抛错就
`modelCheckFailed` warn 并原样返回存储值（null 时啥都不 apply）——不挡开线程。真实环境里
`modelCatalog()` 对单 provider 失败是隔离成 `failures` 的、`projections()` 有 5s 超时，
都不容易强制抛错；要不打断驱动（主对话也活不了），就没做。该分支由单元测试覆盖
（`modelCheckFailed`），真实环境未覆盖。

## 三、与单元测试的差异 / 真实环境多发现了什么

1. **真实 RPC 而非 mock**：单测 mock 掉 `host.modelCatalog`/`effectiveModel`；真实验证走的是
   DSH 真的 `sessionController.modelCatalog()` / `projections()`，以及真的 `selectModel`
   （会落耐久 `model/selection` 事件、会后台 `saveSelection`）。自愈的指纹就是会话日志里
   请求头之前的那条 `model/selection`。
2. **`thread_status` 模型行端到端**：单测只验 `describe()` 文本；这里是主对话真的调
   `thread_status` 工具、结果真的带 `Model: mock/mock-1` 回来。
3. **DSH 0.2.1-rc.5 的两个真实行为**（调研文档之外的新事实）：
   - 部署默认指向「provider 没配的模型」或「provider 没凭据的模型」时，DSH 建/恢复会话直接
     失败（`UNKNOWN_MODEL` / `MISSING_CREDENTIAL`）——失效默认不是静默的，是硬失败。
     所以场景 2 只能用「provider 没凭据 ⇒ 目录不列它、但模型仍可解析」这个形状驱动；
     这也意味着**修复真正发挥作用的场合，是目录确实不再提供该模型、但会话仍会被 seeding 的那些状态**。
   - 事故当时的准确形状（provider 留着、`models` 被删空 ⇒ pi-ai 服务内置目录）下，该模型
     **仍在目录里**（`catalogHas` 为真），插件这个目录校验按设计不会自愈。这点在
     `docs/bug-thread-stale-model.md` 里已写明（「仍然可路由、仍然在目录里」），这里用真实
     目录再次确认：修复挡住的是「目录真的没有它」的同类状态，不是那一个确切状态。
4. **未用真 provider**：为了零成本与确定性，LLM 用本地 mock（OpenAI 兼容）。DSH、插件、
   工具机制、目录/投影读取、自愈逻辑全是真的；假的是模型的决策（canned 的
   thread_open/thread_report/thread_status 调用）。没有花任何真 key 的钱。
5. headless 驱动路径的三个坑（见一.1）也是收获：插件在纯 headless profile 下需要补
   session-controller/workspace/connection 等 inject 链，且 headless runner 会把主对话钉在
   启动时的默认模型上。

## 四、未覆盖清单

- 场景 4（目录/投影读取失败的退化路径）——单测覆盖，真实环境未触发。
- 真实 provider 端到端（step-plan 等）：未跑，无花费；mock 端点替代。
- worktree 线程、`offer`/`proposal`  initiate、浏览器 UI（项目设置里的模型下拉、侧栏卡片）未涉及。
- 主对话自身的模型选择 UI/耐久选择与自愈的交互（web profile 里主对话模型被删后如何）未涉及。
- `applyModel` 存回旧默认的既有隐患（`docs/IMPLEMENTATION.md` 记录的第 4 条建议）未验证。

## 五、复现方式

隔离 home 在 `~/ai-workspace/dsh-verify/`（未提交、可随时删除）：

```
run-scenarios.sh     # 场景 1–3 + thread_status + 终态报告（sdk profile 驱动）
sdk-driver.mjs       # stdio JSON-RPC 驱动
mock-llm.mjs         # 本地 mock LLM 端点（127.0.0.1:3741）
seed.mjs / report.mjs# 项目记录种子 / 状态与证据转储
patches/base.yml、patches/invalid-default.yml
mock-requests.jsonl  # 每一次 LLM 请求实际带的 model（核心证据）
```

注意：本机 shell 默认导出 `DSH_HOME=~/.dsh`（live home），任何脚本都必须显式覆盖
`DSH_HOME`——本次有一个脚本漏了覆盖，误把一个种子项目写进了 live 的
`~/.dsh/storages/dsh_threads.json`，已当场删除该条记录恢复原状（记录数、内容、格式与
DSH 自己的写手一致，live 的 web 进程未重启、未受影响）。`seed.mjs`/`report.mjs` 现在会
在 `DSH_HOME` 未设置或指向 live home 时拒绝运行。
