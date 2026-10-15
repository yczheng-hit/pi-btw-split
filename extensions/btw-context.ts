/**
 * Lean initial context for BTW: instead of copying the whole main-session context (tool output,
 * thinking, the main system prompt...), BTW starts from a short excerpt of the latest rounds —
 * the user's messages and the assistant's text answers — plus a pointer to the full transcript.
 * Deterministic and model-free, so opening BTW never needs a compaction.
 */

export const BTW_EXCERPT_ROUNDS = 3;
/** Longer messages keep their head and tail. */
export const BTW_EXCERPT_MESSAGE_CHARS = 6000;
/** Whole-excerpt ceiling (roughly 12–16k tokens); older answers shrink first. */
export const BTW_EXCERPT_TOTAL_CHARS = 48000;
const BTW_EXCERPT_SHRUNK_CHARS = 600;

export const BTW_EXCERPT_ACK_TEXT =
  "Understood. I have the recent main-session excerpt; I will look up the transcript only if something omitted is needed.";

/** `PI_BTW_CONTEXT=full` restores the old behavior: inherit the whole main-session context. */
export function useFullMainContext(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PI_BTW_CONTEXT === "full";
}

export type MainSessionExcerpt = {
  text: string;
  rounds: number;
  totalRounds: number;
};

type Round = { user: string; answers: string[]; toolCalls: number };

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

/** Split the main context into rounds: each user message (or BTW handoff) starts one. */
function collectRounds(messages: readonly unknown[]): Round[] {
  const rounds: Round[] = [];
  for (const raw of messages) {
    const message = raw as { role?: string; content?: unknown; customType?: string };
    if (message?.role === "user") {
      rounds.push({ user: contentText(message.content).trim(), answers: [], toolCalls: 0 });
    } else if (message?.role === "custom" && message.customType === "btw-handoff") {
      rounds.push({ user: `[BTW handoff]\n${contentText(message.content).trim()}`, answers: [], toolCalls: 0 });
    } else if (message?.role === "assistant" && rounds.length > 0 && Array.isArray(message.content)) {
      const round = rounds[rounds.length - 1];
      for (const part of message.content) {
        const block = part as { type?: string; text?: string };
        if (block?.type === "text" && block.text?.trim()) round.answers.push(block.text.trim());
        else if (block?.type === "toolCall") round.toolCalls += 1;
      }
    }
    // system, toolResult, thinking, compaction/branch summaries, other custom messages: omitted.
  }
  return rounds;
}

function formatRound(round: { user: string; answer: string; toolCalls: number }, index: number, count: number): string {
  return [
    `[Round ${index + 1} of ${count}]`,
    "User:",
    round.user || "(empty message)",
    "Assistant:",
    round.answer || "(no text answer)",
    ...(round.toolCalls > 0 ? [`(${round.toolCalls} tool call${round.toolCalls === 1 ? "" : "s"} omitted)`] : []),
  ].join("\n");
}

/**
 * Excerpt of the main session's latest rounds, or null when it has no user rounds yet.
 * `messages` is the main session's current context (`buildSessionContext(...).messages`).
 */
export function buildMainSessionExcerpt(
  messages: readonly unknown[],
  options: { rounds?: number; sessionFile?: string; maxMessageChars?: number; maxTotalChars?: number } = {},
): MainSessionExcerpt | null {
  const roundLimit = options.rounds ?? BTW_EXCERPT_ROUNDS;
  const maxMessage = options.maxMessageChars ?? BTW_EXCERPT_MESSAGE_CHARS;
  const maxTotal = options.maxTotalChars ?? BTW_EXCERPT_TOTAL_CHARS;
  const all = collectRounds(messages);
  if (all.length === 0) return null;
  const picked = all.slice(-roundLimit).map((round) => ({
    user: clipMiddle(round.user, maxMessage),
    answer: clipMiddle(round.answers.join("\n\n"), maxMessage),
    toolCalls: round.toolCalls,
  }));

  const header = [
    `<main-session-excerpt rounds="${picked.length}" total-rounds="${all.length}">`,
    `Excerpt of the main Pi session this side conversation branched from: the user's last ${picked.length} message${picked.length === 1 ? "" : "s"} and the assistant's text answers. Tool calls, tool output, thinking and earlier history are omitted.`,
    ...(options.sessionFile
      ? [`Full main-session transcript (JSONL): ${options.sessionFile} — read or grep it only if something omitted is needed.`]
      : []),
  ].join("\n");
  const render = () =>
    [header, "", picked.map((round, index) => formatRound(round, index, picked.length)).join("\n\n"), "</main-session-excerpt>"].join("\n");

  // Over the ceiling: shrink the oldest answers, then the oldest user messages.
  for (const field of ["answer", "user"] as const) {
    for (const round of picked) {
      if (render().length <= maxTotal) break;
      round[field] = clipMiddle(round[field], BTW_EXCERPT_SHRUNK_CHARS);
    }
  }
  let text = render();
  if (text.length > maxTotal) text = clipMiddle(text, maxTotal);
  return { text, rounds: picked.length, totalRounds: all.length };
}
