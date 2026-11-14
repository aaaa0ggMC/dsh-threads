# dsh-threads

[中文](README.md) | English

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin, modelled on Claude's projects and threads. Your project's main conversation acts as a dispatcher: when a task is self-contained, it opens a **thread** (a real session you can click into and keep talking to), and when the thread finishes, a short report comes back to the main conversation.

> Status: stable since 0.1.0; every version is on [Releases](https://github.com/Kyf-eng/dsh-threads/releases). Built against DeepSeek Harness 0.2.1-rc.2 and tested on 0.2.1-rc.2, 0.2.1-rc.3 and 0.2.2-rc.1. See [CHANGELOG.md](CHANGELOG.md) and the design notes in [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md).

![One message: the main conversation opens three threads that work at the same time](https://raw.githubusercontent.com/Kyf-eng/dsh-threads/main/docs/media/demo.gif)

## What it does

- **Projects**: one folder plus one standing main conversation, with an icon, a goal for the coordinator, and instructions every thread also gets. Create one from **Projects** in the sidebar (the system folder chooser picks the folder), or turn a conversation into a project from its "…" menu. A card's "⋮" menu pins, archives, deletes, sets the project's desktop notifications, and opens its settings (models for the coordinator and threads, usage).
- **Threads**: the main conversation opens threads for self-contained work, sends follow-ups to them, and suggests threads you did not ask for (they wait in a card above the composer until you start them). Each thread is a real session: open it in the right sidebar and talk to it directly.
- **Reports**: threads report what is done, what changed and what you need to decide. A report reaches the main conversation as soon as the thread records it — without waiting for that round to end, or for other threads — with a guard against wake-up loops. A thread that forgets to report is reminded once, and a report a thread sends later, when a background job it left running finishes, reaches the main conversation too.
- **Parallel and isolated**: up to 3 threads run at once. Threads that change files work in their own git worktree and branch (`dsh-threads/<n>-<id>`), so the project folder is never touched; the main conversation merges only when you ask, and `/thread cleanup` removes finished worktrees.
- **Claude-style UI**: thread cards in the conversation, "↳ N replies", a raised hand for threads waiting on you, a breathing dot for running ones, file and branch chips. The sidebar has its own **Projects** section: one row per project (its state and ↳N), which opens the main conversation. Project conversations and threads stay out of the workspace list.

## Platforms

- **macOS Desktop**: the main development and test platform; every feature has been tried on it.
- **Windows Desktop (x64)**: tested in two rounds. Projects, threads, worktrees, cleanup, keeping the approval mode, stopping, archiving and the full workflow work. Install [Git for Windows](https://git-scm.com/download/win) first; for deeply nested repositories, see long paths under Troubleshooting. DeepSeek Harness's own Windows sandbox sometimes cannot give the project folder write access (`SetNamedSecurityInfoW failed (Win32 5)`); thread terminal commands then need your one-time approval to run with more access. Desktop notifications and the English UI are not verified on Windows yet.
- **Linux**: DeepSeek Harness has no Linux Desktop app; the Web app is untested on Linux.
- **Web app** (`--profile web`): used on macOS, not fully tested.
- Unit tests run in CI on Linux, macOS and Windows.

## Install

Requires DeepSeek Harness **0.2.x** (Desktop or Web; tested on 0.2.1-rc.2, 0.2.1-rc.3 and 0.2.2-rc.1) and its `dsh` command line. On Desktop it is set up from the app menu (**Manage dsh command…**). Without it, the command line from npm at your DeepSeek Harness version works too, for example `npx -y @deepseek-ai/dsh@0.2.1-rc.2 plugin --profile web add @kyf-eng/dsh-threads`.

1. Quit DeepSeek Harness completely (⌘Q on macOS; also quit from its menu-bar or tray icon if it has one).
2. Add the plugin to your profile:

   ```sh
   dsh plugin --profile desktop add @kyf-eng/dsh-threads
   ```

   The same command upgrades it later, including from the 0.1.0-rc.7 and later pre-releases to the stable release; projects and threads are kept. Use `--profile web` for the Web app. For a particular version, add `@<version>` to the name (for example `@kyf-eng/dsh-threads@0.1.0`); without npm, use the address of the `.tgz` on [Releases](https://github.com/Kyf-eng/dsh-threads/releases).
3. Start DeepSeek Harness. **Projects** appears in the sidebar.

To remove it: `dsh plugin --profile desktop remove @kyf-eng/dsh-threads` (`@fky/dsh-threads` for 0.1.0-rc.6 and earlier).

Upgrading from 0.1.0-rc.6 or earlier: the package was renamed from `@fky/dsh-threads` to `@kyf-eng/dsh-threads`, so the new version does not replace the old one. Quit DeepSeek Harness completely, run `dsh plugin --profile desktop remove @fky/dsh-threads`, then install with step 2 above. Projects and threads live in DeepSeek Harness's own storage and survive removing the old package.

## Use

1. **Projects → New project**: name it and pick a folder (any folder; it becomes a workspace if it is not one).
2. In the project's main conversation, ask for work in the background ("open a thread to…"). You can also type `/thread <task>`, or `/thread -w <task>` for a thread with its own worktree.
3. Click a thread card to open the thread on the right. Talk to it there; **Stop** it while it runs (or `/thread stop <n>`), **Mark resolved** when you are done with it, and archive it to put it away (archived threads are listed apart and can be unarchived).
4. When the model suggests threads, start one, all, or none from the card above the composer.
5. A worktree thread's changes stay on its branch. Merge it yourself or ask the main conversation to, then run `/thread cleanup` (and `/thread cleanup confirm`).

## Configuration

Add a `config` to the plugin's entry in your profile's `cordis.patch.yml` (for Desktop, `~/.dsh/profiles/desktop/cordis.patch.yml`):

```yaml
- id: dsh-threads
  config:
    maxRunning: 2
```

| Option | Default | Meaning |
| --- | --- | --- |
| `maxRunning` | 3 | Threads one main conversation may run at once |
| `maxAutoWakes` | 5 | Automatic wake-ups in a row before reports wait for you (0: never wake automatically) |
| `noteMaxChars` | 400 | Longest report delivered to the main conversation |
| `summaryMaxChars` | 300 | Longest summary a thread may submit |
| `proposalTtlDays` | 7 | Days before an unstarted suggestion expires |
| `maxProposalsPerTurn` | 3 | Suggestions the model may make at once |
| `reportReminder` | true | Remind a thread once when it ends a task without reporting |
| `inheritPermissionPreset` | true | Threads get the main conversation's permission preset |
| `offerApproval` | `ask` | When you name a task without asking for a thread: `ask` shows the confirmation card first (open a thread / do it here / not now), `open` opens the thread without asking |

## Troubleshooting

- **DeepSeek Harness crashes while Developer tools are on**, with `inspector: source state exceeds the source-frame byte limit` in the log: this is DSH's experimental inspector, and any profile with many plugins can hit it. Add the following to the end of your profile's `cordis.patch.yml` to raise the frame limit to 1 MB (keep `captureFetch: true` in it). Do **not** choose "disable third-party plugins" in the crash dialog: it disables every third-party plugin.

  ```yaml
  - id: experimental-inspector
    config:
      captureFetch: true
      maxSourceFrameBytes: 1048576
  ```

- **"git was not found" when a thread asks for a worktree**: DeepSeek Harness does not ship git; it runs the `git` on the system PATH. On Windows install [Git for Windows](https://git-scm.com/download/win) (a git bundled inside another program does not count), then quit DeepSeek Harness completely and reopen it so it sees the new PATH. When the message quotes git (for example `detected dubious ownership` on Windows), do what git says.

- **"Paths too long" for a worktree on Windows**: worktrees live under `.agents\worktrees\…` inside the repository, about forty characters deeper than the repository itself, so a deeply nested repository can go over Windows' default 260-character limit (git says `Filename too long`). Turn on long paths for that repository only (`git -C <repository> config core.longpaths true`), or move the repository to a shorter path.

- **No desktop notifications**: none are sent while DeepSeek Harness is in front (the sidebar marks are enough). If they also do not arrive while it is in the background, check the system's notification settings: System Settings → Notifications → DeepSeek Harness on macOS, Settings → System → Notifications on Windows, and your desktop environment's notification service on Linux. The Web app asks for the browser's permission the first time.

## Known limitations

- DeepSeek Harness lists 5 sessions per workspace and counts hidden threads among them, so a workspace with many threads shows fewer rows, and its "show N more" count includes threads.
- A worktree starts from the folder's last commit: uncommitted changes are not in it, and dependencies (`node_modules`, …) have to be installed there.
- There is no spending cap: apart from how many run at once, threads may use as many tokens as they need. Project settings → Usage shows what they used.

## Development

Requires Node ≥ 22.19.

```sh
npm install
npm run check
# quit DeepSeek Harness completely, then:
npm run dev:install
```

`dev:install` uses the `dsh` inside the macOS Desktop app. For any other install, run `DSH_CLI=<path to dsh> npm run dev:install`; `DSH_PROFILE` picks the profile (default `desktop`). Conventions and how to test: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
