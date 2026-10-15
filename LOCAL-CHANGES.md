# pi-btw-split changes (0.7.1-split.4)

Independently maintained in [yczheng-hit/pi-btw-split](https://github.com/yczheng-hit/pi-btw-split), based on Dan Bachelder's MIT-licensed pi-btw 0.7.1. Maintenance, updates and support belong to this project; related-project links in the READMEs are comparisons and credits, not support destinations.
Dated validations and measurements below are historical results from the configurations described, not current test counts, performance promises, or guarantees for other hosts. Current setup and development commands are in [README.md](README.md).

## Native Herdr pane — current default on Linux

In `HERDR_ENV=1`, `/btw` and `/side` open/reuse a native right-hand Herdr pane.
The frontend imports only Node builtins and the installed pi-tui terminal/renderer modules,
not Pi SDK, extensions, auth, or models. The existing AgentSession, tools, context snapshot,
continuous thread, model/thinking overrides, persistence, and handback stay in the parent Pi.
Completed Markdown and wrapped transcript caches are retained.

- Separate PTYs: Herdr owns layout, pane-local selection/copy and click focus. The main Pi
  does not mount an overlay or reserve internal columns. The new two-leaf split is set to
  60/40 when it can be identified exactly; unrelated split ratios are never adjusted.
- No pane at startup. An already owned pane is focused/reused without restarting the frontend.
  The input surface connects before child-session/model initialization; startup input is
  queued and dispatched in sequence. Duplicate sequence numbers disconnect, not resubmit.
- `Alt+/` switches main/BTW focus. `Alt+w` toggles native Herdr pane zoom, not a Pi overlay.
  Esc retains abort-first/close-second behavior during streaming; idle Esc closes.
- Main-side and composer-side lifecycle commands remain available: `new`, `tangent`, `ask`,
  `model`, `thinking`, `clear`, `inject`, `summarize`. `/btw:ask` still exposes only
  `read`, `grep`, `find`, `ls`, and never loads optional BTW extension tools.
- Closing the pane preserves the thread and in-memory draft; `/btw` reopens them. Clear/handback retain
  their existing reset semantics. Parent reload/session navigation closes the owned frontend.
  **BTW is not an independently running/resumable Pi:** parent exit disconnects it.
  Completed thread entries restore after reload; an unsubmitted draft is not persisted to disk.
- Only BTW's own pane is reported as `btw-light` (display name BTW), with its own source.
  Main Pi's official lifecycle authority and genuine permission-prompt reporting are untouched.
  No parent session/resume command is advertised as a child restore target.
- Launch errors are explicit; there is **no silent internal fallback**.

### Activation / explicit rollback

Install this package from your local checkout, then link its package root as `local.pi-btw-light`.
The native pane requires Linux, Herdr 0.9.3, and the external official Herdr Pi integration
(`herdr integration install pi`). The user runs `/reload`, then `/btw`; installing or linking
BTW does not require restarting Pi or Herdr or changing unrelated plugins.

Check `herdr plugin list --json` first; never replace a foreign registration with the same ID.
Replace the placeholder with your actual installed package root:

```sh
herdr plugin link /absolute/path/to/pi-btw-split
```

For immediate single-PTY rollback, run `/btw:ui internal`, then `/btw`.
Return with `/btw:ui native`, then `/btw`. This UI override lasts for the extension lifetime.
`PI_BTW_SURFACE=internal` is a persistent launch-environment alternative.
Outside Herdr the internal mode is used automatically.
Unlink only this plugin after closing BTW / choosing internal:

```sh
herdr plugin unlink local.pi-btw-light
```

For a code rollback, check out an earlier commit of this repository, then user-trigger
`/reload` (see "Activation and rollback" below).

### IPC / compatibility boundaries

`native/protocol.mjs`, `herdr.mjs`, `surface.mjs`, `frontend.mjs` and `herdr-plugin.toml`
implement the surface. The per-open Unix directory is 0700, capability file/socket 0600,
with a random token/session and authoritative pane/terminal binding. The nonsecret
`btw_owner` metadata nonce follows the stable terminal across moves. Actions reconcile
ownership before targeting a public pane ID; a foreign/replaced pane is not reused/closed.
Herdr does not provide atomic compare-and-act pane APIs, so cross-client races cannot be
eliminated entirely. Lost/moved panes are reconciled by bounded 1.5-second polling, not a
replayable event cache. This deliberately avoids nondurable subscription recovery complexity.

JSON messages are bounded to 1 MiB, paste to 64 KiB, terminal dimensions to 512x256, and
queued controls/inputs to bounded counts/bytes. Latest output frames coalesce under backpressure;
ordered input/control messages are not silently dropped. Oversized/malformed/authentication
failures close the connection. Heartbeats and startup timeouts produce explicit disconnects.
This is local Linux IPC, not a sandbox against other processes running as the same user.
Pi pi-tui submodule paths and Herdr 0.9.3 APIs are compatibility seams for future upgrades.

**Pi 1.2.0 upgrade check (2026-10-14):** no code change needed. All pi-tui submodules the
frontend imports still exist (pi-tui 1.2.0); `npm test` 23/23, typecheck against 1.2.0 types and
the 1.2.0 extension loader pass; live Herdr native and e2e runs (isolated, real config, busy
main) pass. 1.2.0 counts a starting run as busy and requires `deliverAs` for
`pi.sendUserMessage()` then; `sendThreadToMain` already sends directly only when `ctx.isIdle()`
and uses `deliverAs: "followUp"` otherwise. Not automated: the main session's actual handling of
an injected/summarized thread on 1.2.0 (idle and busy) — needs one manual check each.
(Superseded in split.3: handoffs no longer use `sendUserMessage`; see "BTW → main handoff" below.)

### Verification / measured startup (2026-10-14)

- `npm test`: **23 passing**. Original internal layout/cache/sticky/prompt regressions plus
  IPC authentication/session mismatch, malformed/overlimit messages, backpressure, ordered
  input, ownership/move/replacement, pending-open close, callback-failure cleanup, reload,
  resize/mouse bounds and parent-session replacement.
- The actual extension + real AgentSession use an in-memory offline provider to prove one
  native submit = one request, inherited context, enforced read-only tools, composer thinking
  command and handback without a model call. No paid/network model request was made.
- Native token/input updates no longer call the parent `setWidget` repaint path (red/green
  regression: one offline request previously caused 15 main-widget updates, now zero).
  Compact native composers keep cursor/mouse positioning at their actual input row.
- Installed host extension-load smoke, strict TypeScript check, and package native-file inclusion pass.
- Opt-in `PI_BTW_LIVE_TEST=1 node test/live-native.mjs`: separate real Herdr PTYs, Chinese
  text input/render, exactly one Enter submission, resize, moving the same live terminal,
  manual close, parent exit and capability cleanup. The temporary **test parent** is an idle
  minimal full Pi with only official Herdr integration (required for genuine parent identity);
  each **BTW frontend** is the lightweight process. No user pane input/focus/restart was issued.

Final five-run live smoke, milliseconds (new frontend process every run):

| Run | Herdr setup | First PTY UI write | Authenticated input ready | First backend frame write |
|---|---:|---:|---:|---:|
| 1 | 70.6 | 271.3 | 368.9 | 369.9 |
| 2 | 133.2 | 219.3 | 319.0 | 321.1 |
| 3 | 98.1 | 302.9 | 402.0 | 404.0 |
| 4 | 215.2 | 394.9 | 494.4 | 495.3 |
| 5 | 28.9 | 103.5 | 202.8 | 204.8 |

The baseline with the pi-tui barrel import measured 155–358 ms first writes and 255–391 ms
input readiness; after removing unnecessary barrel imports, shared-host variance remains
large, so no controlled speedup factor is claimed. These measure `NativeSurface.open()`
through actual PTY writes/private startup telemetry, not just queued renders. They exclude
command dispatch/short UI bootstrap, child-session initialization, and model response time.
All launches are cold **Node processes**; OS cache was not evicted (not true OS-cold timings).
Existing-pane reuse starts no process. Physical display/compositor latency, clipboard and
real Chinese IME are **not** proved by these automated tests.

Manual acceptance after user `/reload`: `/btw`; drag-copy one transcript without crossing
panes; click each pane and type; Chinese IME cursor positioning; wheel scroll; Alt+/; Alt+w
zoom/unzoom; stream while using the main editor; real approval still reports blocked; close
and reopen BTW. Then try `/btw:ask` and handback. Report any actual terminal routing issue.

### Fix: native pane showed typing but no replies (2026-10-14)

Symptom: the BTW pane accepted input and status reached "Ready for a follow-up", the answers were
persisted (visible after restart), but new replies never rendered in the open pane.

Cause: the child AgentSession is lazy and replaceable while the pane stays open (thinking/model
override disposes it; a failed/stale first lazy creation is retried by the submit). Internal mode
re-subscribes the overlay to the current session on every `ensureOverlay`; the native "already
open" branch only focused the pane. A replacement session therefore had no transcript
subscriber: model events were dropped and only keystrokes caused repaints.

Fix: the native existing-pane branch now subscribes to the current child session and refreshes
before focusing; `executeBtw` always passes through it before `session.prompt`.
Red/green: the real-extension native test (real AgentSession, offline provider) asserted the
second reply after `/btw:thinking off`; before the fix 2 requests/4 saved entries but the frame
stayed at 1 exchange, after the fix both exchanges render.

Also: a killed parent Pi (signal, no `session_shutdown`) leaves its private `/tmp/pi-btw-XXXXXX`
directory. Opening BTW now sweeps only own, ≥60 s old, exact-shape directories whose socket has
no listener; a process `exit` hook removes current ones on normal exit.

Opt-in full live repro, never part of `npm test`, local fake provider only (no network model):
`PI_BTW_LIVE_TEST=1 node test/live-e2e.mjs` launches a real Pi parent in a temporary unfocused
Herdr tab, opens `/btw`, submits, changes thinking, submits again, kills/restarts the parent and
repeats. Variants: `PI_BTW_E2E_MAIN_BUSY=1` (main streaming), `PI_BTW_E2E_REAL_AGENT=1` (the
user's real packages/settings), `PI_BTW_E2E_SESSION_COPY=<session.jsonl>` (private temp copy of a
real session in an isolated agent dir without credentials). All passed after the fix.

### Composer slash commands (2026-10-14)

The BTW composer (native and internal) now helps with its lifecycle commands:

- Typing `/` turns the status row into a live list of matching commands; one match shows its
  usage and description (`Tab → /btw:thinking [<level> | clear] — …`).
- Tab completes a unique match (with trailing space, cursor at the end); with several matches,
  Tab cycles through them, showing the current command's description first.
- Short forms work in the composer: `/ask …` = `/btw:ask …`, `/new`, `/model`, `/thinking`, etc.
- Enter on a partially typed command never reaches the model (fix for `/summ` being sent as a
  question): a single word that is a unique prefix of ≥2 letters runs the command (`/summ` →
  `/btw:summarize`, hint shows `Enter/Tab →`); one-letter prefixes (`/c` = clear), ambiguous
  prefixes (`/t`) and prefix + arguments (`/summ focus …`) keep the draft and ask for Tab.
- `/btw…` text that is not a known command (e.g. `/btw:foo`, `/btw hello`) is **not sent to the
  model**; the draft stays for correction and the status explains. Other `/` text (such as a
  path) shows "Enter sends this text as a question" and behaves as before.
- One list (`BTW_COMPOSER_COMMANDS`) drives the parser, hints, completion and unknown guard.

Validated by the real-extension native test (live list, Tab cycle, unique completion, cursor
position, unknown guard with zero model requests) and the live Herdr e2e (`/th` + real Tab key
through Herdr and the frontend, then the completed command runs).

### Manual acceptance (2026-10-14) — passed

After `/reload`, the user accepted the native Herdr pane in daily use: drag-copy stays inside
the BTW pane, click-to-focus, Chinese IME cursor, wheel scroll, Alt+/ focus, Alt+w zoom, real
approvals shown as blocked, close/reopen, `/btw:ask`, inject/summarize handback, and composer
`/` hints, Tab completion and partial-command Enter.

## BTW → main handoff (0.7.1-split.3, 2026-10-15)

**Why.** A `/btw:summarize` sent while the main session was busy (user interjecting) never
reached the main session, and BTW had already reset its thread. Handoffs were also sent with
`pi.sendUserMessage`, so the main agent and transcript could not tell them from the user's own
words, and `followUp` delivery waited behind every interjection.

**Repro (`test/live-handoff.mjs`, split.2 code).** Idle, busy, and busy + three interjections all
delivered (isolated and real config). Busy + Escape lost the handoff: Pi cleared its queue and put
the summary text back into the main editor while BTW had reset the thread. The original reported trigger
was not reproduced; consecutive interjections alone do not lose it.

**Now.**
- `/btw:inject` / `/btw:summarize` send a `btw-handoff` custom message via `pi.sendMessage`:
  idle → `{ triggerTurn: true }`; busy → `{ triggerTurn: true, deliverAs: "steer" }` (seen at the
  main agent's next step). Content is wrapped in `<btw-handoff kind=… exchanges=… initiated-by="user">`
  with a line saying it was handed over from BTW, plus the user's instructions if any. The main
  transcript shows a `BTW → main · summary · N exchanges` card (8-line preview, expandable).
  `details` (id, kind, exchanges, instructions) are not sent to the model.
- The thread is reset only after delivery: `message_end` for the handoff id, or the id found in
  the main branch (`agent_settled` / 500 ms watchdog). If the main session stays idle without it
  (≥1.5 s, 3 idle ticks) it counts as dropped: thread kept, warning, and the same command
  resends the cached content (no new summarize call). A late delivery still resets the thread.
- `btw-handoff-pending` entries persist the in-flight handoff; restore finishes a delivered one
  or keeps an undelivered one for resend. While a handoff is in flight, new BTW questions and a
  second handoff are refused (draft kept); `/btw:clear`, `/btw:new`, `/btw:tangent` drop it.
- The `context` filter still removes only `btw-note`; `btw-handoff` reaches the model.

**Validated.** `npm test` 24/24 (new `test/handoff.test.mjs`: busy steer, blocked questions,
dropped → warning → cached resend, branch/message_end delivery, card rendering, restart with
pending/delivered handoff; native test asserts the labelled idle handoff and delayed reset),
typecheck, 1.2.0 loader 0 errors. Live Herdr + local fake provider (isolated and real config):
idle, busy, busy + 3 interjections (handoff now lands before the interjections), busy + Escape
(not delivered, thread kept, warning; `/btw:summarize` from the main editor resends the identical
content and then resets), `/btw:inject` busy. No paid/network model calls.

## Summarize clears at once; lean BTW start (0.7.1-split.4, 2026-10-15)

**Why.**
- Summarize: a summarized thread has no further use in BTW. The user asked for it to be cleared
  as soon as the summary exists, rather than after delivery.
- Lean start: opening BTW on a near-full main session copied the whole main context. Measured on
  the user's session: ~181k–244k est. tokens, of which tool output ~96k, thinking ~26k, and the
  main system prompt (already in BTW's own prompt) ~21k; the user's messages were ~0.7k and the
  text answers ~4.7k. BTW then compacted before answering, which costs an extra model call and
  makes startup slow.

**`/btw:summarize`.**
- Order on send: write `btw-handoff-pending` (`threadCleared: true`), send, reset the thread.
- New BTW questions are allowed while the summary is in flight; a second handoff is refused.
- Not delivered (Escape, cleared queue) → warning. `/btw:summarize` then resends the saved
  summary even if new questions exist; it makes no model call, and new instructions re-wrap the
  same body.
- `/btw:clear` writes `btw-handoff-discarded`. Restore offers the latest undelivered summary for
  resend unless it was discarded.
- `/btw:inject` is unchanged: the thread is kept until delivery and questions wait meanwhile.

**Lean start** (`extensions/btw-context.ts`, contextual and readonly; tangent unchanged):
- One user message `<main-session-excerpt rounds total-rounds>` plus an assistant acknowledgement.
- The excerpt holds the main context's last 3 rounds: user messages (steers and BTW handoffs
  start rounds) and the assistant's text answers, with tool calls only counted.
- It also holds the main transcript path, for `read`/`grep`.
- Not copied: system messages, thinking, tool calls and output, `btw-note`, earlier rounds, and
  compaction summaries.
- Limits: 6000 chars per message (head and tail kept); 48000 chars in total, shrinking the
  oldest answers first.
- The BTW child gets the user's settings with `applyOverrides({ compaction: { enabled: false } })`.
  This is in memory only; `setAutoCompactionEnabled` would persist, so it is not used.
- Pi 1.2.0 `_checkCompaction` returns early when compaction is disabled, including on overflow.
  An overflow error therefore carries a hint: `/btw:summarize` or `/btw:new`.
- `PI_BTW_CONTEXT=full` restores the whole-context copy, with compaction on.

**Validated.**
- `npm test` 27/27:
  - `test/context.test.mjs`: excerpt rules, the settings override with the file untouched, and
    a real-session A/B on a small window. Lean: 1 call, ~5k chars. Full: a 107k-char request
    plus compaction calls.
  - `handoff.test.mjs` updated for the summary semantics, inject unchanged.
  - The native test asserts the excerpt.
- Typecheck passes; the 1.2.0 loader reports 0 errors; `~/.pi/agent/settings.json` is unmodified.
- Live Herdr runs with the local fake provider (no paid calls):
  - `test/live-context.mjs` with a copy of the user's real session (~244k est. tokens) and the
    window set so it is ~95% full:

    | | lean (default) | `PI_BTW_CONTEXT=full` |
    |---|---|---|
    | BTW requests | 1 | 3 |
    | Compaction calls | 0 | 2 (before answering) |
    | First request | ~5.9k est. tokens | ~97k est. tokens (after compaction) |
    | Reply visible | ~0.2–0.35 s | ~16.5 s |
    | Main-session compactions | unchanged (1 → 1) | unchanged (1 → 1) |

    Times are local: fake provider, no network.
  - `live-handoff.mjs`: summarize idle/busy/busy-steer/busy-Esc (reset at send; Esc → warning →
    the identical saved content resent), inject busy-steer/busy-Esc (kept until delivery),
    real-config busy-Esc, and `live-e2e` (isolated ×2, real config): all pass.

**Rollback.** Set `PI_BTW_CONTEXT=full` to restore the whole-context copy.

## Historical internal split / explicit fallback
Based on Dan Bachelder's MIT-licensed pi-btw 0.7.1. These changes are maintained here independently; the historical implementation was written on Pi 1.0.4 and re-verified on 1.2.0.

## Internal-mode behavior
- In internal mode, opening `/btw` (including `/side` and the other BTW entry commands) creates a real 60% main / 40% BTW split in fullscreen mode, at ≥120 columns and ≥14 rows. The complete main conversation and input dock reflow into the left allocation; BTW does not cover them.
- No pane at startup. Closing BTW, clearing/injecting/summarizing, session navigation, shutdown and factory failure release the reservation. Ordinary reopening defaults to split again.
- Smaller terminals and regular mode use the centered window fallback. Resizing back to a sufficiently large fullscreen terminal restores the split automatically.
- Alt+/ switches focus without hiding BTW. Alt+w explicitly opts into the old full-width side-chat mode; press again to return to split/window. Draft survives this toggle.
- Escape retains upstream semantics: during streaming it first aborts; when idle it closes. Threads and model/thinking settings retain upstream persistence and permissions.
- Fullscreen mouse wheel routes according to the pane under the pointer. Main transcript selection/scrollbar remain available when only the sidebar and sticky prompt bar are visible; unrelated dialogs keep stock suppression.
- The installed sticky-last-prompt PinBar is constrained to the main pane, and its prompt-anchor measurement uses main content width. Sidebar title presses are handled locally so they do not activate the pin behind it.
- Very short terminals use compact chrome to keep the BTW input reachable. For copying a long multiline BTW answer with terminal selection, Alt+w full-width mode remains available.

## Changed implementation
- `extensions/btw.ts`: overlay lifecycle integration, geometry-based height, short-screen fallback, normalized mouse handling and layout cleanup.
- `extensions/btw-split-layout.ts`: responsive HStack reservation, shared integer geometry, measurement/selection/sticky compatibility and ownership-safe cleanup.
- `test/split-layout.test.mjs`: geometry, reflow, resize, restoration, lifecycle, factory failure, drafts/focus, actual fullscreen renderer input, main text selection, proxy restoration and simulated sticky PinBar/dialog tests.
- `test/tsconfig.json`: typecheck against local Pi development dependencies.

Compatibility seams are intentionally isolated: reading the private `layoutRoot` and `overlayStack` fields and identifying the sticky `PinBar`. If layout access is unavailable, BTW warns and uses the original window. Future Pi/sticky upgrades can require adaptation; physical terminal behavior still needs manual verification.

## Validate
From the checkout root:

```sh
npm ci
npm test
npm run typecheck
```

These commands use the pinned Pi 1.2.0 development dependencies and offline providers, with no network model requests. Optionally, `PI_HOST_DIR` points runtime compatibility tests at another installed `@earendil-works/pi-coding-agent` package directory.

Live tests are opt-in with `PI_BTW_LIVE_TEST=1` and need Linux, Herdr 0.9.3, and the official Herdr Pi integration installed by `herdr integration install pi`. They load `$PI_CODING_AGENT_DIR/extensions/herdr-agent-state.ts`, or `~/.pi/agent/extensions/herdr-agent-state.ts` when `PI_CODING_AGENT_DIR` is unset; `PI_HERDR_EXTENSION` overrides that path. `node test/perf.mjs` optionally compares against a personal sticky-prompt extension at `PI_STICKY_EXTENSION`.

Internal-mode manual check after `/reload` and `/btw:ui internal`: use fullscreen and a wide terminal, `/btw`, Alt+/, wheel over each pane, select main text, resize, Alt+w twice, then Esc. Main must restore full width. Verify sticky prompt click-jump while scrolled past a wrapped prompt. Streaming Escape behavior and live terminal/IME behavior are not fully covered by the offline fixture.

## Activation and rollback
Install this package with `pi install git:github.com/yczheng-hit/pi-btw-split` or `pi install /absolute/path/to/pi-btw-split`. Do not load another package that registers `/btw` at the same time. Reload is user-triggered, not automatic.

Rollback: in the installed checkout, inspect `git status` and preserve local changes, check out an earlier commit with `git switch --detach <commit>`, and run `/reload`. Return with `git switch main` and `/reload`. For a Git install, `pi install git:github.com/yczheng-hit/pi-btw-split@<commit>` pins a version instead.


## Herdr state + rendering fix (2026-10-14)
- `extensions/btw-persistent-overlay.ts` obtains the TUI/keybindings in a short, explicitly tagged UI bootstrap, resolves `ctx.ui.custom` immediately, and mounts an owned `tui.showOverlay`. Closing uses that overlay's own handle and component disposal. This avoids keeping Pi's nested UI-prompt depth occupied for the life of the sidebar.
- BTW emits `btw:ui-bootstrap` around its tagged UI bootstrap, so an optional user bridge can ignore that bootstrap prompt while ordinary permission/custom/confirm prompts still report blocked. A reference bridge for tests lives in `test/live-fixtures/herdr-ui-prompt-blocked.ts`; it is not shipped as a package extension. The official Herdr Pi integration remains a separate prerequisite and is untouched.
- Completed Markdown is cached per entry index/text/width/style. Status/focus changes do not reparse the full history. Wrapped transcript lines are reused by typing/scroll frames; width and theme invalidation rebuild them. Removed the unused per-line Text component tree.
- `test/herdr-state.test.mjs` exercises the Pi ExtensionRunner prompt wrapper and the reference fixture bridge with `/bin/true` replacing Herdr metadata calls: no false blocked on bootstrap, actual approvals while sidebar is mounted do report blocked, cancellation clears state. The test went red before the bridge change.
- Existing real-extension lifecycle tests now assert stable wrapped history, zero Markdown reparses on unchanged refresh, one changed Markdown render on a stream delta, and full refresh on width/theme invalidation. The cache assertion went red before the optimization. All 10 tests pass; strict typecheck and real extension-load smoke pass.
- Run `node test/perf.mjs` for renderer/compositing-only measurements, no model calls or live terminal writes. Fixed fixture: 80 main-history groups and 100 long BTW replies, 160x40. Initial medians (ms): idle sidebar 11.21, typing 5.50, status refresh 16.76, stream update 16.47. After caching: idle 3.02, typing 2.31, status 3.04, stream 4.37. These historical short-run numbers fluctuate and are not physical input latency or a performance promise. Historical run with a personal sticky extension enabled: typing 1.66 ms, stream 4.27 ms in that fixture; no separate sticky regression demonstrated. Main rendering is still called twice per split frame by layout measurement.
- Activation remains user-triggered `/reload`. Verify open sidebar + working/idle status, an actual permission prompt + blocked status, closing prompt + restored status, input/scroll/streaming and IME. Physical-terminal lag is not proven fully eliminated by these offline tests. No Pi/Herdr restart or state override was issued.
