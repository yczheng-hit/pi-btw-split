/**
 * Budgeted main-session snapshot for BTW.
 *
 * Each BTW question gets a fresh, deterministic, model-free view of the main session: its status, the
 * current task and the progress recorded so far, earlier finished rounds, and the latest compaction
 * summary Pi already produced. Tool output, thinking and system prompts stay in the transcript, which
 * BTW can read on demand. The snapshot fits a token budget derived from the BTW model, so a first
 * question never has to compact.
 */

/** Hard ceiling for the snapshot, in tokens. */
export const BTW_SNAPSHOT_MAX_TOKENS = 12000;
/** Floor for the snapshot when the window allows it. */
export const BTW_SNAPSHOT_MIN_TOKENS = 1500;
/** Status and task only, when the window has no room left. */
export const BTW_SNAPSHOT_EMERGENCY_TOKENS = 500;
/** Used when the BTW model reports no context window. */
export const BTW_SNAPSHOT_FALLBACK_TOKENS = 8000;
/** Share of the free context the snapshot may take. */
export const BTW_SNAPSHOT_SHARE = 0.25;
/** Room kept for the question itself. */
export const BTW_QUESTION_RESERVE_TOKENS = 2000;
/** Rough size of the BTW tool schemas, which are not known before the child session exists. */
export const BTW_TOOL_SCHEMA_TOKENS = 4000;

const SECTION_SHARES = { task: 0.15, progress: 0.35, recent: 0.2, summary: 0.3 } as const;
type SectionKey = keyof typeof SECTION_SHARES;
const SECTION_KEYS = Object.keys(SECTION_SHARES) as SectionKey[];

/** Initial per-item clipping, before any budget pressure. */
const PROGRESS_TEXT_CHARS = 1200;
const PROGRESS_TEXT_SHRUNK_CHARS = 300;
const PROGRESS_TEXT_TINY_CHARS = 80;
const PROGRESS_HEAD_ITEMS = 3;
const RECENT_REQUEST_CHARS = 1500;
const RECENT_ANSWER_CHARS = 2500;
const RECENT_SHRUNK_CHARS = 150;
const ARGS_CHARS = 160;
const ERROR_CHARS = 200;
const CONTINUED_REQUEST = "(Started before the latest compaction; see the compaction summary below.)";
const MIN_CLIPPED_SECTION_CHARS = 300;

export const BTW_SNAPSHOT_ACK_TEXT =
  "Understood. I have the main-session snapshot. It is partial: if something I need is missing, I will check the main transcript before concluding it does not exist.";

/** `PI_BTW_CONTEXT=full` restores the old behavior: inherit the whole main-session context. */
export function useFullMainContext(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PI_BTW_CONTEXT === "full";
}

/**
 * Token estimate that does not undercount CJK text: Pi's chars/4 heuristic would let a Chinese
 * snapshot use several times its budget. ASCII counts as 1/4 token, anything else as 1 token.
 */
export function estimateTextTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 128) ascii++;
    else if (code < 0xdc00 || code > 0xdfff) other++; // a surrogate pair counts once
  }
  return Math.ceil(ascii / 4) + other;
}

/**
 * Snapshot budget: 25% of the context left after Pi's compaction reserve, the fixed prompt and the
 * question, between 1.5k and 12k tokens, and never more than what is left.
 */
export function computeSnapshotBudgetTokens(options: {
  contextWindow?: number;
  reserveTokens?: number;
  fixedTokens?: number;
}): number {
  const window = options.contextWindow ?? 0;
  if (!(window > 0)) return BTW_SNAPSHOT_FALLBACK_TOKENS;
  const available = window - (options.reserveTokens ?? 0) - (options.fixedTokens ?? 0) - BTW_QUESTION_RESERVE_TOKENS;
  // Already near the threshold without a snapshot: still say what the main session is doing.
  if (available <= BTW_SNAPSHOT_EMERGENCY_TOKENS) return BTW_SNAPSHOT_EMERGENCY_TOKENS;
  const wanted = Math.max(BTW_SNAPSHOT_MIN_TOKENS, available * BTW_SNAPSHOT_SHARE);
  return Math.floor(Math.min(available, BTW_SNAPSHOT_MAX_TOKENS, wanted));
}

