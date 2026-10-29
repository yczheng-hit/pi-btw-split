# pi-btw-split

**English** | [简体中文](README.zh-CN.md)

A [pi](https://github.com/earendil-works/pi-mono) extension that adds `/btw`: a side conversation that runs while the main agent keeps working. In [Herdr](https://herdr.dev) it opens in a native right-hand pane; elsewhere it opens as a 60/40 split inside Pi.

This project is independently maintained in [yczheng-hit/pi-btw-split](https://github.com/yczheng-hit/pi-btw-split), based on Dan Bachelder's MIT-licensed pi-btw 0.7.1. Version: `0.7.1-split.10`. Historical Linux validation covered Pi 1.0.4 and 1.2.0 with Herdr 0.9.3. Native macOS validation covers arm64, Pi 1.2.0, Node 24.20 and Herdr client/server 0.9.1; these results are not a guarantee for every host or future version.

Use [this repository's issues](https://github.com/yczheng-hit/pi-btw-split/issues) for support and bug reports, and this project's own history for updates and rollback. The related projects below are comparisons and credits, not maintenance destinations.

## Quick setup with an AI agent

Give your coding agent (pi, Claude Code, Codex, …) this prompt:

```text
Install the pi extension at https://github.com/yczheng-hit/pi-btw-split.
Follow the "Setup instructions for AI agents" section of its README exactly.
```

The agent checks prerequisites, installs the package, registers the Herdr pane plugin when it applies, and tells you when to run `/reload`.

## How it compares

| | [pi-btw](https://github.com/dbachelder/pi-btw) (upstream) | [pi-herdr-btw](https://github.com/oscabriel/pi-herdr-btw) | **pi-btw-split** (this repo) |
|---|---|---|---|
| Where the side chat appears | Centered overlay over the main session | New Herdr pane | Herdr: native right-hand pane. Elsewhere: 60/40 split inside Pi |
| Side-chat process | Sub-session inside the parent Pi | A second, full Pi process (`herdr agent start --kind pi`) | Sub-session inside the parent Pi; the Herdr pane is a small Node frontend over a local socket |
| Needs Herdr | No | Yes (v0.7.4+) | No; Herdr 0.9.1+ on Linux or macOS for the native pane |
| Context given to the side chat | Copy of the whole main branch | Static snapshot of the parent context; replays the exact system prompt to reuse the provider prompt cache | One continuous conversation. It starts with a budgeted main-session snapshot (current task and its tool progress, earlier rounds, the existing compaction summary; by default at most 60% of the free window, capped only by the main session's context window; set `snapshot.share` / `snapshot.maxTokens` in `~/.pi/agent/btw.json`) plus the main transcript path. Later main progress is only appended (`/btw:sync`, `/btw:autosnap on`, or the model's `main_session_update` tool); earlier turns are never rewritten. `PI_BTW_CONTEXT=full` copies the whole main context |
| Auto-compaction in the side chat | On (follows your Pi settings) | Pi default (runs a normal Pi process) | On (follows your Pi settings). Each question starts small, so compaction is rarely needed |
| Modes | `/btw`, `/btw:tangent` (no context), `/btw:ask` (read-only) | One mode; tools set by config (`inherit/all/read-only/none`) | Same as upstream |
| Back to the main agent | `/btw:inject`, `/btw:summarize`: sent as a user message, queued as follow-up when busy | `/btw merge <prompt>` from the side pane; waits for the parent to settle | Labelled `BTW → main` message, steered in at the next step when busy. Inject keeps the thread until delivery; summarize clears it as soon as the summary exists. Undelivered content is kept for resend |
| Composer help | Slash menu (0.8.0) | Draft question prefilled for editing | Live command hints, Tab completion, short forms (`/ask`, `/summ`); unknown `/btw…` text never reaches the model |
| Other | SSH workspaces (0.8.0) | Persistent config (`/btw config`), split right/down | Pane-local copy, click focus, CJK IME positioning (all from Herdr) |

What this fork lacks: it branched from pi-btw 0.7.1, so upstream 0.8.0 features (SSH workspaces, Up/Down slash menu) are not included. The native pane supports Linux and macOS only; other platforms can use the in-Pi split with `PI_BTW_SURFACE=internal` inside Herdr.

## Requirements

- Node.js 22.19 or newer
- Pi 1.0.4 or newer (`pi --version`)
- Optional native pane: Herdr 0.9.1 or newer on Linux or macOS **and the official Herdr Pi integration** (`herdr integration install pi`). The official integration is an external prerequisite, not part of this package, and remains the authority for the parent agent's identity and lifecycle.

## Setup instructions for AI agents

Run each step and check its result before the next one. Ask the user before removing anything.

1. **Check prerequisites.** Run `node --version` and `pi --version`. Stop and report if Node is older than 22.19 or Pi is older than 1.0.4.

2. **Check for conflicting packages.** Run `pi list`. If it shows `npm:pi-btw`, `pi-herdr-btw`, or any other package that registers `/btw`, ask the user whether to remove it with `pi remove <source>`. Two packages that both register `/btw` conflict.

3. **Install.**
   ```sh
   pi install git:github.com/yczheng-hit/pi-btw-split
   ```
   Pi clones the repo to `<agent-dir>/git/github.com/yczheng-hit/pi-btw-split`, where `<agent-dir>` is `$PI_CODING_AGENT_DIR` or, if unset, `~/.pi/agent`. Alternatively, `pi install /absolute/path/to/pi-btw-split` uses your local checkout as the package root. Run `pi list` again to confirm.

4. **Register the Herdr pane (Linux or macOS with Herdr only).** Skip this step if `herdr` is not installed, or if the OS is neither Linux nor macOS.
   ```sh
   herdr --version                  # needs 0.9.1+
   herdr integration install pi     # official Pi integration, if not already installed
   herdr plugin list --json         # look for plugin id "local.pi-btw-light"
   herdr plugin link "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/git/github.com/yczheng-hit/pi-btw-split"
   ```
   - Check for the official Pi integration at `<agent-dir>/extensions/herdr-agent-state.ts` before installing it; it remains an external standard prerequisite.
   - For a local-checkout install, link the checkout's absolute path instead.
   - If `local.pi-btw-light` is already registered at a different path, ask the user before changing it. Never replace a registration you did not create.
   - The plugin root must be exactly the installed package directory; BTW refuses to open a pane otherwise.

5. **Other platforms inside Herdr.** The native pane supports only Linux and macOS, so on any other platform set `PI_BTW_SURFACE=internal` in the user's shell profile. Otherwise `/btw` reports a launch error instead of opening. Outside Herdr nothing is needed: the in-Pi split is used automatically.

6. **Finish.** Tell the user to run `/reload` in every running Pi session (or start a new one). Then they can try `/btw hello`. An agent cannot run `/reload` in someone else's Pi session.

**Uninstall:** remove the source shown by `pi list`: `pi remove /absolute/path/to/pi-btw-split` for a local install, or `pi remove git:github.com/yczheng-hit/pi-btw-split` for a Git install. Then `herdr plugin unlink local.pi-btw-light` if it was linked. Do not remove the official Herdr Pi integration as part of uninstalling BTW.

**Update:** `pi update git:github.com/yczheng-hit/pi-btw-split`, then `/reload`. For a local install, update your checkout from this project's own history, then `/reload`. To pin a version, install `git:github.com/yczheng-hit/pi-btw-split@<commit-or-tag>`.

## Manual install

```sh
pi install git:github.com/yczheng-hit/pi-btw-split   # or: pi install /absolute/path/to/pi-btw-split
```

Then follow steps 4–6 above. To try it without installing: `pi -e /path/to/pi-btw-split`.

## Usage

```text
/btw what file defines this route?
/btw --save summarize the last error in one sentence
/btw:tangent brainstorm without the current chat context
/btw:ask what does this module do?
/btw:summarize turn this into a short handoff
```

| Command | What it does |
|---|---|
| `/btw [--save] <question>` (alias `/side`) | Ask in the current BTW conversation; follow-ups see earlier answers. Works while the main agent is busy. `--save` also writes the exchange as a visible note in the main transcript |
| `/btw:new [question]` | Clear the thread and start a fresh one with main context |
| `/btw:tangent [--save] <question>` | Thread with no main-session context |
| `/btw:ask [--save] <question>` | Read-only thread: only `read`, `grep`, `find`, `ls` (plus `main_session_update`) are available |
| `/btw:sync` | Add what the main session did since the snapshot (or last update) to the conversation, together with your next question |
| `/btw:autosnap [on\|off]` | Show or set automatic sync before every question. Saved as `snapshot.auto` in `~/.pi/agent/btw.json`; default off |
| `/btw:inject [instructions]` | Send the full thread to the main agent. The thread is kept until the main session receives it; if delivery fails, run the command again to resend it |
| `/btw:summarize [instructions]` | Summarize the thread (thinking off) and send the summary. The thread is cleared immediately once the summary exists; if delivery fails, run the command again to resend the saved summary without another model call |
| `/btw:clear` | Close BTW and clear the thread |
| `/btw:model [<provider> <model> <api> \| clear]` | BTW-only model override |
| `/btw:thinking [<level> \| clear]` | BTW-only thinking override |
| `/btw:ui native\|internal` | Switch between the Herdr pane and the in-Pi split for this Pi process |

Inside the BTW composer, short forms work (`/ask`, `/new`, `/summ`), Tab completes commands, and other slash commands go to the BTW sub-session.

### Keys

| Key | Action |
|---|---|
| `Alt+/`, `Super+/`, `Ctrl+Alt+W` | Switch focus between main and BTW. Remap with `PI_BTW_FOCUS_KEYS="ctrl+/,ctrl+alt+b"` |
| `Alt+w` | Herdr: zoom the BTW pane. In-Pi: toggle full-width mode for clean copy |
| `↑` / `↓` | Prompt history, same as the main editor: `↑` on an empty input (or at column 0) recalls earlier BTW questions, `↓` walks back to your draft. History covers this session's BTW questions, including those before `/btw:new` |
| `PgUp` / `PgDn`, mouse wheel | Scroll the BTW transcript |
| `Esc` | While streaming: abort (keeps partial output). While idle: close BTW. Closing keeps the thread and draft; `/btw` reopens them |

### Behavior notes

- BTW threads are saved as hidden session entries. They survive reloads and never enter the main agent's context. An unsubmitted draft is not saved to disk.
- The BTW backend lives in the parent Pi. If the parent exits, the Herdr pane disconnects; the thread comes back when the session is reopened.
- A BTW thread is one conversation: follow-ups see earlier questions and answers. The main-session snapshot is taken when it starts (none for `/btw:tangent`). When the main session moves on, the pane header shows it (`main context 14:02 · main +3 rounds since (/btw:sync)`); nothing changes under you until you sync. `/btw:sync` or autosnap appends a `<main-session-update>` before your next question (the pane shows `↻ main session synced`); the model can also call `main_session_update` itself when a question is about the main session's current state.
- The conversation restarts from a fresh snapshot only when an update cannot be appended (the main session switched branch, or BTW model/thinking changed, or after a reload) or when it reaches about 60% of the room before Pi would compact it. The restarted conversation gets the earlier exchanges (summarized to fit) so follow-ups still connect.
- If a single question still overflows the model window after Pi's compaction, BTW reports the error and suggests `/btw:summarize` or `/btw:new`.
- In-Pi split mode needs fullscreen at ≥120 columns and ≥14 rows; smaller terminals get a centered window.

## Native identity troubleshooting

If BTW says **“Herdr has not reported this Pi session”**, the parent pane exists but its official session identity is missing. When that Pi is idle, run `/reload`, then `/btw` in its main editor. No history deletion or Herdr restart is needed. In SSH/remote windows, check `herdr integration status` **on the remote machine**; fixing the local installation does not fix the remote one.

A **session mismatch** is different: run `/session` in the affected Pi and compare its path with `herdr pane get <pane-id>` on the same machine. BTW never invents or overwrites the parent's identity, targets another Pi by its cwd, or silently opens the internal fallback.

## Configuration

| Setting | Effect |
|---|---|
| `PI_BTW_SURFACE=internal` | Always use the in-Pi split, even inside Herdr |
| `PI_BTW_CONTEXT=full` | Copy the whole main context into BTW (upstream behavior). Compaction still follows your Pi settings |
| `PI_BTW_FOCUS_KEYS` | Comma-separated focus-switch keys; replaces the defaults |
| `~/.pi/agent/btw.json` | `snapshot.auto` (autosnap, see `/btw:autosnap`), `snapshot.share` / `snapshot.maxTokens` (snapshot size). Opt-in extension tools for `/btw` and `/btw:tangent`, e.g. `{"extensions": ["npm:pi-web-access"]}`. A trusted project's `.pi/btw.json` replaces the list. `/btw:ask` ignores it |

## Development

From the checkout root:

```sh
npm ci
npm test            # node --test test/*.test.mjs; offline providers, no network model calls
npm run typecheck
```

These commands work locally using the pinned Pi 1.2.0 development dependencies; no globally installed Pi or machine-specific path edits are needed. `npm run typecheck` checks against those local types. For optional runtime compatibility tests against another installed Pi host, set `PI_HOST_DIR` to its `@earendil-works/pi-coding-agent` package directory.

Live tests (`test/live-*.mjs`) are opt-in with `PI_BTW_LIVE_TEST=1` and require Linux or macOS, Herdr 0.9.1 or newer, and the official Herdr Pi integration installed with `herdr integration install pi`. They default to `<agent-dir>/extensions/herdr-agent-state.ts`, where `<agent-dir>` is `$PI_CODING_AGENT_DIR` or `~/.pi/agent`; `PI_HERDR_EXTENSION` can override the integration path. Read each live script's options before running it: it creates test Pi parents and Herdr panes/tabs; real-config modes may load your personal extensions.

`node test/perf.mjs` measures the offline renderer fixture, not physical terminal latency. An optional `PI_STICKY_EXTENSION=/absolute/path/to/sticky-last-prompt.ts` enables a comparison with your personal sticky-prompt extension; the default fixture requires none.

Design notes and measurements: [LOCAL-CHANGES.md](LOCAL-CHANGES.md).

## Credits

- [dbachelder/pi-btw](https://github.com/dbachelder/pi-btw) by Dan Bachelder — the original extension this fork is based on (MIT).
- [oscabriel/pi-herdr-btw](https://github.com/oscabriel/pi-herdr-btw) — a related `/btw` for Herdr that runs the side chat as a separate Pi process in its own pane.
- [pi](https://github.com/earendil-works/pi-mono) and [Herdr](https://herdr.dev).

## License

MIT. See [LICENSE](LICENSE).
