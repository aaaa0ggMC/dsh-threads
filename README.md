# dsh-threads

中文 | [English](README.en.md)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，照着 Claude 的"项目 + 讨论串"做。项目的主对话当调度员：遇到能独立完成的任务，就开一个**讨论串**——一个你能点进去接着聊的真实会话；讨论串做完后，把简短的回报发回主对话。

> 状态：从 0.1.0 起是正式版，各个版本见 [Releases](https://github.com/Kyf-eng/dsh-threads/releases)。基于 DeepSeek Harness 0.2.1-rc.2 开发，在 0.2.1-rc.2、0.2.1-rc.3 和 0.2.2-rc.1 上测试过。更新记录见 [CHANGELOG.md](CHANGELOG.md)，设计说明见 [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md)。

![一条消息，主对话开出三条讨论串同时干活](https://raw.githubusercontent.com/Kyf-eng/dsh-threads/main/docs/media/demo.gif)

## 功能

- **项目**：一个文件夹 + 一个常驻主对话，有图标、给协调者的目标，以及所有讨论串也会收到的项目说明。在左侧"项目"里新建（用系统的文件夹选择器选文件夹），或者在会话的"…"菜单里选"设为项目"。卡片的"⋮"菜单可以置顶、归档、删除、设置这个项目的桌面通知，以及打开项目设置（协调器和讨论串的模型、使用情况）。
- **讨论串**：主对话为能独立完成的工作开讨论串、给讨论串追加指令，也会提出你没要求的建议（放在输入框上方的卡片里，你点了才开始）。每个讨论串都是真实会话：在右侧面板打开，直接和它对话。
- **回报**：讨论串回报做完了什么、改了哪些文件、要你决定什么。回报一记录下来就发给主对话，不等这一轮结束、也不等其他讨论串，另有防止反复唤醒的限制；忘了回报的讨论串会被提醒一次；讨论串留在后台的任务结束后补交的回报，也会送到主对话。
- **并行和隔离**：最多 3 个讨论串同时运行。会改文件的讨论串在自己的 git worktree 和分支（`dsh-threads/<n>-<id>`）里工作，不碰项目文件夹；你要求时主对话才合并，`/thread cleanup` 清理做完的 worktree。
- **Claude 式界面**：对话里的讨论串卡片、"↳ N 条回复"、等你回复时的举手、运行中的呼吸点、文件和分支小标签。左侧有单独的"项目"分组：每个项目一行（显示状态和 ↳N），点进去就是主对话。项目的主对话和讨论串都不出现在"工作区"列表里。

## 平台

- **macOS 桌面版**：主要的开发和测试平台，全部功能都实测过。
- **Windows 桌面版（x64）**：实测过两轮。项目、讨论串、worktree、清理、审批沿用、停止、归档和完整流程都正常。需要先装 [Git for Windows](https://git-scm.com/download/win)；仓库路径很深时，见下面“排错”里的长路径。DeepSeek Harness 自己的 Windows 沙箱有时给不了项目文件夹写权限（`SetNamedSecurityInfoW failed (Win32 5)`），这时讨论串的终端命令要你一次性批准提权。桌面通知和英文界面还没在 Windows 上验证。
- **Linux**：DeepSeek Harness 没有 Linux 桌面版；Web 版在 Linux 上没测过。
- **Web 版**（`--profile web`）：在 macOS 上用过，没做完整测试。
- 单元测试在 Linux、macOS 和 Windows 的 CI 上都跑。

## 安装

需要 DeepSeek Harness **0.2.x**（桌面版或 Web 版；在 0.2.1-rc.2、0.2.1-rc.3 和 0.2.2-rc.1 上测试过）和它的 `dsh` 命令行。桌面版在应用菜单的"管理 dsh 命令…"里设置；没有这个命令时，可以用 npm 上和你的 DeepSeek Harness 同版本的命令行，例如 `npx -y @deepseek-ai/dsh@0.2.1-rc.2 plugin --profile web add @kyf-eng/dsh-threads`。

1. 完全退出 DeepSeek Harness（macOS 上按 ⌘Q；有菜单栏或托盘图标的，也要从那里退出）。
2. 把插件加到你的 profile：

   ```sh
   dsh plugin --profile desktop add @kyf-eng/dsh-threads
   ```

   以后升级也是这一条命令（从 0.1.0-rc.7 及以后的预发布版升级到正式版也一样，项目和讨论串都保留）。Web 版用 `--profile web`。要装某个版本，在包名后面加 `@版本号`（例如 `@kyf-eng/dsh-threads@0.1.0`）；不想走 npm，也可以填 [Releases](https://github.com/Kyf-eng/dsh-threads/releases) 里那个 `.tgz` 的地址。
3. 启动 DeepSeek Harness，左侧出现"项目"。

卸载：`dsh plugin --profile desktop remove @kyf-eng/dsh-threads`（0.1.0-rc.6 及更早的版本叫 `@fky/dsh-threads`）。

从 0.1.0-rc.6 及更早的版本升级：包名从 `@fky/dsh-threads` 改成了 `@kyf-eng/dsh-threads`，新版本不会替换旧的。先完全退出 DeepSeek Harness，运行 `dsh plugin --profile desktop remove @fky/dsh-threads`，再按上面的第 2 步安装。项目和讨论串存在 DeepSeek Harness 自己的存储里，卸载旧包不会丢。

## 使用

1. **项目 → 新建项目**：起名，选一个文件夹（任意文件夹，还不是工作区的会自动添加）。
2. 在项目主对话里让它在后台做事（"开个讨论串去……"）。也可以输入 `/thread <任务>`，或 `/thread -w <任务>` 开一个有独立 worktree 的讨论串。
3. 点讨论串卡片，在右侧打开它，可以直接聊；运行中可以点"停止"（或 `/thread stop <n>`），做完了点"标记已解决"，不再需要的可以归档（已归档的单独列在最下面，可以取消归档）。
4. 模型提出建议时，在输入框上方的卡片里开始一个、全部开始或都不要。
5. worktree 讨论串的改动在它自己的分支上。自己合并或让主对话合并，然后 `/thread cleanup`（再 `/thread cleanup confirm`）。

## 配置

在 profile 的 `cordis.patch.yml`（桌面版是 `~/.dsh/profiles/desktop/cordis.patch.yml`）里给插件加 `config`：

```yaml
- id: dsh-threads
  config:
    maxRunning: 2
```

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| `maxRunning` | 3 | 一个主对话同时能跑几个讨论串 |
| `maxAutoWakes` | 5 | 连续自动唤醒几次后，回报改为等你开口（0 表示从不自动唤醒） |
| `noteMaxChars` | 400 | 发回主对话的回报最长多少字 |
| `summaryMaxChars` | 300 | 讨论串摘要最长多少字 |
| `proposalTtlDays` | 7 | 没开始的建议几天后过期 |
| `maxProposalsPerTurn` | 3 | 模型一次最多提几个建议 |
| `reportReminder` | true | 讨论串做完任务却没回报时，提醒它一次 |
| `inheritPermissionPreset` | true | 讨论串沿用主对话的权限模式 |
| `offerApproval` | `ask` | 你只说了任务、没说要开讨论串时：`ask` 先弹确认卡（开讨论串 / 在主对话里做 / 先不做），`open` 不问直接开 |

## 排错

- **开着"开发者工具"时 DeepSeek Harness 崩溃**，日志里有 `inspector: source state exceeds the source-frame byte limit`：这是 DSH 实验性检查器的问题，插件多的 profile 都可能碰到。在 profile 的 `cordis.patch.yml` 末尾加下面一段，把单帧上限调到 1MB（要连 `captureFetch: true` 一起写）。**不要**点崩溃对话框里的"禁用第三方插件"，那会把所有第三方插件一起禁掉。

  ```yaml
  - id: experimental-inspector
    config:
      captureFetch: true
      maxSourceFrameBytes: 1048576
  ```

- **开 worktree 讨论串时提示“找不到 git”**：DeepSeek Harness 自己不带 git，用的是系统 PATH 里的 `git`。Windows 上装 [Git for Windows](https://git-scm.com/download/win)（其他程序自带的 git 不算），然后完全退出并重开 DeepSeek Harness，让它读到新的 PATH。提示里引用了 git 的原话（比如 Windows 上的 `detected dubious ownership`）时，按 git 说的处理。

- **Windows 上开 worktree 提示路径太长**：worktree 放在仓库里的 `.agents\worktrees\…` 下，路径比原仓库长四十来个字符，仓库本身路径就很深时会超过 Windows 默认的 260 字符上限（git 报 `Filename too long`）。可以只为这个仓库打开长路径支持（`git -C <仓库> config core.longpaths true`），或者把仓库放到更短的路径下。

- **收不到桌面通知**：DeepSeek Harness 在前台时不发通知（侧栏的记号已经够了）。在后台也收不到时，看系统的通知设置：macOS 是"系统设置 → 通知 → DeepSeek Harness"，Windows 是"设置 → 系统 → 通知"，Linux 取决于桌面环境的通知服务。Web 版第一次会请求浏览器的通知权限。

## 已知限制

- DeepSeek Harness 每个工作区默认只列 5 个会话，隐藏的讨论串也算在里面，所以讨论串多的工作区里可见的行会变少，"展开其余 N 个会话"的 N 也包含讨论串。
- worktree 从文件夹最后一次提交开出：没提交的改动不在里面，依赖（`node_modules` 等）要在 worktree 里重新装。
- 没有花费上限：除了同时运行的数量，讨论串用多少 token 不设限。用量在项目设置的"使用情况"里看。

## 开发

需要 Node ≥ 22.19。

```sh
npm install
npm run check
# 完全退出 DeepSeek Harness 后：
npm run dev:install
```

`dev:install` 默认用 macOS 桌面版自带的 `dsh`。其他安装方式用 `DSH_CLI=<dsh 命令的路径> npm run dev:install`，`DSH_PROFILE` 指定 profile（默认 `desktop`）。约定和测试方法见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 协议

MIT