type Call = { n: number; id: string; name: string; args: string; status: "pending" | "ok" | "error"; error?: string };
type Item = { kind: "text"; text: string } | { kind: "call"; call: Call };
type Round = { requests: string[]; items: Item[]; awaiting: boolean; calls: Call[] };

export type MainSessionSnapshot = {
  text: string;
  tokens: number;
  budgetTokens: number;
  totalRounds: number;
  sections: SectionKey[];
  omitted: { progressItems: number; rounds: number; summarySections: number };
};

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const block = part as { type?: string; text?: string };
      if (block?.type === "text" && typeof block.text === "string") return block.text;
      if (block?.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Keep the head and tail of long text. */
export function clipMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = `\n[… ${text.length - max} characters omitted …]\n`;
  const keep = Math.max(0, max - marker.length);
  const head = Math.ceil(keep * 0.6);
  return text.slice(0, head) + marker + text.slice(text.length - (keep - head));
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`;
}

function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return args === undefined ? "" : oneLine(String(args), ARGS_CHARS);
  const record = args as Record<string, unknown>;
  for (const key of ["command", "path", "pattern", "query", "url", "file_path"]) {
    if (typeof record[key] === "string") return oneLine(`${key}: ${record[key] as string}`, ARGS_CHARS);
  }
  let json = "";
  try {
    json = JSON.stringify(args);
  } catch {
    json = "[unserializable arguments]";
  }
  return oneLine(json, ARGS_CHARS);
}

/**
 * Split the main context into rounds. A user message or BTW handoff starts a round, except a user
 * message sent while the round is still working (a steer), which joins it as a follow-up.
 */
function collectRounds(messages: readonly unknown[]): { rounds: Round[]; compactionSummary?: string; branchSummaries: string[] } {
  const rounds: Round[] = [];
  const callsById = new Map<string, Call>();
  const branchSummaries: string[] = [];
  let compactionSummary: string | undefined;
  const current = () => rounds[rounds.length - 1];
  const startRound = (request: string) => rounds.push({ requests: [request], items: [], awaiting: false, calls: [] });
  // Work with no request before it: the request was compacted away mid-turn.
  const roundForWork = () => {
    if (!current()) startRound(CONTINUED_REQUEST);
    return current()!;
  };

  for (const raw of messages) {
    const message = raw as {
      role?: string; content?: unknown; customType?: string; summary?: string; stopReason?: string;
      toolCallId?: string; isError?: boolean; command?: string; exitCode?: number; cancelled?: boolean; excludeFromContext?: boolean;
    };
    switch (message?.role) {
      case "user": {
        const text = contentText(message.content).trim() || "(empty message)";
        const round = current();
        if (round && (round.awaiting || round.items.length === 0)) round.requests.push(text);
        else startRound(text);
        break;
      }
      case "custom":
        if (message.customType === "btw-handoff") startRound(`[BTW handoff]\n${contentText(message.content).trim()}`);
        break; // btw-note and other extension messages: omitted
      case "assistant": {
        if (!Array.isArray(message.content)) break;
        const round = roundForWork();
        let hasCall = false;
        for (const part of message.content) {
          const block = part as { type?: string; text?: string; id?: string; name?: string; arguments?: unknown };
          if (block?.type === "text" && block.text?.trim()) {
            round.items.push({ kind: "text", text: block.text.trim() });
          } else if (block?.type === "toolCall") {
            hasCall = true;
            const call: Call = { n: round.calls.length + 1, id: block.id ?? "", name: block.name ?? "tool", args: summarizeArgs(block.arguments), status: "pending" };
            round.calls.push(call);
            if (call.id) callsById.set(call.id, call);
            round.items.push({ kind: "call", call });
          }
        }
        // Waiting for tool results; an aborted or failed turn does not continue.
        round.awaiting = message.stopReason === "toolUse" || (hasCall && message.stopReason !== "aborted" && message.stopReason !== "error");
        break;
      }
      case "toolResult": {
        const call = message.toolCallId ? callsById.get(message.toolCallId) : undefined;
        if (!call) break;
        call.status = message.isError ? "error" : "ok";
        if (message.isError) {
          const firstLine = contentText(message.content).split("\n").find((line) => line.trim()) ?? "";
          call.error = oneLine(firstLine, ERROR_CHARS);
        }
        break;
      }
      case "bashExecution": {
        if (message.excludeFromContext) break;
        const round = roundForWork();
        const call: Call = {
          n: round.calls.length + 1, id: "", name: "user !bash", args: oneLine(message.command ?? "", ARGS_CHARS),
          status: message.cancelled || (message.exitCode ?? 0) !== 0 ? "error" : "ok",
          ...(message.cancelled ? { error: "cancelled" } : (message.exitCode ?? 0) !== 0 ? { error: `exit ${message.exitCode}` } : {}),
        };
        round.calls.push(call);
        round.items.push({ kind: "call", call });
        break;
      }
      case "compactionSummary":
        if (message.summary?.trim()) compactionSummary = message.summary.trim();
        break;
      case "branchSummary":
        if (message.summary?.trim()) branchSummaries.push(message.summary.trim());
        break;
      // system, thinking (inside assistant), other roles: omitted
    }
  }
  return { rounds, compactionSummary, branchSummaries };
}

type Rendered = { text: string; omitted: number };

function formatCall(call: Call, mainRunning: boolean): string {
  const target = call.id ? ` [${call.id}]` : "";
  const status = call.status === "ok"
    ? "ok"
    : call.status === "error"
      ? `ERROR${call.error ? `: ${call.error}` : ""}`
      : mainRunning ? "waiting for result (may still be running)" : "no result recorded (interrupted?)";
  return `- #${call.n} ${call.name}(${call.args})${target} → ${status}`;
}

