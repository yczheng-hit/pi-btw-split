// Bridge pi UI prompts (permission dialogs, plan review, select/confirm/input/custom)
// to herdr's "blocked" state, and tell herdr WHY it is blocked.
//
// - State: herdr's managed integration (herdr-agent-state.ts) only listens for
//   `herdr:blocked` on pi.events; pi emits ui_prompt_start/ui_prompt_end around
//   every ctx.ui prompt, so we forward those.
// - Reason: herdr has no blocked sub-states, so we publish display-only pane
//   metadata: state_labels.blocked (shown by the `state_text` sidebar token) and
//   token `blocked_reason` (shown by `$blocked_reason`).
// @ts-nocheck

import { execFile } from "node:child_process";

const LABELS = {
  ExitPlanMode: "plan ready",
  EnterPlanMode: "enter plan?",
};
const DEFAULT_LABEL = "approval";

export default function (pi) {
  const herdrBin = process.env.HERDR_BIN_PATH || "herdr";
  const paneId = process.env.HERDR_PANE_ID;
  if (process.env.HERDR_ENV !== "1" || !paneId) return;

  let active = false;
  const runningTools = new Map(); // toolCallId -> toolName

  let bootstrapActive = false;
  let ignoredBootstrapPrompt = false;
  pi.events.on("btw:ui-bootstrap", (event) => {
    bootstrapActive = event?.active === true;
  });
  function reportMetadata(label) {
    const args = ["pane", "report-metadata", paneId, "--source", "user:pi-blocked-reason"];
    if (label) {
      args.push("--state-label", `blocked=${label}`, "--token", `blocked_reason=${label}`);
    } else {
      args.push("--clear-state-labels", "--clear-token", "blocked_reason");
    }
    try {
      execFile(herdrBin, args, { timeout: 2000 }, () => {});
    } catch {}
  }

  function classify(event) {
    // Dialogs opened from inside a running tool (e.g. ExitPlanMode's plan review).
    for (const name of [...runningTools.values()].reverse()) {
      if (LABELS[name]) return LABELS[name];
    }
    // Permission dialogs open in the tool_call hook, before the tool starts,
    // and picc's dialog is an untitled ctx.ui.custom overlay.
    if (event?.title) return String(event.title).slice(0, 80);
    return DEFAULT_LABEL;
  }

  pi.on("tool_execution_start", (e) => runningTools.set(e.toolCallId, e.toolName));
  pi.on("tool_execution_end", (e) => runningTools.delete(e.toolCallId));

  pi.on("ui_prompt_start", (event) => {
    // Only the short-lived BTW TUI bootstrap is non-blocking. Its persistent
    // overlay is mounted separately, so real subsequent approvals still emit.
    if (bootstrapActive && event?.kind === "custom" && !active) {
      ignoredBootstrapPrompt = true;
      return;
    }
    if (active) return;
    active = true;
    const label = classify(event);
    reportMetadata(label);
    pi.events.emit("herdr:blocked", { active: true, label });
  });

  pi.on("ui_prompt_end", () => {
    if (ignoredBootstrapPrompt) {
      ignoredBootstrapPrompt = false;
      return;
    }
    if (!active) return;
    active = false;
    pi.events.emit("herdr:blocked", { active: false });
    reportMetadata(null);
  });
}