/**
 * Lines that fit `budget`. Shrink older lines (mild, then hard), then keep the first lines and as many
 * of the newest as fit, with a marker for the gap. The newest line always survives.
 */
function fitLines(
  lines: string[],
  budget: number,
  shrinkSteps: Array<(line: string) => string>,
  keepHead: number,
): Rendered {
  const size = (list: string[]) => list.join("\n").length;
  const current = [...lines];
  if (size(current) <= budget) return { text: current.join("\n"), omitted: 0 };
  for (const shrink of shrinkSteps) {
    // Shrink older lines first, keeping the newest intact.
    for (let i = 0; i < current.length - 1 && size(current) > budget; i++) current[i] = shrink(current[i]);
    if (size(current) <= budget) return { text: current.join("\n"), omitted: 0 };
  }
  if (current.length === 1) return { text: clipMiddle(current[0], budget), omitted: 0 };

  const markerFor = (count: number) => `- [… ${count} items omitted; see the main transcript …]`;
  const marker = markerFor(current.length);
  const newest = current[current.length - 1];
  // The newest item, the gap marker and at least the first item; more head items when they fit.
  let head: string[] = [];
  for (let count = Math.min(keepHead, current.length - 1); count >= 0; count--) {
    head = current.slice(0, count);
    if (size([...head, marker, newest]) <= budget) break;
  }
  const tail = [newest];
  let used = size([...head, marker, ...tail]);
  for (let i = current.length - 2; i >= head.length; i--) {
    const cost = current[i].length + 1;
    if (used + cost > budget) break;
    tail.unshift(current[i]);
    used += cost;
  }
  const omitted = current.length - head.length - tail.length;
  const text = [...head, ...(omitted > 0 ? [markerFor(omitted)] : []), ...tail].join("\n");
  return { text: size([text]) <= budget ? text : clipMiddle(text, budget), omitted };
}

function renderTask(round: Round, budget: number): Rendered {
  const label = (index: number) => (index === 0 ? "Instruction" : `Follow-up ${index}`);
  const full = round.requests.map((request, index) => `${label(index)}:\n${request}`).join("\n\n");
  if (full.length <= budget) return { text: full, omitted: 0 };
  // Newest follow-ups matter most: give the first instruction a fair share, the rest to follow-ups.
  const per = Math.max(MIN_CLIPPED_SECTION_CHARS, Math.floor(budget / round.requests.length) - 20);
  const text = round.requests.map((request, index) => `${label(index)}:\n${clipMiddle(request, per)}`).join("\n\n");
  return { text: clipMiddle(text, budget), omitted: 0 };
}

function renderProgress(round: Round, budget: number, mainRunning: boolean): Rendered {
  const lines = round.items.map((item) =>
    item.kind === "text"
      ? `- Assistant: ${clipMiddle(item.text, PROGRESS_TEXT_CHARS).replace(/\n/g, "\n  ")}`
      : formatCall(item.call, mainRunning),
  );
  const failed = round.calls.filter((call) => call.status === "error").length;
  const pending = round.calls.filter((call) => call.status === "pending").length;
  const stats = `Recorded so far: ${round.calls.length} tool call${round.calls.length === 1 ? "" : "s"}, ${failed} failed, ${pending} without result.`;
  if (lines.length === 0) {
    return { text: `${stats}\nNo assistant text or tool calls recorded for this task yet.`, omitted: 0 };
  }
  const tail = mainRunning && round.awaiting
    ? "- Now: still working. Text being generated and tools still running are not in the transcript yet."
    : "";
  const reserved = stats.length + tail.length + 2;
  const fitted = fitLines(
    lines,
    Math.max(0, budget - reserved),
    [
      (line) => (line.startsWith("- Assistant:") ? clipMiddle(line, PROGRESS_TEXT_SHRUNK_CHARS) : line),
      (line) => (line.startsWith("- Assistant:") ? oneLine(line, PROGRESS_TEXT_TINY_CHARS) : line),
    ],
    PROGRESS_HEAD_ITEMS,
  );
  return { text: [stats, fitted.text, ...(tail ? [tail] : [])].join("\n"), omitted: fitted.omitted };
}

function finalAnswer(round: Round): string {
  let lastCall = -1;
  round.items.forEach((item, index) => {
    if (item.kind === "call") lastCall = index;
  });
  const after = round.items.slice(lastCall + 1).filter((item): item is Extract<Item, { kind: "text" }> => item.kind === "text");
  const texts = after.length > 0 ? after : round.items.filter((item): item is Extract<Item, { kind: "text" }> => item.kind === "text").slice(-1);
  return texts.map((item) => item.text).join("\n\n");
}

function renderRecent(rounds: Round[], budget: number): Rendered {
  const blocks: string[] = [];
  let used = 0;
  let index = rounds.length - 1;
  const full = (round: Round) => {
    const calls = round.calls.length;
    const failed = round.calls.filter((call) => call.status === "error").length;
    return [
      `User: ${clipMiddle(round.requests.join("\n\n[Follow-up]\n"), RECENT_REQUEST_CHARS)}`,
      `Assistant: ${clipMiddle(finalAnswer(round), RECENT_ANSWER_CHARS) || "(no text answer)"}`,
      ...(calls > 0 ? [`(${calls} tool call${calls === 1 ? "" : "s"}${failed > 0 ? `, ${failed} failed` : ""})`] : []),
    ].join("\n");
  };
  const short = (round: Round) =>
    `User: ${oneLine(round.requests[0] ?? "", RECENT_SHRUNK_CHARS)} → Assistant: ${oneLine(finalAnswer(round), RECENT_SHRUNK_CHARS) || "(no text answer)"}`;
  const marker = (count: number) => `[… ${count} earlier round${count === 1 ? "" : "s"} omitted; see the main transcript …]`;
  const reserve = marker(rounds.length).length + 2;
  for (; index >= 0; index--) {
    const block = full(rounds[index]);
    if (used + block.length + 2 > budget - reserve) break;
    blocks.unshift(block);
    used += block.length + 2;
  }
  for (; index >= 0; index--) {
    const block = short(rounds[index]);
    if (used + block.length + 1 > budget - reserve) break;
    blocks.unshift(block);
    used += block.length + 1;
  }
  const omitted = index + 1;
  return { text: [...(omitted > 0 ? [marker(omitted)] : []), ...blocks].join("\n\n"), omitted };
}

const SUMMARY_PRIORITIES: Array<[RegExp, number]> = [
  [/goal|objective|original request/i, 0],
  [/progress|status/i, 1],
  [/block/i, 2],
  [/next/i, 3],
  [/decision/i, 4],
  [/constraint|preference/i, 5],
  [/critical|context/i, 6],
];

function summaryPriority(heading: string): number {
  for (const [pattern, priority] of SUMMARY_PRIORITIES) if (pattern.test(heading)) return priority;
  return 7;
}

/** Keep the most useful summary sections whole, in their original order; file lists go first. */
function renderSummary(summary: string, budget: number): Rendered {
  const cleaned = summary
    .replace(/<(read-files|modified-files)>[\s\S]*?<\/\1>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (cleaned.length <= budget) return { text: cleaned, omitted: summary === cleaned ? 0 : 1 };

  const sections: Array<{ text: string; priority: number; order: number }> = [];
  for (const part of cleaned.split(/\n(?=#{1,2} )/)) {
    const heading = part.match(/^#{1,2} (.*)/)?.[1] ?? "";
    sections.push({ text: part.trim(), priority: heading ? summaryPriority(heading) : 7, order: sections.length });
  }
  const chosen = new Map<number, string>();
  let used = 0;
  const marker = "[… lower-priority summary sections omitted; see the main transcript …]";
  let clipped = 0;
  const room = budget - marker.length - 2;
  for (const section of [...sections].sort((a, b) => a.priority - b.priority || a.order - b.order)) {
    const remaining = room - used;
    if (section.text.length + 2 <= remaining) {
      chosen.set(section.order, section.text);
      used += section.text.length + 2;
    } else if (remaining >= MIN_CLIPPED_SECTION_CHARS) {
      chosen.set(section.order, clipMiddle(section.text, remaining - 2));
      clipped++;
      used = room;
    }
  }
  const omitted = sections.length - chosen.size;
  const text = sections.filter((section) => chosen.has(section.order)).map((section) => chosen.get(section.order)!).join("\n\n");
  const note = omitted > 0 ? marker : "[… summary trimmed to fit; see the main transcript …]";
  return { text: `${text}\n\n${note}`, omitted: Math.max(1, omitted + clipped) };
}

/** Give each section its share; shares a section does not need go to the others. */
function allocate(total: number, natural: Record<SectionKey, number>): Record<SectionKey, number> {
  const allocation = { task: 0, progress: 0, recent: 0, summary: 0 };
  let open = SECTION_KEYS.filter((key) => natural[key] > 0);
  let remaining = total;
  for (let changed = true; changed && open.length > 0;) {
    changed = false;
    const shareSum = open.reduce((sum, key) => sum + SECTION_SHARES[key], 0);
    for (const key of open) {
      if (natural[key] <= (remaining * SECTION_SHARES[key]) / shareSum) {
        allocation[key] = natural[key];
        remaining -= natural[key];
        open = open.filter((other) => other !== key);
        changed = true;
        break;
      }
    }
  }
  const shareSum = open.reduce((sum, key) => sum + SECTION_SHARES[key], 0);
  for (const key of open) allocation[key] = Math.floor((remaining * SECTION_SHARES[key]) / shareSum);
  return allocation;
}

const SECTION_TITLES: Record<SectionKey, (finished: boolean) => string> = {
  task: (finished) => (finished ? "## Latest task (finished)" : "## Current task"),
  progress: (finished) => (finished ? "## Progress on the latest task" : "## Progress on the current task (recorded so far)"),
  recent: () => "## Earlier finished rounds (newest last)",
  summary: () => "## Existing compaction summary (latest; written before the rounds above)",
};

/**
 * Snapshot of the main session for one BTW question, or null when there is nothing to show.
 * `messages` is the main session's current context (`buildSessionContext(...).messages`).
 */
export function buildMainSessionSnapshot(
  messages: readonly unknown[],
  options: { sessionFile?: string; mainRunning?: boolean; budgetTokens?: number; now?: Date } = {},
): MainSessionSnapshot | null {
  const { rounds, compactionSummary, branchSummaries } = collectRounds(messages);
  const summary = [compactionSummary, ...branchSummaries.map((text) => `## Branch summary\n${text}`)].filter(Boolean).join("\n\n");
  if (rounds.length === 0 && !summary) return null;

  const mainRunning = options.mainRunning ?? false;
  const budgetTokens = options.budgetTokens ?? BTW_SNAPSHOT_FALLBACK_TOKENS;
  const latest = rounds[rounds.length - 1];
  const finished = !!latest && !(mainRunning || latest.awaiting);
  const earlier = rounds.slice(0, -1);
  const renderers: Record<SectionKey, ((budget: number) => Rendered) | undefined> = {
    task: latest ? (budget) => renderTask(latest, budget) : undefined,
    progress: latest ? (budget) => renderProgress(latest, budget, mainRunning) : undefined,
    recent: earlier.length > 0 ? (budget) => renderRecent(earlier, budget) : undefined,
    summary: summary ? (budget) => renderSummary(summary, budget) : undefined,
  };

  const header = (omitted: MainSessionSnapshot["omitted"]) => [
    `<main-session-snapshot generated-at="${(options.now ?? new Date()).toISOString()}" main-status="${mainRunning ? "running" : "idle"}" compacted="${compactionSummary ? "yes" : "no"}" rounds="${rounds.length}">`,
    "Budgeted, partial snapshot of the main Pi session this side conversation belongs to. It is not the full record: tool output, thinking, system prompts and some older content are left out.",
    mainRunning
      ? "Main status: running. Only work already written to the transcript is shown; later work is not."
      : "Main status: idle.",
    ...(options.sessionFile
      ? [`Main transcript (JSONL): ${options.sessionFile}. Read or search it (e.g. by toolCallId) for anything omitted before saying it does not exist.`]
      : ["The main session has no transcript file; anything omitted here is unavailable."]),
    `Omitted for budget: ${omitted.progressItems} progress items, ${omitted.rounds} earlier rounds, ${omitted.summarySections} summary sections.`,
  ].join("\n");

  const render = (charBudget: number): { text: string; sections: SectionKey[]; omitted: MainSessionSnapshot["omitted"] } => {
    const reserve = header({ progressItems: 99999, rounds: 99999, summarySections: 99999 }).length + "\n</main-session-snapshot>".length + 200;
    const available = Math.max(0, charBudget - reserve);
    const natural = Object.fromEntries(
      SECTION_KEYS.map((key) => [key, renderers[key] ? renderers[key]!(Number.MAX_SAFE_INTEGER).text.length : 0]),
    ) as Record<SectionKey, number>;
    const allocation = allocate(available, natural);
    const parts: string[] = [];
    const sections: SectionKey[] = [];
    const omitted = { progressItems: 0, rounds: 0, summarySections: 0 };
    for (const key of SECTION_KEYS) {
      const renderer = renderers[key];
      if (!renderer) continue;
      if (allocation[key] < Math.min(40, natural[key])) {
        if (key === "progress") omitted.progressItems = latest?.items.length ?? 0;
        if (key === "recent") omitted.rounds = earlier.length;
        if (key === "summary") omitted.summarySections = 1;
        continue;
      }
      const result = renderer(allocation[key] >= natural[key] ? Number.MAX_SAFE_INTEGER : allocation[key]);
      if (key === "progress") omitted.progressItems = result.omitted;
      if (key === "recent") omitted.rounds = result.omitted;
      if (key === "summary") omitted.summarySections = result.omitted;
      parts.push(`${SECTION_TITLES[key](finished)}\n${result.text}`);
      sections.push(key);
    }
    return { text: [header(omitted), "", parts.join("\n\n"), "</main-session-snapshot>"].join("\n"), sections, omitted };
  };

  // Render against a character budget, then tighten until the token estimate fits.
  let charBudget = budgetTokens * 4;
  let result = render(charBudget);
  for (let attempt = 0; attempt < 6 && estimateTextTokens(result.text) > budgetTokens; attempt++) {
    charBudget = Math.floor((charBudget * budgetTokens) / estimateTextTokens(result.text) * 0.95);
    result = render(charBudget);
  }
  let text = result.text;
  // Last resort for tiny budgets: clip the body, keep the tags.
  while (estimateTextTokens(text) > budgetTokens && text.length > 200) {
    const open = text.slice(0, text.indexOf("\n") + 1);
    const close = "\n</main-session-snapshot>";
    const body = text.slice(open.length, text.length - close.length);
    text = open + clipMiddle(body, Math.floor(body.length * 0.8)) + close;
  }
  return {
    text,
    tokens: estimateTextTokens(text),
    budgetTokens,
    totalRounds: rounds.length,
    sections: result.sections,
    omitted: result.omitted,
  };
}
