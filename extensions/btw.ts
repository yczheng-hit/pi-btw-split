import {
  buildSessionContext,
  createAgentSession,
  createExtensionRuntime,
  getAgentDir,
  getPackageDir,
  getMarkdownTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type CreateAgentSessionOptions,
  type AgentSessionEvent,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  Type,
  type AssistantMessage,
  type Message,
  isContextOverflow,
  type ThinkingLevel as AiThinkingLevel,
  type UserMessage,
} from "@earendil-works/pi-ai";
import {
  Box,
  Container,
  Input,
  Key,
  Markdown,
  Text,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Focusable,
  type KeybindingsManager,
  type KeyId,
  type MarkdownTheme,
  type OverlayHandle,
  type TUI,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { loadBtwExtensionResources, readBtwExtensionSources } from "./btw-extension-tools";
import { createBtwSplitLayout } from "./btw-split-layout";
import {
  BTW_EARLIER_ACK_TEXT,
  BTW_EARLIER_DISCUSSION_SHARE,
  BTW_SNAPSHOT_ACK_TEXT,
  BTW_TOOL_SCHEMA_TOKENS,
  BTW_UPDATE_SHARE,
  buildEarlierDiscussion,
  buildMainSessionSnapshot,
  buildMainSessionUpdate,
  collectMainSessionDelta,
  computeSnapshotBudgetTokens,
  estimateTextTokens,
  snapshotBudgetSettings,
  useFullMainContext,
} from "./btw-context";
import { getBtwUiResources, showBtwOverlay } from "./btw-persistent-overlay";
import { NativeSurface } from "../native/surface.mjs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const BTW_MESSAGE_TYPE = "btw-note";
const BTW_ENTRY_TYPE = "btw-thread-entry";
const BTW_RESET_TYPE = "btw-thread-reset";
const BTW_MODEL_OVERRIDE_TYPE = "btw-model-override";
const BTW_THINKING_OVERRIDE_TYPE = "btw-thinking-override";
/** Labelled handoff into the main session (custom message; reaches the model, rendered as a BTW card). */
export const BTW_HANDOFF_TYPE = "btw-handoff";
/** Persisted marker for a handoff that has been sent but not yet seen in the main session. */
const BTW_HANDOFF_PENDING_TYPE = "btw-handoff-pending";
/** Persisted marker: /btw:clear dropped this handoff, so restore must not offer it for resend. */
const BTW_HANDOFF_DISCARDED_TYPE = "btw-handoff-discarded";
const BTW_DEFAULT_FOCUS_SHORTCUTS: readonly KeyId[] = [Key.alt("/"), Key.super("/"), Key.ctrlAlt("w")];
const BTW_FOCUS_KEYS_ENV = "PI_BTW_FOCUS_KEYS";
const BTW_FOCUS_MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);
// Mirrors the SpecialKey union in @earendil-works/pi-tui keys.d.ts (lower-cased).
const BTW_FOCUS_SPECIAL_KEYS = new Set([
  "escape", "esc", "enter", "return", "tab", "space", "backspace", "delete", "insert", "clear",
  "home", "end", "pageup", "pagedown", "up", "down", "left", "right",
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
]);
// Symbols from the SymbolKey union (letters/digits are matched directly).
const BTW_FOCUS_SYMBOL_KEYS = new Set([
  "`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "!", "@", "#", "$", "%", "^", "&", "*",
  "(", ")", "_", "+", "|", "~", "{", "}", ":", "<", ">", "?",
]);

/**
 * Resolve the BTW overlay focus-toggle shortcuts.
 *
 * Users whose window manager or terminal claims the default shortcuts can override them by
 * setting PI_BTW_FOCUS_KEYS to a comma-separated list of pi-tui key identifiers
 * (e.g. "ctrl+/,ctrl+alt+b"). Blank, duplicate, or unparseable entries are ignored; if no
 * usable entries remain, the defaults are kept so focus toggling never becomes impossible.
 */
export function resolveBtwFocusShortcuts(env: NodeJS.ProcessEnv = process.env): KeyId[] {
  const raw = env[BTW_FOCUS_KEYS_ENV];
  if (typeof raw !== "string" || raw.trim() === "") {
    return [...BTW_DEFAULT_FOCUS_SHORTCUTS];
  }

  const seen = new Set<string>();
  const shortcuts: KeyId[] = [];
  for (const part of raw.split(",")) {
    const candidate = part.trim().toLowerCase();
    if (!candidate || seen.has(candidate) || !isValidFocusShortcut(candidate)) {
      continue;
    }
    seen.add(candidate);
    shortcuts.push(candidate as KeyId);
  }

  return shortcuts.length > 0 ? shortcuts : [...BTW_DEFAULT_FOCUS_SHORTCUTS];
}

/**
 * Validate a candidate against the pi-tui KeyId grammar: zero or more distinct recognized
 * modifiers followed by exactly one base key (letter, digit, symbol, or named special key).
 * Rejects typos like "cmd+/" or "control+x" and duplicate/empty segments.
 */
export function isValidFocusShortcut(candidate: string): boolean {
  const segments = candidate.split("+");
  const base = segments.pop();
  if (base === undefined || !isValidFocusBaseKey(base)) {
    return false;
  }

  const seen = new Set<string>();
  for (const segment of segments) {
    if (!BTW_FOCUS_MODIFIERS.has(segment) || seen.has(segment)) {
      return false;
    }
    seen.add(segment);
  }

  return true;
}

function isValidFocusBaseKey(base: string): boolean {
  if (base.length === 1) {
    return /[a-z0-9]/.test(base) || BTW_FOCUS_SYMBOL_KEYS.has(base);
  }
  return BTW_FOCUS_SPECIAL_KEYS.has(base);
}

function formatFocusShortcutLabel(shortcut: KeyId): string {
  return shortcut
    .split("+")
    .map((segment) => {
      switch (segment) {
        case "ctrl":
          return "Ctrl";
        case "alt":
          return "Alt";
        case "shift":
          return "Shift";
        case "super":
          return "Super";
        default:
          return segment.length === 1 ? segment.toUpperCase() : segment;
      }
    })
    .join("+");
}

export function describeFocusShortcuts(shortcuts: readonly KeyId[]): string {
  const labels = shortcuts.map(formatFocusShortcutLabel);
  if (labels.length <= 1) {
    return labels[0] ?? "";
  }
  return `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}`;
}

const BTW_FOCUS_SHORTCUTS: readonly KeyId[] = resolveBtwFocusShortcuts();
const BTW_FOCUS_SHORTCUTS_LABEL = describeFocusShortcuts(BTW_FOCUS_SHORTCUTS);

function matchesBtwFocusShortcut(data: string): boolean {
  return BTW_FOCUS_SHORTCUTS.some((shortcut) => matchesKey(data, shortcut));
}

/** Toggles the overlay between framed "window" width and edge-to-edge "full" width. */
const BTW_WIDTH_TOGGLE_SHORTCUT: KeyId = Key.alt("w");

function matchesBtwWidthToggle(data: string): boolean {
  return matchesKey(data, BTW_WIDTH_TOGGLE_SHORTCUT);
}

type BtwOverlayWidthMode = "window" | "full";

export const BTW_SYSTEM_PROMPT = [
  "You are having an aside conversation with the user, separate from their main working session.",
  "If main session messages are provided, they are for context only — that work is being handled by another agent.",
  "A <main-session-snapshot> is a budgeted, partial view taken when this BTW conversation started, not the full record: when something you need is missing (tool output, older history, omitted items), read or search the main transcript file it names before saying the main session has no such information.",
  "The main session keeps working while you talk, so that view ages. A later <main-session-update> (appended before a question, or returned by the main_session_update tool) is newer and wins over earlier context. If it makes one of your earlier answers outdated, say so plainly instead of building on it.",
  "An update is background, not a request: answer the user's question that comes with it.",
  "When main_session_update is available and the question depends on what the main session is doing now (its latest progress, results, or decisions), call it before answering; otherwise do not.",
  "If no main session messages are provided, treat this as a fully contextless tangent thread and rely only on the user's words plus your general instructions.",
  "Focus on answering the user's side questions, helping them think through ideas, or planning next steps.",
  "Do not act as if you need to continue unfinished work from the main session unless the user explicitly asks you to prepare something for injection back to it.",
].join(" ");

const BTW_SUMMARIZE_SYSTEM_PROMPT =
  "Summarize the side conversation concisely. Preserve key decisions, plans, insights, risks, and action items. Output only the summary.";

type SessionThinkingLevel = "off" | AiThinkingLevel;
type BtwThreadMode = "contextual" | "tangent" | "readonly";
type SessionModel = NonNullable<ExtensionCommandContext["model"]>;
/**
 * Loose model reference parsed from `/btw:model <provider> <id> <api>` and persisted to
 * session entries. Resolved to a full SessionModel via ctx.modelRegistry.find(...).
 */
type BtwModelRef = Pick<SessionModel, "provider" | "id" | "api">;

type BtwDetails = {
  question: string;
  thinking: string;
  answer: string;
  provider: string;
  model: string;
  api: string;
  thinkingLevel: SessionThinkingLevel;
  timestamp: number;
  usage?: AssistantMessage["usage"];
};

type ParsedBtwArgs = {
  question: string;
  save: boolean;
};

type SaveState = "not-saved" | "saved" | "queued";

type BtwResetDetails = {
  timestamp: number;
  mode?: BtwThreadMode;
};

export type BtwHandoffKind = "summary" | "thread";

/** Custom-message details for a handoff; Pi never sends details to the model. */
export type BtwHandoffDetails = {
  id: string;
  kind: BtwHandoffKind;
  exchanges: number;
  instructions: string;
  createdAt: number;
};

/** A sent handoff awaiting confirmation, or an undelivered one cached for resend. */
type BtwHandoffRecord = BtwHandoffDetails & {
  content: string;
  threadLength: number;
  /** Summary handoffs clear their thread when sent (split.4); restore then ignores later resets. */
  threadCleared?: boolean;
};

type BtwModelOverrideDetails =
  | ({ timestamp: number; action: "set" } & Pick<SessionModel, "provider" | "id" | "api">)
  | { timestamp: number; action: "clear" };

type BtwThinkingOverrideDetails =
  | { timestamp: number; action: "set"; thinkingLevel: SessionThinkingLevel }
  | { timestamp: number; action: "clear" };

type ResolvedBtwModel = {
  model: SessionModel | null;
  source: "override" | "main" | "none";
  configuredOverride: SessionModel | null;
  fallbackReason?: string;
};

type ResolvedBtwSettings = {
  model: SessionModel | null;
  modelSource: "override" | "main" | "none";
  configuredModelOverride: SessionModel | null;
  thinkingLevel: SessionThinkingLevel;
  thinkingSource: "override" | "main";
  fallbackReason?: string;
};

type BtwTurnOutcome = "completed" | "aborted" | "failed";

type BtwTranscriptEntry =
  | { id: number; turnId: number; type: "turn-boundary"; phase: "start" | "end"; outcome?: BtwTurnOutcome }
  | { id: number; turnId: number; type: "user-message"; text: string }
  | { id: number; turnId: number; type: "thinking"; text: string; streaming: boolean }
  | { id: number; turnId: number; type: "assistant-text"; text: string; streaming: boolean }
  | { id: number; turnId: number; type: "tool-call"; toolCallId: string; toolName: string; args: string }
  | {
      id: number;
      turnId: number;
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      content: string;
      truncated: boolean;
      isError: boolean;
      streaming: boolean;
    };

type BtwTranscript = BtwTranscriptEntry[];

type BtwTranscriptState = {
  entries: BtwTranscript;
  nextEntryId: number;
  nextTurnId: number;
  currentTurnId: number | null;
  lastTurnId: number | null;
  toolCalls: Map<string, { turnId: number; callEntryId: number; resultEntryId?: number }>;
};

type BtwSessionRuntime = {
  session: AgentSession;
  mode: BtwThreadMode;
  subscriptions: Set<() => void>;
  /** Main-session leaf and run state the seed snapshot was taken from; a change means the seed is stale. */
  seedLeafId: string | null;
  seedMainIdle: boolean;
  /** Set by the first question. Until then a stale seed (e.g. prewarmed when the pane opened) is rebuilt. */
  used: boolean;
  /** /btw:sync: append the main session's progress before the next question. */
  syncRequested?: boolean;
  /**
   * Last point the conversation has seen of the main session (snapshot or appended update). Later main
   * activity is appended as a <main-session-update>; earlier BTW turns are never rewritten.
   */
  sync: BtwSyncPoint;
  /** Main context in this conversation: none (tangent), or a snapshot/update with its time. */
  baseAt: number | null;
  abortPromise?: Promise<void>;
  promptQueue: Promise<void>;
  hasExtensions: boolean;
};

type BtwSyncPoint = { leafId: string | null; mainRunning: boolean; at: number };

/**
 * Restart the conversation (new snapshot + earlier BTW exchanges) once it fills this share of the room
 * before Pi's auto-compaction (window minus reserve), so the next exchange still fits without compacting.
 */
const BTW_RESTART_CONTEXT_SHARE = 0.6;
const BTW_UPDATE_TOOL = "main_session_update";
/** Main-session messages BTW leaves out of its own view of the main session. */
const BTW_HIDDEN_MAIN_TYPES: ReadonlySet<string> = new Set(["btw-note"]);

type OverlayRuntime = {
  handle?: OverlayHandle;
  native?: NativeSurface;
  opening?: Promise<void>;
  refresh?: () => void;
  close?: () => void;
  finish?: () => void;
  setDraft?: (value: string) => void;
  closed?: boolean;
};

function isVisibleBtwMessage(message: { role: string; customType?: string }): boolean {
  return message.role === "custom" && message.customType === BTW_MESSAGE_TYPE;
}

function isCustomEntry(entry: unknown, customType: string): entry is { type: "custom"; customType: string; data?: unknown } {
  return !!entry && typeof entry === "object" && (entry as { type?: string }).type === "custom" && (entry as { customType?: string }).customType === customType;
}

function stripDynamicSystemPromptFooter(systemPrompt: string): string {
  return systemPrompt
    .replace(/\nCurrent date and time:[^\n]*(?:\nCurrent working directory:[^\n]*)?$/u, "")
    .replace(/\nCurrent working directory:[^\n]*$/u, "")
    .trim();
}

function createBtwResourceLoader(
  ctx: ExtensionCommandContext,
  tools: readonly string[] | (() => readonly string[]),
  appendSystemPrompt: string[] = [BTW_SYSTEM_PROMPT],
  extensionResources?: ResourceLoader,
): ResourceLoader {
  const extensionsResult = extensionResources?.getExtensions() ?? { extensions: [], errors: [], runtime: createExtensionRuntime() };
  const systemPrompt = stripDynamicSystemPromptFooter(ctx.getSystemPrompt());
  // Preserve the parent's project/custom instructions, but override capability
  // claims in its rendered prompt and in the history seeded into this child.
  const capabilities = () => {
    const availableTools = typeof tools === "function" ? tools() : tools;
    return [
      "<btw_capabilities>",
      availableTools.length > 0
        ? `Available tools in this BTW session: ${availableTools.join(", ")}.`
        : "No tools are available in this BTW session.",
      "This capability list is authoritative for this child session.",
      "Tool and skill instructions inherited from the main session may describe tools that are unavailable here.",
      "Previous tool calls in inherited conversation are historical context, not available capabilities.",
      "Only call tools listed above; do not infer additional tools from the main session.",
      "</btw_capabilities>",
    ].join("\n");
  };

  const resourceLoader: ResourceLoader = {
    getExtensions: () => extensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [...appendSystemPrompt, capabilities()],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async (_options) => {},
  };

  return resourceLoader;
}

async function createBtwModelRuntimeOptions(
  ctx: ExtensionCommandContext,
  model: SessionModel,
): Promise<Pick<CreateAgentSessionOptions, "modelRuntime">> {
  const nativeProvider = ctx.modelRegistry.getRegisteredNativeProvider(model.provider);
  const providerConfig = ctx.modelRegistry.getRegisteredProviderConfig(model.provider);
  const hasRuntimeApiKey = ctx.modelRegistry.getProviderAuthStatus(model.provider).source === "runtime";

  if (!nativeProvider && !providerConfig && !hasRuntimeApiKey) {
    return {};
  }

  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
  if (nativeProvider) {
    modelRuntime.registerNativeProvider(nativeProvider);
  } else if (providerConfig) {
    modelRuntime.registerProvider(model.provider, providerConfig);
  }
  await modelRuntime.refresh({ allowNetwork: false });

  // --api-key is stored only in the parent runtime.
  if (hasRuntimeApiKey) {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (auth.ok && auth.apiKey) {
      await modelRuntime.setRuntimeApiKey(model.provider, auth.apiKey);
    }
  }

  return { modelRuntime };
}

function hasResolvedAuthValues(values?: Record<string, string | null | undefined>): boolean {
  return !!values && Object.values(values).some((value) => typeof value === "string" && value.length > 0);
}

function hasUsableModelAuth(
  ctx: ExtensionCommandContext,
  model: SessionModel,
  auth: Awaited<ReturnType<ExtensionCommandContext["modelRegistry"]["getApiKeyAndHeaders"]>>,
): boolean {
  if (!auth.ok) {
    return false;
  }

  return (
    !!auth.apiKey ||
    hasResolvedAuthValues(auth.headers) ||
    hasResolvedAuthValues(auth.env) ||
    ctx.modelRegistry.hasConfiguredAuth(model)
  );
}

function extractText(parts: AssistantMessage["content"], type: "text" | "thinking"): string {
  const chunks: string[] = [];

  for (const part of parts) {
    if (type === "text" && part.type === "text") {
      chunks.push(part.text);
    } else if (type === "thinking" && part.type === "thinking") {
      chunks.push(part.thinking);
    }
  }

  return chunks.join("\n").trim();
}

function extractAnswer(message: AssistantMessage): string {
  return extractText(message.content, "text") || "(No text response)";
}

function extractThinking(message: AssistantMessage): string {
  return extractText(message.content, "thinking");
}

function parseBtwArgs(args: string): ParsedBtwArgs {
  const save = /(?:^|\s)(?:--save|-s)(?=\s|$)/.test(args);
  const question = args.replace(/(?:^|\s)(?:--save|-s)(?=\s|$)/g, " ").trim();
  return { question, save };
}

function parseBtwModelArgs(args: string):
  | { action: "show" }
  | { action: "clear" }
  | { action: "set"; model: BtwModelRef }
  | { action: "invalid"; message: string } {
  const trimmed = args.trim();
  if (!trimmed) {
    return { action: "show" };
  }

  if (trimmed === "clear") {
    return { action: "clear" };
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 3) {
    return { action: "invalid", message: "Usage: /btw:model <provider> <model> <api> | clear" };
  }

  const [provider, id, api] = parts;
  return { action: "set", model: { provider, id, api } as BtwModelRef };
}

function parseBtwThinkingArgs(args: string):
  | { action: "show" }
  | { action: "clear" }
  | { action: "set"; thinkingLevel: SessionThinkingLevel } {
  const trimmed = args.trim();
  if (!trimmed) {
    return { action: "show" };
  }

  if (trimmed === "clear") {
    return { action: "clear" };
  }

  return { action: "set", thinkingLevel: trimmed as SessionThinkingLevel };
}

function formatModelRef(model: Pick<SessionModel, "provider" | "id" | "api">): string {
  return `${model.provider}/${model.id} (${model.api})`;
}

/**
 * Tool surfaces keyed by BTW mode. Read-only mode exposes only pi's built-in
 * read-only tools so the child session cannot mutate the workspace; every other
 * mode matches pi's default coding-agent toolset (read/bash/edit/write).
 */
const BTW_TOOLS_BY_MODE: Record<BtwThreadMode, readonly string[]> = {
  contextual: ["read", "bash", "edit", "write"],
  tangent: ["read", "bash", "edit", "write"],
  readonly: ["read", "grep", "find", "ls"],
};

/**
 * The user's settings for the BTW child, auto-compaction included. The lean start keeps a new
 * thread far below the threshold, so compaction only runs once the BTW thread itself grows long.
 */
export function createBtwSettingsManager(cwd: string, agentDir: string): SettingsManager {
  return SettingsManager.create(cwd, agentDir);
}

function createSyntheticAssistantMessage(text: string, sessionModel: SessionModel | null): Message {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    provider: sessionModel?.provider ?? "unknown",
    model: sessionModel?.id ?? "unknown",
    api: sessionModel?.api ?? "openai-responses",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } as Message;
}

function getMainLeafId(ctx: ExtensionCommandContext): string | null {
  try {
    return ctx.sessionManager.getLeafId() ?? null;
  } catch {
    return null;
  }
}

function isMainIdle(ctx: ExtensionCommandContext): boolean {
  try {
    return ctx.isIdle();
  } catch {
    return true;
  }
}

/** `snapshot` settings from `<agentDir>/btw.json`; missing or invalid file means defaults. */
function readBtwSnapshotConfig(agentDir: string): { share?: unknown; maxTokens?: unknown } {
  try {
    const parsed = JSON.parse(readFileSync(path.join(agentDir, "btw.json"), "utf8")) as { snapshot?: unknown };
    return parsed?.snapshot && typeof parsed.snapshot === "object" ? (parsed.snapshot as { share?: unknown; maxTokens?: unknown }) : {};
  } catch {
    return {};
  }
}

/** Snapshot budget for the BTW model: its window minus Pi's compaction reserve and the fixed prompt. */
function getSnapshotBudgetTokens(ctx: ExtensionCommandContext, sessionModel: SessionModel | null): number {
  const agentDir = getAgentDir();
  let reserveTokens = 16384;
  try {
    if (sessionModel) reserveTokens = createBtwSettingsManager(ctx.cwd, agentDir).getCompactionReserveTokens(sessionModel);
  } catch {}
  let systemPrompt = "";
  try {
    systemPrompt = ctx.getSystemPrompt();
  } catch {}
  return computeSnapshotBudgetTokens({
    contextWindow: sessionModel?.contextWindow,
    reserveTokens,
    fixedTokens: estimateTextTokens(systemPrompt) + estimateTextTokens(BTW_SYSTEM_PROMPT) + BTW_TOOL_SCHEMA_TOKENS,
    // Default ceiling: the main session's own context window, so BTW can see as much as the main model.
    maxTokens: ctx.model?.contextWindow,
    ...snapshotBudgetSettings(readBtwSnapshotConfig(agentDir)),
  });
}

/**
 * Seed for one BTW question: the latest main-session snapshot (contextual/readonly) or nothing
 * (tangent). Earlier BTW exchanges stay in the pane and handoffs, never in the model input.
 */
function buildBtwSeedState(
  ctx: ExtensionCommandContext,
  mode: BtwThreadMode,
  sessionModel: SessionModel | null,
  earlier: ReadonlyArray<{ question: string; answer: string }> = [],
  restartReason?: string,
): Message[] {
  const messages: Message[] = [];
  // A restarted conversation keeps its earlier exchanges (summarized to fit) so follow-ups still connect.
  const totalBudget = getSnapshotBudgetTokens(ctx, sessionModel);
  const earlierText = earlier.length > 0
    ? buildEarlierDiscussion(earlier, { budgetTokens: Math.max(500, Math.floor(totalBudget * BTW_EARLIER_DISCUSSION_SHARE)), reason: restartReason })
    : null;
  const snapshotBudget = earlierText ? Math.max(500, totalBudget - estimateTextTokens(earlierText)) : totalBudget;

  if (mode === "contextual" || mode === "readonly") {
    let mainMessages: Message[];
    try {
      mainMessages = (buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages as Message[]).filter(
        (message) => !isVisibleBtwMessage(message),
      );
    } catch {
      mainMessages = ctx.sessionManager.getEntries().flatMap((entry) => {
        if (!entry || typeof entry !== "object") {
          return [];
        }

        const message = entry as unknown as Partial<Message> & { role?: string; customType?: string; content?: unknown };
        if (typeof message.role !== "string" || !Array.isArray(message.content)) {
          return [];
        }

        return isVisibleBtwMessage({ role: message.role, customType: message.customType }) ? [] : [message as Message];
      });
    }

    if (useFullMainContext()) {
      messages.push(...mainMessages);
    } else {
      // Budgeted snapshot: status, current task and progress, earlier rounds, the existing summary.
      const snapshot = buildMainSessionSnapshot(mainMessages, {
        sessionFile: ctx.sessionManager.getSessionFile?.(),
        mainRunning: !isMainIdle(ctx),
        budgetTokens: snapshotBudget,
      });
      if (snapshot) {
        messages.push(
          { role: "user", content: [{ type: "text", text: snapshot.text }], timestamp: Date.now() },
          createSyntheticAssistantMessage(BTW_SNAPSHOT_ACK_TEXT, sessionModel),
        );
      }
    }
  }
  if (earlierText) {
    messages.push(
      { role: "user", content: [{ type: "text", text: earlierText }], timestamp: Date.now() },
      createSyntheticAssistantMessage(BTW_EARLIER_ACK_TEXT, sessionModel),
    );
  }

  return messages;
}

/** `snapshot.auto` in `<agentDir>/btw.json`: append main-session updates before every question. */
function readBtwAutosnap(agentDir: string = getAgentDir()): boolean {
  const config = readBtwSnapshotConfig(agentDir) as { auto?: unknown };
  return config.auto === true;
}

/** In-memory copy, re-read on session start/reload, so header refreshes do not touch the disk. */
let btwAutosnapCache: boolean | null = null;
function isBtwAutosnap(): boolean {
  btwAutosnapCache ??= readBtwAutosnap();
  return btwAutosnapCache;
}

function writeBtwAutosnap(enabled: boolean, agentDir: string = getAgentDir()): void {
  const file = path.join(agentDir, "btw.json");
  let config: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) config = parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Cannot update ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const snapshot = config.snapshot && typeof config.snapshot === "object" && !Array.isArray(config.snapshot) ? { ...(config.snapshot as object) } : {};
  config.snapshot = { ...snapshot, auto: enabled };
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

function formatClock(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatToolPreview(value: unknown): string {
  if (value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object") {
    const path = (value as { path?: unknown }).path;
    if (typeof path === "string") {
      return path;
    }
  }

  try {
    const preview = JSON.stringify(value);
    if (!preview || preview === "{}") {
      return "";
    }
    return preview.length > 120 ? `${preview.slice(0, 117)}...` : preview;
  } catch {
    return "";
  }
}

function createEmptyTranscriptState(): BtwTranscriptState {
  return {
    entries: [],
    nextEntryId: 1,
    nextTurnId: 1,
    currentTurnId: null,
    lastTurnId: null,
    toolCalls: new Map(),
  };
}

function appendTranscriptEntry<T extends BtwTranscriptEntry>(
  state: BtwTranscriptState,
  entry: Omit<T, "id">,
): T {
  const nextEntry = { ...entry, id: state.nextEntryId++ } as T;
  state.entries.push(nextEntry);
  return nextEntry;
}

function ensureTranscriptTurn(state: BtwTranscriptState): number {
  if (state.currentTurnId !== null) {
    return state.currentTurnId;
  }

  const turnId = state.nextTurnId++;
  state.currentTurnId = turnId;
  state.lastTurnId = turnId;
  appendTranscriptEntry(state, { type: "turn-boundary", turnId, phase: "start" } as Omit<Extract<BtwTranscriptEntry, { type: "turn-boundary" }>, "id">);
  return turnId;
}

function finishTranscriptTurn(
  state: BtwTranscriptState,
  turnId?: number | null,
  outcome: BtwTurnOutcome = "completed",
): void {
  const resolvedTurnId = turnId ?? state.currentTurnId;
  if (resolvedTurnId === null || resolvedTurnId === undefined) {
    return;
  }

  const endBoundary = state.entries.find(
    (entry): entry is Extract<BtwTranscriptEntry, { type: "turn-boundary" }> =>
      entry.turnId === resolvedTurnId && entry.type === "turn-boundary" && entry.phase === "end",
  );
  if (endBoundary) {
    endBoundary.outcome = outcome;
  } else {
    appendTranscriptEntry(state, {
      type: "turn-boundary",
      turnId: resolvedTurnId,
      phase: "end",
      outcome,
    } as Omit<Extract<BtwTranscriptEntry, { type: "turn-boundary" }>, "id">);
  }

  for (const entry of state.entries) {
    if (entry.turnId !== resolvedTurnId) {
      continue;
    }

    if (entry.type === "thinking" || entry.type === "assistant-text" || entry.type === "tool-result") {
      entry.streaming = false;
    }
  }

  state.lastTurnId = resolvedTurnId;
  if (state.currentTurnId === resolvedTurnId) {
    state.currentTurnId = null;
  }
}

function findLatestTranscriptEntry<TType extends BtwTranscriptEntry["type"]>(
  state: BtwTranscriptState,
  turnId: number,
  type: TType,
): Extract<BtwTranscriptEntry, { type: TType }> | undefined {
  for (let i = state.entries.length - 1; i >= 0; i--) {
    const entry = state.entries[i];
    if (entry.turnId === turnId && entry.type === type) {
      return entry as Extract<BtwTranscriptEntry, { type: TType }>;
    }
  }

  return undefined;
}

function ensureTranscriptTurnForUserMessage(state: BtwTranscriptState): number {
  if (state.currentTurnId !== null) {
    const currentAssistant = findLatestTranscriptEntry(state, state.currentTurnId, "assistant-text");
    if (currentAssistant && !currentAssistant.streaming) {
      finishTranscriptTurn(state, state.currentTurnId);
    }
  }

  return ensureTranscriptTurn(state);
}

function extractMessageText(message: { content?: string | AssistantMessage["content"] | UserMessage["content"] }): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function upsertUserMessageEntry(state: BtwTranscriptState, turnId: number, text: string): void {
  if (!text) {
    return;
  }

  const existing = findLatestTranscriptEntry(state, turnId, "user-message");
  if (existing) {
    existing.text = text;
    return;
  }

  appendTranscriptEntry(state, { type: "user-message", turnId, text } as Omit<Extract<BtwTranscriptEntry, { type: "user-message" }>, "id">);
}

function upsertTranscriptTextEntry(
  state: BtwTranscriptState,
  turnId: number,
  type: "thinking" | "assistant-text",
  text: string,
  streaming: boolean,
): void {
  if (!text) {
    return;
  }

  const existing = findLatestTranscriptEntry(state, turnId, type);
  if (existing) {
    existing.text = text;
    existing.streaming = streaming;
    return;
  }

  appendTranscriptEntry(state, { type, turnId, text, streaming } as Omit<Extract<BtwTranscriptEntry, { type: "thinking" | "assistant-text" }>, "id">);
}

function summarizeToolResult(value: unknown, maxLength = 400): { content: string; truncated: boolean } {
  let content = "";

  if (value && typeof value === "object") {
    const toolValue = value as {
      content?: Array<{ type?: string; text?: string }>;
      error?: unknown;
      message?: unknown;
    };

    if (Array.isArray(toolValue.content)) {
      content = toolValue.content
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text ?? "")
        .join("\n")
        .trim();
    }

    if (!content && typeof toolValue.error === "string") {
      content = toolValue.error;
    }

    if (!content && typeof toolValue.message === "string") {
      content = toolValue.message;
    }
  }

  if (!content) {
    if (typeof value === "string") {
      content = value;
    } else if (value !== undefined) {
      try {
        content = JSON.stringify(value, null, 2);
      } catch {
        content = String(value);
      }
    }
  }

  if (!content) {
    content = "(no tool output)";
  }

  const truncated = content.length > maxLength;
  return {
    content: truncated ? `${content.slice(0, maxLength - 3)}...` : content,
    truncated,
  };
}

function ensureToolCallEntry(
  state: BtwTranscriptState,
  turnId: number,
  toolCallId: string,
  toolName: string,
  args: string,
): { turnId: number; callEntryId: number; resultEntryId?: number } {
  const existing = state.toolCalls.get(toolCallId);
  if (existing) {
    return existing;
  }

  const callEntry = appendTranscriptEntry(state, {
    type: "tool-call",
    turnId,
    toolCallId,
    toolName,
    args,
  } as Omit<Extract<BtwTranscriptEntry, { type: "tool-call" }>, "id">);
  const record = { turnId, callEntryId: callEntry.id };
  state.toolCalls.set(toolCallId, record);
  return record;
}

function upsertToolResultEntry(
  state: BtwTranscriptState,
  turnId: number,
  toolCallId: string,
  toolName: string,
  content: string,
  truncated: boolean,
  isError: boolean,
  streaming: boolean,
): void {
  const toolCall = ensureToolCallEntry(state, turnId, toolCallId, toolName, "");
  const existing =
    toolCall.resultEntryId !== undefined
      ? state.entries.find((entry) => entry.id === toolCall.resultEntryId && entry.type === "tool-result")
      : undefined;

  if (existing && existing.type === "tool-result") {
    existing.content = content;
    existing.truncated = truncated;
    existing.isError = isError;
    existing.streaming = streaming;
    return;
  }

  const resultEntry = appendTranscriptEntry(state, {
    type: "tool-result",
    turnId,
    toolCallId,
    toolName,
    content,
    truncated,
    isError,
    streaming,
  } as Omit<Extract<BtwTranscriptEntry, { type: "tool-result" }>, "id">);
  toolCall.resultEntryId = resultEntry.id;
}

function applyAssistantMessageToTranscript(
  state: BtwTranscriptState,
  turnId: number,
  message: AssistantMessage,
  streaming: boolean,
): void {
  const assistantMessage = message;
  const thinking = extractThinking(assistantMessage);
  const answer = extractMessageText(assistantMessage);

  if (thinking) {
    upsertTranscriptTextEntry(state, turnId, "thinking", thinking, streaming);
  }

  if (answer) {
    upsertTranscriptTextEntry(state, turnId, "assistant-text", answer, streaming);
  }
}

/** The pane shows the question; an appended main-session update collapses to one line. */
export function displayBtwPrompt(text: string): string {
  const match = text.match(/^<main-session-update [^>]*rounds="(\d+)"[^>]*>[\s\S]*?<\/main-session-update>\n\n/);
  if (!match) return text;
  return `↻ main session synced\n${text.slice(match[0].length)}`;
}

function applyTranscriptEvent(state: BtwTranscriptState, event: AgentSessionEvent): void {
  switch (event.type) {
    case "turn_start": {
      ensureTranscriptTurn(state);
      return;
    }
    case "message_start": {
      if (event.message.role === "user") {
        const turnId = ensureTranscriptTurnForUserMessage(state);
        upsertUserMessageEntry(state, turnId, displayBtwPrompt(extractMessageText(event.message)));
        return;
      }

      if (event.message.role === "assistant") {
        const turnId = ensureTranscriptTurn(state);
        applyAssistantMessageToTranscript(state, turnId, event.message, true);
      }
      return;
    }
    case "message_update": {
      if (event.message.role !== "assistant") {
        return;
      }

      const turnId = ensureTranscriptTurn(state);
      applyAssistantMessageToTranscript(state, turnId, event.message, true);
      return;
    }
    case "message_end": {
      if (event.message.role === "user") {
        const turnId = ensureTranscriptTurnForUserMessage(state);
        upsertUserMessageEntry(state, turnId, displayBtwPrompt(extractMessageText(event.message)));
        return;
      }

      if (event.message.role === "assistant") {
        const turnId = ensureTranscriptTurn(state);
        applyAssistantMessageToTranscript(state, turnId, event.message, false);
      }
      return;
    }
    case "tool_execution_start": {
      const turnId = ensureTranscriptTurn(state);
      ensureToolCallEntry(state, turnId, event.toolCallId, event.toolName, formatToolPreview(event.args));
      return;
    }
    case "tool_execution_update": {
      const turnId = state.toolCalls.get(event.toolCallId)?.turnId ?? ensureTranscriptTurn(state);
      const result = summarizeToolResult(event.partialResult);
      upsertToolResultEntry(
        state,
        turnId,
        event.toolCallId,
        event.toolName,
        result.content,
        result.truncated,
        false,
        true,
      );
      return;
    }
    case "tool_execution_end": {
      const turnId = state.toolCalls.get(event.toolCallId)?.turnId ?? ensureTranscriptTurn(state);
      const result = summarizeToolResult(event.result);
      upsertToolResultEntry(
        state,
        turnId,
        event.toolCallId,
        event.toolName,
        result.content,
        result.truncated,
        event.isError,
        false,
      );
      return;
    }
    case "turn_end": {
      const stopReason = event.message.role === "assistant" ? event.message.stopReason : "stop";
      const outcome: BtwTurnOutcome =
        stopReason === "aborted" ? "aborted" : stopReason === "error" ? "failed" : "completed";
      finishTranscriptTurn(state, undefined, outcome);
      return;
    }
    default:
      return;
  }
}

function appendPersistedTranscriptTurn(state: BtwTranscriptState, details: BtwDetails): void {
  const turnId = ensureTranscriptTurn(state);
  upsertUserMessageEntry(state, turnId, details.question);
  if (details.thinking) {
    upsertTranscriptTextEntry(state, turnId, "thinking", details.thinking, false);
  }
  upsertTranscriptTextEntry(state, turnId, "assistant-text", details.answer, false);
  finishTranscriptTurn(state, turnId);
}

function setTranscriptFailure(state: BtwTranscriptState, message: string): void {
  const turnId = state.currentTurnId ?? state.lastTurnId ?? ensureTranscriptTurn(state);
  upsertTranscriptTextEntry(state, turnId, "assistant-text", `❌ ${message}`, false);
  finishTranscriptTurn(state, turnId, "failed");
}

function hasStreamingTranscriptEntry(entries: BtwTranscript): boolean {
  return entries.some(
    (entry) =>
      (entry.type === "thinking" || entry.type === "assistant-text" || entry.type === "tool-result") &&
      entry.streaming,
  );
}

function getCompletedExchangeCount(entries: BtwTranscript): number {
  const completedTurnIds = new Set(
    entries.flatMap((entry) =>
      entry.type === "turn-boundary" &&
      entry.phase === "end" &&
      (entry.outcome === undefined || entry.outcome === "completed")
        ? [entry.turnId]
        : [],
    ),
  );
  return entries.filter(
    (entry) => entry.type === "assistant-text" && !entry.streaming && completedTurnIds.has(entry.turnId),
  ).length;
}

type BtwMarkdownCache = Map<number, { text: string; width: number; thinking: boolean; lines: string[] }>;

function buildOverlayTranscript(
  entries: BtwTranscript,
  theme: ExtensionContext["ui"]["theme"],
  markdownTheme: MarkdownTheme,
  contentWidth: number,
  markdownCache: BtwMarkdownCache,
): string[] {
  if (entries.length === 0) {
    return [theme.fg("dim", "No BTW thread yet. Ask a side question to start one.")];
  }

  const lines: string[] = [];
  const userBadge = buildTranscriptBadge(theme, "You", "userMessageBg", "accent");
  const thinkingBadge = buildTranscriptBadge(theme, "Thinking", "toolPendingBg", "warning");
  const toolBadge = buildTranscriptBadge(theme, "Tool", "toolPendingBg", "warning");
  const assistantBadge = buildTranscriptBadge(theme, "Assistant", "customMessageBg", "success");
  const separator = theme.fg("borderMuted", "────────────────────────────────────────");
  const blockIndent = BTW_BLOCK_INDENT;
  const resultIndent = blockIndent;

  const pushBlankLine = () => {
    if (lines.length > 0 && lines[lines.length - 1] !== "") {
      lines.push("");
    }
  };

  const pushInlineBlock = (
    header: string,
    text: string,
    options: { blankBefore?: boolean; style?: (value: string) => string } = {},
  ) => {
    const bodyLines = text.split("\n");
    const style = options.style ?? ((value: string) => value);
    if (options.blankBefore !== false) {
      pushBlankLine();
    }

    const firstLine = bodyLines.shift() ?? "";
    lines.push(`${header}${firstLine ? ` ${style(firstLine)}` : ""}`);
    for (const line of bodyLines) {
      lines.push(`${blockIndent}${style(line)}`);
    }
  };

  const pushStackedBlock = (
    header: string,
    text: string,
    options: { blankBefore?: boolean; indent?: string; style?: (value: string) => string } = {},
  ) => {
    const bodyLines = text.split("\n");
    const indent = options.indent ?? blockIndent;
    const style = options.style ?? ((value: string) => value);
    if (options.blankBefore !== false) {
      pushBlankLine();
    }

    lines.push(header);
    for (const line of bodyLines) {
      lines.push(`${indent}${style(line)}`);
    }
  };

  const renderMarkdown = (index: number, text: string, thinking: boolean): string[] => {
    const cached = markdownCache.get(index);
    if (cached?.text === text && cached.width === contentWidth && cached.thinking === thinking) return cached.lines;
    const rendered = new Markdown(text, 0, 0, markdownTheme, thinking ? {
      color: (value: string) => theme.fg("warning", value), italic: true,
    } : undefined).render(Math.max(1, contentWidth)).map((line) => line.replace(/\s+$/u, ""));
    markdownCache.set(index, { text, width: contentWidth, thinking, lines: rendered });
    return rendered;
  };
  for (const index of markdownCache.keys()) if (index >= entries.length) markdownCache.delete(index);
  for (const [index, entry] of entries.entries()) {
    if (entry.type === "turn-boundary") {
      if (entry.phase === "start" && lines.length > 0) {
        pushBlankLine();
        lines.push(separator);
      }
      continue;
    }

    if (entry.type === "user-message") {
      pushInlineBlock(userBadge, entry.text, { blankBefore: false });
      continue;
    }

    if (entry.type === "thinking") {
      const thinkingHeader = entry.streaming ? `${thinkingBadge} ${theme.fg("warning", "▍")}` : thinkingBadge;
      const markdownLines = renderMarkdown(index, entry.text, true);
      pushBlankLine();
      lines.push(thinkingHeader);
      for (const line of markdownLines) {
        lines.push(line ? `${blockIndent}${line}` : "");
      }
      continue;
    }

    if (entry.type === "tool-call") {
      const toolLabel = theme.fg("warning", theme.bold(entry.toolName));
      const argsLabel = entry.args ? theme.fg("dim", ` · ${entry.args}`) : "";
      pushInlineBlock(toolBadge, `${toolLabel}${argsLabel}`);
      continue;
    }

    if (entry.type === "tool-result") {
      const resultHeaderLabel = entry.isError
        ? theme.fg("error", "↳ error")
        : entry.streaming
          ? theme.fg("warning", "↳ streaming result")
          : theme.fg("dim", "↳ result");
      const truncationLabel = entry.truncated ? theme.fg("dim", " (truncated)") : "";
      pushStackedBlock(`${resultHeaderLabel}${truncationLabel}`, entry.content, {
        blankBefore: false,
        indent: resultIndent,
        style: (line) => (entry.isError ? theme.fg("error", line) : theme.fg("dim", line)),
      });
      continue;
    }

    if (entry.type === "assistant-text") {
      const assistantHeader = entry.streaming ? `${assistantBadge} ${theme.fg("warning", "▍")}` : assistantBadge;
      const markdownLines = renderMarkdown(index, entry.text, false);
      pushBlankLine();
      lines.push(assistantHeader);
      for (const line of markdownLines) {
        lines.push(line ? `${blockIndent}${line}` : "");
      }
    }
  }

  return lines;
}

function getLastAssistantMessage(session: AgentSession): AssistantMessage | null {
  for (let i = session.state.messages.length - 1; i >= 0; i--) {
    const message = session.state.messages[i];
    if (message.role === "assistant") {
      return message as AssistantMessage;
    }
  }

  return null;
}

type BtwHandoffExchange = {
  user: string;
  assistant: string;
};

function buildBtwMessageContent(question: string, answer: string): string {
  return `**Question**\n\n${question}\n\n**Answer**\n\n${answer}`;
}

function formatThread(thread: BtwHandoffExchange[]): string {
  return thread.map((entry) => `User: ${entry.user.trim()}\nAssistant: ${entry.assistant.trim()}`).join("\n\n---\n\n");
}

function saveVisibleBtwNote(
  pi: ExtensionAPI,
  details: BtwDetails,
  saveRequested: boolean,
  wasBusy: boolean,
): SaveState {
  if (!saveRequested) {
    return "not-saved";
  }

  const message = {
    customType: BTW_MESSAGE_TYPE,
    content: buildBtwMessageContent(details.question, details.answer),
    display: true,
    details,
  };

  if (wasBusy) {
    pi.sendMessage(message, { deliverAs: "followUp" });
    return "queued";
  }

  pi.sendMessage(message);
  return "saved";
}

function canRenderBtwOverlay(ctx: ExtensionContext | ExtensionCommandContext): boolean {
  return ctx.hasUI && ctx.mode === "tui";
}

function notifyInlineQuestionRequired(
  ctx: ExtensionCommandContext,
  command: "/btw" | "/btw:tangent" | "/btw:new" | "/btw:ask",
): void {
  notify(ctx, `${command} cannot open its composer outside Pi's TUI. Pass the question inline instead.`, "warning");
}

function notify(ctx: ExtensionContext | ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
  }
}

/**
 * Model-facing handoff text. The wrapper names the source so the main agent can tell a BTW
 * handoff from something the user typed into the main conversation.
 */
export function buildBtwHandoffContent(kind: BtwHandoffKind, body: string, exchanges: number, instructions: string): string {
  const command = kind === "summary" ? "/btw:summarize" : "/btw:inject";
  const what = kind === "summary" ? "a summary of a side conversation (BTW)" : "the transcript of a side conversation (BTW)";
  return [
    `<btw-handoff kind="${kind}" exchanges="${exchanges}" initiated-by="user">`,
    `The user ran ${command} to hand you ${what} they had alongside this session. It was not typed into this conversation; treat it as context the user chose to share.`,
    instructions ? `User instructions for this handoff: ${instructions}` : "Use it as additional context for the current work.",
    "",
    body.trim(),
    "</btw-handoff>",
  ].join("\n");
}

/** The handoff body without the source wrapper (for the main-session card). */
export function extractBtwHandoffBody(content: string): string {
  const start = content.indexOf("\n\n");
  const body = start === -1 ? content : content.slice(start + 2);
  return body.replace(/\n?<\/btw-handoff>\s*$/, "");
}

/** True once the main session has persisted the handoff with this id. */
export function isBtwHandoffInBranch(branch: readonly unknown[], id: string): boolean {
  return branch.some((entry) => {
    const candidate = entry as { type?: string; customType?: string; details?: { id?: string } };
    return candidate?.type === "custom_message" && candidate.customType === BTW_HANDOFF_TYPE && candidate.details?.id === id;
  });
}

/** Lifecycle commands understood by the BTW composer. parseOverlayBtwCommand is derived from this list. */
export const BTW_COMPOSER_COMMANDS = [
  { name: "btw:new", usage: "[question]", description: "fresh thread with main context" },
  { name: "btw:tangent", usage: "[question]", description: "contextless side thread" },
  { name: "btw:ask", usage: "[question]", description: "read-only thread (read/grep/find/ls)" },
  { name: "btw:sync", usage: "", description: "append the main session's latest progress" },
  { name: "btw:autosnap", usage: "[on|off]", description: "sync the main session before every question" },
  { name: "btw:clear", usage: "", description: "clear the thread and close BTW" },
  { name: "btw:inject", usage: "[instructions]", description: "hand the full thread to the main agent" },
  { name: "btw:summarize", usage: "[instructions]", description: "hand a summary to the main agent" },
  { name: "btw:model", usage: "[<provider> <model> <api> | clear]", description: "BTW-only model override" },
  { name: "btw:thinking", usage: "[<level> | clear]", description: "BTW-only thinking override" },
  { name: "btw:ui", usage: "native|internal", description: "switch BTW surface" },
] as const;
export type BtwComposerCommand = (typeof BTW_COMPOSER_COMMANDS)[number];

// Also accept the short form (`/ask`) inside the BTW composer: hints offer it, so Enter must not
// silently send it to the model as a question.
const BTW_COMPOSER_COMMAND_PATTERN = new RegExp(
  `^\\/(?:btw:)?(${BTW_COMPOSER_COMMANDS.map((command) => command.name.slice("btw:".length)).join("|")})(?:\\s+([\\s\\S]*))?$`,
  "i",
);

export function parseComposerCommand(value: string): { name: string; args: string } | null {
  const match = value.trim().match(BTW_COMPOSER_COMMAND_PATTERN);
  return match ? { name: `btw:${match[1].toLowerCase()}`, args: match[2]?.trim() ?? "" } : null;
}

/** `/btw…` text that is not a composer command must never be sent to the model as a question. */
export function isUnknownBtwComposerCommand(value: string): boolean {
  const trimmed = value.trim();
  return /^\/btw(?:\s|:|$)/i.test(trimmed) && !parseComposerCommand(trimmed);
}

export type BtwComposerHint =
  | { kind: "matches"; matches: BtwComposerCommand[] }
  | { kind: "usage"; command: BtwComposerCommand }
  | { kind: "unknown"; token: string }
  | { kind: "none" };

/** Live hint for the composer status line while a `/` command is being typed. */
export function getComposerCommandHint(value: string): BtwComposerHint | null {
  if (!value.startsWith("/")) return null;
  const space = value.search(/\s/);
  const token = (space === -1 ? value : value.slice(0, space)).slice(1).toLowerCase();
  if (space !== -1) {
    const command = BTW_COMPOSER_COMMANDS.find((candidate) => candidate.name === token || candidate.name.slice("btw:".length) === token);
    if (command) return { kind: "usage", command };
    return isUnknownBtwComposerCommand(value) ? { kind: "unknown", token } : { kind: "none" };
  }
  const matches = BTW_COMPOSER_COMMANDS.filter(
    (candidate) => candidate.name.startsWith(token) || candidate.name.slice("btw:".length).startsWith(token),
  );
  if (matches.length > 0) return { kind: "matches", matches };
  return /^btw(?::|$)/.test(token) ? { kind: "unknown", token } : { kind: "none" };
}

/** Minimum typed letters (after `/` or `/btw:`) before Enter runs a unique prefix match. */
const BTW_COMPOSER_PREFIX_RUN_MIN = 2;

/**
 * Enter on a partially typed command (`/summ`). It must never reach the model:
 * a unique prefix of ≥2 letters without arguments runs; anything else asks for Tab.
 */
export function resolveComposerPrefix(value: string):
  | { kind: "run"; name: string; args: string }
  | { kind: "prompt"; message: string }
  | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || parseComposerCommand(trimmed)) return null;
  const space = trimmed.search(/\s/);
  const head = space === -1 ? trimmed : trimmed.slice(0, space);
  const hint = getComposerCommandHint(head);
  if (hint?.kind !== "matches") return null;
  const typed = head.slice(1).toLowerCase().replace(/^btw:?/, "");
  if (hint.matches.length === 1 && space === -1 && typed.length >= BTW_COMPOSER_PREFIX_RUN_MIN) {
    return { kind: "run", name: hint.matches[0].name, args: "" };
  }
  if (hint.matches.length === 1) {
    return { kind: "prompt", message: `Did you mean /${hint.matches[0].name}? Tab completes it; not sent to the model.` };
  }
  const names = hint.matches.map((command) => command.name.slice("btw:".length)).join(" · ");
  return { kind: "prompt", message: `${head} matches ${names} — press Tab to choose; not sent to the model.` };
}

/** Fixed overlay rows outside the transcript viewport (must match render() structure). */
const BTW_OVERLAY_CHROME_LINES = 9;
/** Indent applied to transcript block bodies. */
const BTW_BLOCK_INDENT = "    ";

function getOverlayTitle(mode: BtwThreadMode): string {
  if (mode === "tangent") {
    return "BTW tangent";
  }
  if (mode === "readonly") {
    return "BTW ask · read-only";
  }
  return "BTW";
}

function buildTranscriptBadge(
  theme: ExtensionContext["ui"]["theme"],
  label: string,
  background: "userMessageBg" | "toolPendingBg" | "customMessageBg",
  foreground: "accent" | "warning" | "success",
): string {
  return theme.bg(background, theme.fg(foreground, theme.bold(` ${label} `)));
}

class BtwOverlayComponent extends Container implements Focusable {
  private readonly input: Input;
  private readonly statusText: Text;
  private readonly modeText: Text;
  private readonly summaryText: Text;
  private readonly hintsText: Text;
  private readonly readTranscriptEntries: () => BtwTranscript;
  private readonly getStatus: () => string | null;
  private readonly getMode: () => BtwThreadMode;
  private readonly getWidthMode: () => BtwOverlayWidthMode;
  private readonly onSubmitCallback: (value: string) => void;
  private readonly onDismissCallback: () => void;
  private readonly onUnfocusCallback: () => void;
  private readonly onToggleWidthCallback: () => void;
  private readonly tui: TUI;
  private readonly theme: ExtensionContext["ui"]["theme"];
  private readonly markdownTheme: MarkdownTheme;
  private readonly managesMouseReporting: boolean;
  private transcriptLines: string[] = [];
  private readonly markdownCache: BtwMarkdownCache = new Map();
  private transcriptKey: string | undefined;
  private wrappedCache: { lines: string[]; width: number; wrapped: string[] } | undefined;
  private transcriptScrollOffset = 0;
  private readonly keybindings: KeybindingsManager;
  /** Submitted prompts, most recent first; owned by the extension so it outlives this component. */
  getPromptHistory: () => readonly string[] = () => [];
  /** "main context 14:02 · main +3 rounds since (/btw:sync)" etc. */
  getBaseText: () => string = () => "";
  /** Same model as the main editor: -1 = not browsing, 0 = most recent. */
  private historyIndex = -1;
  private historyDraft: { value: string; cursor: number } | null = null;
  private transcriptViewportHeight = 8;
  private contentWidth = 66;
  private followTranscript = true;
  private _focused = false;
  private modeTextValue = "";
  private summaryTextValue = "";
  private statusTextValue = "";
  private hintsTextValue = "";
  /** Active Tab cycle through several matching composer commands. */
  private completionCycle: { matches: readonly BtwComposerCommand[]; index: number; value: string } | undefined;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  constructor(
    tui: TUI,
    theme: ExtensionContext["ui"]["theme"],
    keybindings: KeybindingsManager,
    readTranscriptEntries: () => BtwTranscript,
    getStatus: () => string | null,
    getMode: () => BtwThreadMode,
    getWidthMode: () => BtwOverlayWidthMode,
    onSubmit: (value: string) => void,
    onDismiss: () => void,
    onUnfocus: () => void,
    onToggleWidth: () => void,
    private readonly getGeometry: () => { height: number; split: boolean },
    private readonly nativeSurface = false,
  ) {
    super();
    this.keybindings = keybindings;
    this.tui = tui;
    this.theme = theme;
    this.markdownTheme = getMarkdownTheme();
    // Fullscreen Pi owns mouse reporting for the entire terminal session. In
    // regular mode BTW manages it while the overlay exists.
    this.managesMouseReporting = tui.mode !== "fullscreen";
    this.readTranscriptEntries = readTranscriptEntries;
    this.getStatus = getStatus;
    this.getMode = getMode;
    this.getWidthMode = getWidthMode;
    this.onSubmitCallback = onSubmit;
    this.onDismissCallback = onDismiss;
    this.onUnfocusCallback = onUnfocus;
    this.onToggleWidthCallback = onToggleWidth;

    this.modeText = new Text("", 1, 0);
    this.summaryText = new Text("", 1, 0);
    this.statusText = new Text("", 1, 0);

    this.input = new Input();
    this.input.onSubmit = (value) => {
      this.exitHistoryBrowsing();
      this.followTranscript = true;
      this.onSubmitCallback(value);
    };
    this.input.onEscape = () => {
      this.onDismissCallback();
    };

    this.hintsText = new Text("", 1, 0);

    if (this.managesMouseReporting) {
      this.tui.terminal?.write?.("\x1b[?1000h\x1b[?1006h");
    }

    const originalHandleInput = this.input.handleInput.bind(this.input);
    this.input.handleInput = (data: string) => {
      if (keybindings.matches(data, "app.clear")) {
        if (this.input.getValue().length > 0) {
          this.input.setValue("");
          this.tui.requestRender();
          return;
        }

        this.onDismissCallback();
        return;
      }

      if (keybindings.matches(data, "tui.select.cancel")) {
        this.onDismissCallback();
        return;
      }
      if (matchesKey(data, Key.tab)) {
        this.completeComposerCommand(originalHandleInput);
        return;
      }
      this.completionCycle = undefined;
      const before = this.input.getValue();
      originalHandleInput(data);
      // Like the main editor: editing a recalled prompt leaves history browsing.
      if (this.historyIndex > -1 && this.input.getValue() !== before) this.exitHistoryBrowsing();
    };

    this.refresh();
  }

  /**
   * Up/Down behave like the main editor (single line): Up recalls older prompts when the
   * input is empty, already browsing, or the cursor is at column 0, otherwise jumps to the
   * line start; Down walks back toward the draft while browsing, otherwise jumps to the end.
   * The dedicated history actions always browse. PgUp/PgDn and the wheel scroll the transcript.
   */
  private handleHistoryKey(data: string): boolean {
    const kb = this.keybindings;
    if (kb.matches(data, "tui.editor.historyPrevious")) { this.navigateHistory(-1); return true; }
    if (kb.matches(data, "tui.editor.historyNext")) { this.navigateHistory(1); return true; }
    if (kb.matches(data, "tui.editor.cursorUp")) {
      if (this.input.getValue() === "" || this.historyIndex > -1 || this.inputCursor === 0) this.navigateHistory(-1);
      else this.setInputCursor(0);
      return true;
    }
    if (kb.matches(data, "tui.editor.cursorDown")) {
      if (this.historyIndex > -1) this.navigateHistory(1);
      else this.setInputCursor(this.input.getValue().length);
      return true;
    }
    return false;
  }

  private navigateHistory(direction: -1 | 1): void {
    const history = this.getPromptHistory();
    if (history.length === 0) return;
    const next = this.historyIndex - direction;
    if (next < -1 || next >= history.length) return;
    if (this.historyIndex === -1 && next >= 0) {
      this.historyDraft = { value: this.input.getValue(), cursor: this.inputCursor };
    }
    this.historyIndex = next;
    if (next === -1) {
      const draft = this.historyDraft ?? { value: "", cursor: 0 };
      this.historyDraft = null;
      this.input.setValue(draft.value);
      this.setInputCursor(draft.cursor);
    } else {
      const text = history[next] ?? "";
      this.input.setValue(text);
      this.setInputCursor(direction === -1 ? 0 : text.length);
    }
    this.completionCycle = undefined;
    this.tui.requestRender();
  }

  private exitHistoryBrowsing(): void {
    this.historyIndex = -1;
    this.historyDraft = null;
  }

  // pi-tui's Input keeps its cursor private; it is a plain UTF-16 index into the value.
  private get inputCursor(): number {
    return (this.input as unknown as { cursor: number }).cursor;
  }

  private setInputCursor(cursor: number): void {
    (this.input as unknown as { cursor: number }).cursor = Math.max(0, Math.min(cursor, this.input.getValue().length));
    this.tui.requestRender();
  }

  private get borderless(): boolean {
    // Full-width mode drops the vertical bars and corner glyphs so a terminal
    // Shift+drag selection captures only the dialog's own text — with side
    // borders, the leftmost/rightmost columns would land inside the drag.
    return this.getWidthMode() === "full";
  }

  private frameLine(content: string, innerWidth: number): string {
    const truncated = truncateToWidth(content, innerWidth, "");
    const padding = Math.max(0, innerWidth - visibleWidth(truncated));
    if (this.borderless) {
      return `${truncated}${" ".repeat(padding)}`;
    }
    return `${this.theme.fg("border", "│")}${truncated}${" ".repeat(padding)}${this.theme.fg("border", "│")}`;
  }

  private ruleLine(innerWidth: number): string {
    if (this.borderless) {
      return this.theme.fg("border", "─".repeat(innerWidth));
    }
    return this.theme.fg("border", `├${"─".repeat(innerWidth)}┤`);
  }

  private borderLine(innerWidth: number, edge: "top" | "bottom"): string {
    if (this.borderless) {
      return this.theme.fg("border", "─".repeat(innerWidth));
    }
    const left = edge === "top" ? "┌" : "└";
    const right = edge === "top" ? "┐" : "┘";
    return this.theme.fg("border", `${left}${"─".repeat(innerWidth)}${right}`);
  }

  private wrapTranscript(innerWidth: number): string[] {
    if (this.wrappedCache?.lines === this.transcriptLines && this.wrappedCache.width === innerWidth) return this.wrappedCache.wrapped;
    const wrapped: string[] = [];
    for (const line of this.transcriptLines) {
      if (!line) {
        wrapped.push("");
        continue;
      }
      wrapped.push(...wrapTextWithAnsi(line, Math.max(1, innerWidth)));
    }
    this.wrappedCache = { lines: this.transcriptLines, width: innerWidth, wrapped };
    return wrapped;
  }

  private getDialogHeight(): number {
    return this.getGeometry().height;
  }

  private scrollTranscript(delta: number): void {
    if (delta < 0) {
      this.followTranscript = false;
    }
    this.transcriptScrollOffset = Math.max(0, this.transcriptScrollOffset + delta);
    this.tui.requestRender();
  }

  dispose(): void {
    if (this.managesMouseReporting) {
      this.tui.terminal?.write?.("\x1b[?1000l\x1b[?1006l");
    }
  }

  private getMouseScrollDelta(data: string): number | null {
    const match = data.match(/^\x1b\[<(\d+);\d+;\d+[Mm]$/);
    if (!match) {
      return null;
    }

    const button = Number(match[1]);
    if ((button & 64) !== 64) {
      return null;
    }

    return (button & 1) === 0 ? -3 : 3;
  }

  override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
    const inputRow = event.height < 4 ? 0 : event.height < BTW_OVERLAY_CHROME_LINES ? 2 : event.height - 3;
    if (this.nativeSurface && (event.type === "press" || event.type === "click") && event.y === inputRow) {
      this.input.handleMouse({ ...event, y: 0, height: 1 });
      this.tui.requestRender();
      return { handled: true, focus: true, target: { component: this, originX: 0, originY: 0, width: event.width, height: event.height } };
    }
    const target = { component: this, originX: event.screenX - event.x,
      originY: event.screenY - event.y, width: event.width, height: event.height };
    if (event.type === "wheel" && event.wheelDelta) {
      this.scrollTranscript(event.wheelDelta);
      return { handled: true, target };
    }
    if (event.type === "press" && event.button === "left" && (event.y === 0 || event.y === event.height - 3)) {
      return { handled: true, focus: true, target };
    }
    return undefined;
  }

  handleInput(data: string): void {
    if (matchesBtwFocusShortcut(data)) {
      this.onUnfocusCallback();
      return;
    }

    if (matchesBtwWidthToggle(data)) {
      this.onToggleWidthCallback();
      return;
    }

    const mouseScrollDelta = this.getMouseScrollDelta(data);
    if (mouseScrollDelta !== null) {
      this.scrollTranscript(mouseScrollDelta);
      return;
    }

    if (matchesKey(data, Key.pageUp)) {
      this.scrollTranscript(-Math.max(1, this.transcriptViewportHeight - 1));
      return;
    }

    if (matchesKey(data, Key.pageDown)) {
      this.scrollTranscript(Math.max(1, this.transcriptViewportHeight - 1));
      return;
    }

    if (this.handleHistoryKey(data)) {
      return;
    }

    this.input.handleInput(data);
  }

  private inputFrameLine(dialogWidth: number): string {
    const borderColumns = this.borderless ? 0 : 2;
    const targetWidth = Math.max(1, dialogWidth - borderColumns);
    const previousFocused = this.input.focused;
    // Input.render() emits CURSOR_MARKER when focused. In overlay mode that APC marker
    // can skew width/composition on this one row before the TUI strips it, producing a
    // right-edge notch and shifted border. Render the embedded input unfocused here so
    // the row stays geometrically stable while the overlay still owns keyboard input.
    this.input.focused = this.nativeSurface && previousFocused;
    try {
      const renderedInputLine = this.input.render(targetWidth)[0] ?? "";
      const inputLine = truncateToWidth(renderedInputLine, targetWidth, "");
      const padding = Math.max(0, targetWidth - visibleWidth(inputLine));
      if (this.borderless) {
        return `${inputLine}${" ".repeat(padding)}`;
      }
      return `${this.theme.fg("border", "│")}${inputLine}${" ".repeat(padding)}${this.theme.fg("border", "│")}`;
    } finally {
      this.input.focused = previousFocused;
    }
  }

  /** Status row: live `/` command hints while composing a command, otherwise the session status. */
  private statusLine(): string {
    const value = this.input.getValue();
    const cycle = this.completionCycle?.value === value ? this.completionCycle : undefined;
    if (cycle) {
      const names = cycle.matches.map((command, index) => {
        const label = command.name.slice("btw:".length);
        return index === cycle.index ? this.theme.bold(`[${label}]`) : label;
      });
      const current = cycle.matches[cycle.index];
      return this.theme.fg("accent", `/${current.name} — ${current.description} · Tab ↹ ${names.join(" · ")}`);
    }
    const hint = getComposerCommandHint(value);
    if (!hint) return this.theme.fg("warning", this.statusTextValue.trim());
    switch (hint.kind) {
      case "matches":
        if (hint.matches.length === 1) {
          const [command] = hint.matches;
          const action = resolveComposerPrefix(value)?.kind === "run" ? "Enter/Tab →" : "Tab →";
          return this.theme.fg("accent", `${action} /${command.name}${command.usage ? ` ${command.usage}` : ""} — ${command.description}`);
        }
        return this.theme.fg("accent", `Tab ↹ /btw: ${hint.matches.map((command) => command.name.slice("btw:".length)).join(" · ")}`);
      case "usage":
        return this.theme.fg("accent", `/${hint.command.name}${hint.command.usage ? ` ${hint.command.usage}` : ""} — ${hint.command.description}`);
      case "unknown":
        return this.theme.fg("error", `Unknown BTW command /${hint.token} — not sent. Type / to list commands.`);
      case "none":
        return this.theme.fg("dim", "No BTW command matches; Enter sends this text as a question.");
    }
  }

  /** Tab: complete a unique command, or cycle through several matches. */
  private completeComposerCommand(insert: (data: string) => void): void {
    const value = this.input.getValue();
    let next: string | undefined;
    if (this.completionCycle?.value === value) {
      const cycle = this.completionCycle;
      cycle.index = (cycle.index + 1) % cycle.matches.length;
      next = `/${cycle.matches[cycle.index].name}`;
      cycle.value = next;
    } else {
      const hint = getComposerCommandHint(value);
      if (hint?.kind !== "matches") return;
      if (hint.matches.length === 1) {
        this.completionCycle = undefined;
        next = `/${hint.matches[0].name} `;
      } else {
        next = `/${hint.matches[0].name}`;
        this.completionCycle = { matches: hint.matches, index: 0, value: next };
      }
    }
    // Re-insert through Input so the cursor lands at the end of the completed text.
    this.input.setValue("");
    insert(next);
    this.tui.requestRender();
  }

  private fitRenderedLine(line: string, width: number): string {
    return visibleWidth(line) > width ? truncateToWidth(line, width, "") : line;
  }

  override render(width: number): string[] {
    const dialogWidth = Math.max(this.nativeSurface ? 1 : 24, width);
    const borderColumns = this.borderless ? 0 : 2;
    const innerWidth = Math.max(this.nativeSurface ? 1 : 22, dialogWidth - borderColumns);
    const contentWidth = Math.max(1, innerWidth - BTW_BLOCK_INDENT.length);
    if (contentWidth !== this.contentWidth) {
      this.contentWidth = contentWidth;
      this.rebuildTranscriptLines();
    }
    const transcriptLines = this.wrapTranscript(innerWidth);
    const dialogHeight = this.getDialogHeight();
    const chromeHeight = BTW_OVERLAY_CHROME_LINES;
    if (dialogHeight < chromeHeight) {
      const compact = dialogHeight < 4
        ? [this.inputFrameLine(dialogWidth), this.frameLine(this.statusLine(), innerWidth)]
        : [this.borderLine(innerWidth, "top"), this.frameLine(this.modeTextValue.trim(), innerWidth),
          this.inputFrameLine(dialogWidth), this.borderLine(innerWidth, "bottom")];
      return compact.slice(0, dialogHeight).map((line) => this.fitRenderedLine(line, width));
    }
    const transcriptHeight = Math.max(0, dialogHeight - chromeHeight);
    this.transcriptViewportHeight = transcriptHeight;

    const maxScroll = Math.max(0, transcriptLines.length - transcriptHeight);
    if (this.followTranscript) {
      this.transcriptScrollOffset = maxScroll;
    } else {
      this.transcriptScrollOffset = Math.max(0, Math.min(this.transcriptScrollOffset, maxScroll));
      if (this.transcriptScrollOffset >= maxScroll) {
        this.followTranscript = true;
      }
    }

    const visibleTranscript = transcriptLines.slice(
      this.transcriptScrollOffset,
      this.transcriptScrollOffset + transcriptHeight,
    );
    const transcriptPadCount = Math.max(0, transcriptHeight - visibleTranscript.length);
    const hiddenAbove = this.transcriptScrollOffset;
    const hiddenBelow = Math.max(0, maxScroll - this.transcriptScrollOffset);
    const summary =
      hiddenAbove || hiddenBelow
        ? `${this.summaryTextValue.trim()} · ↑${hiddenAbove} ↓${hiddenBelow}`
        : this.summaryTextValue.trim();

    const lines = [this.borderLine(innerWidth, "top")];

    lines.push(this.frameLine(this.theme.fg("accent", this.theme.bold(this.modeTextValue.trim())), innerWidth));
    lines.push(this.frameLine(this.theme.fg("dim", summary), innerWidth));
    lines.push(this.ruleLine(innerWidth));

    for (const line of visibleTranscript) {
      lines.push(this.frameLine(line, innerWidth));
    }
    for (let i = 0; i < transcriptPadCount; i++) {
      lines.push(this.frameLine("", innerWidth));
    }

    lines.push(this.ruleLine(innerWidth));
    lines.push(this.frameLine(this.statusLine(), innerWidth));
    lines.push(this.inputFrameLine(dialogWidth));
    lines.push(this.frameLine(this.theme.fg("dim", this.hintsTextValue.trim()), innerWidth));
    lines.push(this.borderLine(innerWidth, "bottom"));

    return lines.map((line) => this.fitRenderedLine(line, width));
  }

  setDraft(value: string): void {
    this.input.setValue(value);
    this.tui.requestRender();
  }

  getDraft(): string {
    return this.input.getValue();
  }

  getTranscriptEntries(): BtwTranscript {
    return this.readTranscriptEntries().map((entry) => ({ ...entry }));
  }

  private rebuildTranscriptLines(): void {
    const entries = this.readTranscriptEntries();
    const key = `${this.contentWidth}:${JSON.stringify(entries)}`;
    if (this.transcriptKey === key) return;
    this.transcriptLines = buildOverlayTranscript(entries, this.theme, this.markdownTheme, this.contentWidth, this.markdownCache);
    this.transcriptKey = key;
    this.wrappedCache = undefined;
  }

  override invalidate(): void {
    super.invalidate();
    this.markdownCache.clear();
    this.transcriptKey = undefined;
    this.wrappedCache = undefined;
    this.rebuildTranscriptLines();
  }

  refresh(): void {
    const base = this.getBaseText();
    this.modeTextValue = `${getOverlayTitle(this.getMode())}${base ? ` · ${base}` : ""}`;
    this.modeText.setText(this.modeTextValue);
    const entries = this.readTranscriptEntries();
    const exchanges = getCompletedExchangeCount(entries);
    const active = hasStreamingTranscriptEntry(entries) ? " · streaming" : " · idle";
    this.summaryTextValue = `${exchanges} exchange${exchanges === 1 ? "" : "s"}${active}`;
    this.summaryText.setText(this.summaryTextValue);

    this.rebuildTranscriptLines();

    const status = this.getStatus() ?? "Ready. Enter submits; Escape dismisses without clearing.";
    this.statusTextValue = status;
    this.statusText.setText(this.statusTextValue);
    this.hintsTextValue = `Wheel/PgUp/PgDn scroll · ↑↓ history · Enter · ${BTW_FOCUS_SHORTCUTS_LABEL} focus · Alt+w ${this.nativeSurface ? "zoom" : "width"} · Esc`;
    this.hintsText.setText(this.hintsTextValue);
    this.tui.requestRender();
  }
}

export default function (pi: ExtensionAPI) {
  let pendingThread: BtwDetails[] = [];
  let pendingMode: BtwThreadMode = "contextual";
  let btwModelOverride: SessionModel | null = null;
  let btwThinkingOverride: SessionThinkingLevel | null = null;
  let transcriptState = createEmptyTranscriptState();
  let overlayStatus: string | null = null;
  let overlayDraft = "";
  /** BTW composer history, most recent first, like the main editor's prompt history. */
  let promptHistory: string[] = [];
  const addPromptHistory = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || promptHistory[0] === trimmed) return;
    promptHistory.unshift(trimmed);
    if (promptHistory.length > 100) promptHistory.pop();
  };
  let overlayWidthMode: BtwOverlayWidthMode = "window";
  let overlayRuntime: OverlayRuntime | null = null;
  const nativeSurfaces = new Set<NativeSurface>();
  let surfaceOverride: "native" | "internal" | undefined;
  let lastUiContext: ExtensionContext | ExtensionCommandContext | null = null;
  let activeBtwSession: BtwSessionRuntime | null = null;
  let btwLifecycleGeneration = 0;
  let btwSubmissionQueue = Promise.resolve();
  let btwSessionCreationQueue = Promise.resolve();
  /**
   * Handoff sent to the main session but not yet seen there. A thread (/btw:inject) handoff keeps
   * the BTW thread until it arrives; a summary is self-contained, so its thread is cleared at once.
   */
  let pendingHandoff: BtwHandoffRecord | null = null;
  /** Handoff that never arrived (turn interrupted / queue cleared); resent without a new model call. */
  let undeliveredHandoff: BtwHandoffRecord | null = null;
  let handoffWatchdog: ReturnType<typeof setInterval> | undefined;
  let handoffIdleTicks = 0;
  const HANDOFF_WATCH_INTERVAL_MS = 500;
  /** Consecutive idle observations (and minimum age) before a pending handoff counts as dropped. */
  const HANDOFF_IDLE_TICKS = 3;
  const HANDOFF_MIN_AGE_MS = 1500;

  function stopHandoffWatch(): void {
    if (handoffWatchdog) clearInterval(handoffWatchdog);
    handoffWatchdog = undefined;
    handoffIdleTicks = 0;
  }

  function clearHandoffState(): void {
    stopHandoffWatch();
    pendingHandoff = null;
    undeliveredHandoff = null;
  }

  /** A thread reset drops handoffs tied to the thread (inject); a sent summary outlives it. */
  function clearThreadHandoffState(): void {
    if (pendingHandoff?.kind === "thread") {
      stopHandoffWatch();
      pendingHandoff = null;
    }
    if (undeliveredHandoff?.kind === "thread") undeliveredHandoff = null;
  }

  /** /btw:clear: forget any in-flight or undelivered handoff, persistently. */
  function discardHandoffs(): void {
    for (const record of [pendingHandoff, undeliveredHandoff]) {
      if (record) pi.appendEntry(BTW_HANDOFF_DISCARDED_TYPE, { id: record.id, timestamp: Date.now() });
    }
    clearHandoffState();
  }

  function handoffLabel(record: BtwHandoffDetails): string {
    return `BTW ${record.kind === "summary" ? "summary" : "thread"} (${record.exchanges} exchange${record.exchanges === 1 ? "" : "s"})`;
  }

  function handoffCommand(kind: BtwHandoffKind): string {
    return kind === "summary" ? "/btw:summarize" : "/btw:inject";
  }

  function createHandoffRecord(kind: BtwHandoffKind, body: string, exchanges: number, instructions: string): BtwHandoffRecord {
    return {
      id: randomUUID(), kind, exchanges, instructions, createdAt: Date.now(),
      content: buildBtwHandoffContent(kind, body, exchanges, instructions),
      threadLength: pendingThread.length,
      ...(kind === "summary" ? { threadCleared: true } : {}),
    };
  }

  /**
   * Cached content to resend. A summary is resent whatever the current thread holds (it was
   * cleared when the summary was made); new instructions re-wrap the same summary body.
   * A thread handoff is reused only for the same instructions and an unchanged thread.
   */
  function reusableHandoff(kind: BtwHandoffKind, instructions: string): BtwHandoffRecord | null {
    const cached = undeliveredHandoff;
    if (!cached || cached.kind !== kind) return null;
    if (kind === "summary") {
      const nextInstructions = instructions || cached.instructions;
      const content = nextInstructions === cached.instructions
        ? cached.content
        : buildBtwHandoffContent("summary", extractBtwHandoffBody(cached.content), cached.exchanges, nextInstructions);
      return { ...cached, instructions: nextInstructions, content, id: randomUUID(), createdAt: Date.now() };
    }
    if (cached.instructions !== instructions || cached.threadLength !== pendingThread.length) return null;
    return { ...cached, id: randomUUID(), createdAt: Date.now() };
  }

  /** Message for blocked BTW questions while a thread handoff is in flight, or null. */
  function pendingHandoffBlock(): string | null {
    return pendingHandoff?.kind === "thread"
      ? `${handoffLabel(pendingHandoff)} is on its way to the main session; new BTW questions wait until it arrives (/btw:clear drops the thread).`
      : null;
  }

  function sendHandoffToMain(ctx: ExtensionCommandContext, record: BtwHandoffRecord): void {
    const busy = !ctx.isIdle();
    pendingHandoff = record;
    undeliveredHandoff = null;
    pi.appendEntry(BTW_HANDOFF_PENDING_TYPE, record);
    const details: BtwHandoffDetails = {
      id: record.id, kind: record.kind, exchanges: record.exchanges, instructions: record.instructions, createdAt: record.createdAt,
    };
    // Busy: steer, so the main agent sees it at its next step instead of after every interjection.
    pi.sendMessage(
      { customType: BTW_HANDOFF_TYPE, content: record.content, display: true, details },
      busy ? { triggerTurn: true, deliverAs: "steer" } : { triggerTurn: true },
    );
    startHandoffWatch(ctx);
    setOverlayStatus(`${handoffLabel(record)} sent; waiting for the main session to receive it.`, ctx);
    if (busy) notify(ctx, `${handoffLabel(record)} queued; the main agent sees it at its next step.`, "info");
  }

  function startHandoffWatch(ctx: ExtensionContext | ExtensionCommandContext): void {
    stopHandoffWatch();
    handoffWatchdog = setInterval(() => {
      void checkPendingHandoff(ctx).catch(() => {});
    }, HANDOFF_WATCH_INTERVAL_MS);
    handoffWatchdog.unref?.();
  }

  async function markHandoffDelivered(ctx: ExtensionContext | ExtensionCommandContext, record: BtwHandoffRecord): Promise<void> {
    if (pendingHandoff !== record && undeliveredHandoff !== record) return;
    stopHandoffWatch();
    pendingHandoff = null;
    undeliveredHandoff = null;
    if (record.kind === "thread") {
      await resetThread(ctx);
    } else {
      // The summary's thread was cleared when it was sent; questions asked since then stay.
      if (overlayStatus?.startsWith(handoffLabel(record))) setOverlayStatus(null, ctx);
    }
    notify(ctx, `Handed ${handoffLabel(record)} to the main session.`, "info");
  }

  function markHandoffUndelivered(ctx: ExtensionContext | ExtensionCommandContext, record: BtwHandoffRecord): void {
    if (pendingHandoff !== record) return;
    stopHandoffWatch();
    pendingHandoff = null;
    undeliveredHandoff = record;
    const command = handoffCommand(record.kind);
    const reason = "did not reach the main session (its turn was interrupted or the queue was cleared).";
    if (record.kind === "summary") {
      setOverlayStatus(`${handoffLabel(record)} was not delivered; ${command} resends the saved summary.`, ctx);
      notify(ctx, `${handoffLabel(record)} ${reason} The summary is saved; run ${command} to resend it (no new model call).`, "warning");
      return;
    }
    setOverlayStatus(`${handoffLabel(record)} was not delivered; thread kept. ${command} resends it.`, ctx);
    notify(ctx, `${handoffLabel(record)} ${reason} The BTW thread is kept; run ${command} again to resend.`, "warning");
  }

  /** Delivered once persisted in the main branch; dropped once the main session stays idle without it. */
  async function checkPendingHandoff(ctx: ExtensionContext | ExtensionCommandContext): Promise<void> {
    const record = pendingHandoff;
    if (!record) return;
    if (isBtwHandoffInBranch(ctx.sessionManager.getBranch(), record.id)) {
      await markHandoffDelivered(ctx, record);
      return;
    }
    handoffIdleTicks = ctx.isIdle() ? handoffIdleTicks + 1 : 0;
    if (handoffIdleTicks >= HANDOFF_IDLE_TICKS && Date.now() - record.createdAt >= HANDOFF_MIN_AGE_MS) {
      markHandoffUndelivered(ctx, record);
    }
  }

  function invalidateBtwLifecycle(): void {
    btwLifecycleGeneration += 1;
  }

  function syncUi(ctx?: ExtensionContext | ExtensionCommandContext): void {
    const activeCtx = ctx ?? lastUiContext;
    if (activeCtx?.hasUI) {
      // Native frames must not invalidate/repaint the parent terminal on each token.
      if (!overlayRuntime?.native) activeCtx.ui.setWidget("btw", undefined);
      overlayRuntime?.refresh?.();
    }
  }

  function setOverlayStatus(status: string | null, ctx?: ExtensionContext | ExtensionCommandContext): void {
    overlayStatus = status;
    syncUi(ctx);
  }

  function setOverlayDraft(value: string): void {
    overlayDraft = value;
    overlayRuntime?.setDraft?.(value);
  }

  function dismissOverlay(): void {
    overlayRuntime?.close?.();
    overlayRuntime = null;
  }

  function toggleOverlayFocus(): void {
    if (overlayRuntime?.native) {
      void overlayRuntime.native.pane.toggleFocus().catch((error) => lastUiContext && notify(lastUiContext, String(error), "error"));
      return;
    }
    const handle = overlayRuntime?.handle;
    if (!handle) {
      return;
    }

    handle.setHidden(false);
    if (handle.isFocused()) {
      handle.unfocus();
    } else {
      handle.focus();
    }
    overlayRuntime?.refresh?.();
  }

  function focusOverlay(): void {
    if (overlayRuntime?.native) {
      void overlayRuntime.native.pane.focus().catch((error) => lastUiContext && notify(lastUiContext, String(error), "error"));
      return;
    }
    const handle = overlayRuntime?.handle;
    if (!handle) {
      return;
    }

    handle.setHidden(false);
    handle.focus();
    overlayRuntime?.refresh?.();
  }


  async function toggleOverlayWidth(ctx: ExtensionContext | ExtensionCommandContext): Promise<void> {
    if (overlayRuntime?.native) {
      await overlayRuntime.native.pane.zoom().catch((error) => notify(ctx, String(error), "error"));
      return;
    }
    const nextMode = overlayWidthMode === "window" ? "full" : "window";

    // overlayOptions is resolved once at showOverlay time, so a width change
    // requires tearing down and re-opening the overlay. The close path persists
    // the draft into overlayDraft, and ensureOverlay restores it on reopen.
    const wasFocused = overlayRuntime?.handle?.isFocused() ?? true;
    dismissOverlay();
    overlayWidthMode = nextMode;
    await ensureOverlay(ctx);
    if (!wasFocused) {
      overlayRuntime?.handle?.unfocus();
      overlayRuntime?.refresh?.();
    }
    setOverlayStatus(
      overlayWidthMode === "full"
        ? "Full-width mode. Alt+w returns to the sidebar (window on narrow terminals)."
        : "Sidebar mode (fullscreen, ≥120 columns); window fallback on small terminals. Alt+w for full-width.",
      ctx,
    );
  }

  function removeBtwSessionSubscription(sessionRuntime: BtwSessionRuntime, unsubscribe: () => void): void {
    if (!sessionRuntime.subscriptions.delete(unsubscribe)) {
      return;
    }

    try {
      unsubscribe();
    } catch {
      // Ignore unsubscribe errors during BTW session replacement/shutdown.
    }
  }

  function clearBtwSessionSubscriptions(sessionRuntime: BtwSessionRuntime): void {
    for (const unsubscribe of [...sessionRuntime.subscriptions]) {
      removeBtwSessionSubscription(sessionRuntime, unsubscribe);
    }
  }

  function handleBtwSessionEvent(
    sessionRuntime: BtwSessionRuntime,
    event: AgentSessionEvent,
    ctx?: ExtensionContext | ExtensionCommandContext,
  ): void {
    if (activeBtwSession?.session !== sessionRuntime.session || !overlayRuntime) {
      return;
    }

    applyTranscriptEvent(transcriptState, event);

    if (event.type === "tool_execution_start") {
      setOverlayStatus(`⏳ running tool: ${event.toolName}`, ctx);
      return;
    }

    if (event.type === "tool_execution_end") {
      setOverlayStatus(sessionRuntime.session.isStreaming ? `⏳ running tool: ${event.toolName}` : "⏳ streaming...", ctx);
      return;
    }

    if (event.type === "turn_end") {
      setOverlayStatus("⏳ streaming...", ctx);
      return;
    }

    if (event.type === "compaction_start") {
      setOverlayStatus("⏳ compacting the BTW thread...", ctx);
      return;
    }

    if (event.type === "compaction_end") {
      setOverlayStatus(event.errorMessage ? `⚠ ${event.errorMessage}` : "⏳ streaming...", ctx);
      return;
    }

    if (
      event.type === "message_start" ||
      event.type === "message_update" ||
      event.type === "message_end" ||
      event.type === "turn_start"
    ) {
      syncUi(ctx);
    }
  }

  function subscribeOverlayToActiveBtwSession(ctx?: ExtensionContext | ExtensionCommandContext): void {
    const sessionRuntime = activeBtwSession;
    if (!sessionRuntime || sessionRuntime.subscriptions.size > 0) {
      return;
    }

    const unsubscribe = sessionRuntime.session.subscribe((event: AgentSessionEvent) => {
      handleBtwSessionEvent(sessionRuntime, event, ctx);
    });
    sessionRuntime.subscriptions.add(unsubscribe);
  }

  function requestBtwSessionAbort(sessionRuntime: BtwSessionRuntime): Promise<void> {
    sessionRuntime.abortPromise ??= Promise.resolve()
      .then(() => sessionRuntime.session.abort())
      .catch(() => {
        // Ignore abort errors during BTW cancellation/replacement/shutdown.
      });
    return sessionRuntime.abortPromise;
  }

  async function disposeBtwSession(): Promise<void> {
    const current = activeBtwSession;
    activeBtwSession = null;
    if (!current) {
      return;
    }

    clearBtwSessionSubscriptions(current);
    await requestBtwSessionAbort(current);
    await disposeChildSession(current.session, current.hasExtensions);
  }

  async function disposeChildSession(session: AgentSession, hasExtensions: boolean): Promise<void> {
    try {
      if (hasExtensions) {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      }
    } finally {
      session.dispose();
    }
  }

  async function dismissOverlaySession(): Promise<void> {
    invalidateBtwLifecycle();
    dismissOverlay();
    await disposeBtwSession();
  }

  /**
   * Escape behaves differently depending on whether the BTW side session is
   * currently doing work:
   *
   * - streaming: the first Escape aborts the in-flight request but keeps the
   *   overlay open (so the partial transcript stays readable and the thread
   *   remains usable). A second Escape dismisses, even while cancellation settles.
   * - idle: Escape dismisses the overlay immediately (previous behavior).
   */
  async function dismissOrAbortOverlaySession(): Promise<void> {
    const sessionRuntime = activeBtwSession;
    if (sessionRuntime?.session.isStreaming && !sessionRuntime.abortPromise) {
      setOverlayStatus("⏹ Aborting. Press Esc again to dismiss the BTW overlay.");
      await requestBtwSessionAbort(sessionRuntime);
      if (activeBtwSession === sessionRuntime && overlayRuntime) {
        setOverlayStatus("⏹ Aborted. Press Esc again to dismiss the BTW overlay.");
      }
      return;
    }
    await dismissOverlaySession();
  }

  async function resolveBtwModel(
    ctx: ExtensionCommandContext,
    notifyOnFallback = false,
  ): Promise<ResolvedBtwModel> {
    if (btwModelOverride) {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(btwModelOverride);
      if (hasUsableModelAuth(ctx, btwModelOverride, auth)) {
        return {
          model: btwModelOverride,
          source: "override",
          configuredOverride: btwModelOverride,
        };
      }

      const fallbackReason = ctx.model
        ? `Configured BTW model ${formatModelRef(btwModelOverride)} has no credentials. Falling back to main model ${formatModelRef(
            ctx.model,
          )}.`
        : `Configured BTW model ${formatModelRef(btwModelOverride)} has no credentials, and no main model is active.`;
      if (notifyOnFallback) {
        notify(ctx, fallbackReason, "warning");
      }

      if (ctx.model) {
        return {
          model: ctx.model,
          source: "main",
          configuredOverride: btwModelOverride,
          fallbackReason,
        };
      }

      return {
        model: null,
        source: "none",
        configuredOverride: btwModelOverride,
        fallbackReason,
      };
    }

    if (ctx.model) {
      return {
        model: ctx.model,
        source: "main",
        configuredOverride: null,
      };
    }

    return {
      model: null,
      source: "none",
      configuredOverride: null,
    };
  }

  async function resolveBtwSettings(
    ctx: ExtensionCommandContext,
    notifyOnFallback = false,
  ): Promise<ResolvedBtwSettings> {
    const resolvedModel = await resolveBtwModel(ctx, notifyOnFallback);
    const thinkingLevel = btwThinkingOverride ?? (pi.getThinkingLevel() as SessionThinkingLevel);

    return {
      model: resolvedModel.model,
      modelSource: resolvedModel.source,
      configuredModelOverride: resolvedModel.configuredOverride,
      thinkingLevel,
      thinkingSource: btwThinkingOverride ? "override" : "main",
      fallbackReason: resolvedModel.fallbackReason,
    };
  }

  function describeResolvedModel(settings: ResolvedBtwSettings): string {
    if (!settings.model) {
      if (settings.configuredModelOverride && settings.fallbackReason) {
        return `BTW model unavailable. ${settings.fallbackReason}`;
      }
      return "BTW model unavailable. No active model selected.";
    }

    const source =
      settings.modelSource === "override"
        ? "override"
        : settings.configuredModelOverride
          ? "inherited fallback"
          : "inherits main thread";
    return `BTW model: ${formatModelRef(settings.model)} (${source}).${
      settings.fallbackReason ? ` ${settings.fallbackReason}` : ""
    }`;
  }

  function describeResolvedThinking(settings: ResolvedBtwSettings): string {
    const source = settings.thinkingSource === "override" ? "override" : "inherits main thread";
    return `BTW thinking: ${settings.thinkingLevel} (${source}).`;
  }

  async function setBtwModelOverride(ctx: ExtensionCommandContext, nextModel: SessionModel | null): Promise<void> {
    invalidateBtwLifecycle();
    btwModelOverride = nextModel;
    const details: BtwModelOverrideDetails = nextModel
      ? { action: "set", timestamp: Date.now(), provider: nextModel.provider, id: nextModel.id, api: nextModel.api }
      : { action: "clear", timestamp: Date.now() };
    pi.appendEntry(BTW_MODEL_OVERRIDE_TYPE, details);
    await disposeBtwSession();
    const settings = await resolveBtwSettings(ctx);
    const message = nextModel
      ? `BTW model override set to ${formatModelRef(nextModel)}.`
      : "BTW model override cleared. BTW now inherits the main thread model.";
    setOverlayStatus(message, ctx);
    notify(ctx, `${message} ${describeResolvedModel(settings)}`, "info");
  }

  async function setBtwThinkingOverride(
    ctx: ExtensionCommandContext,
    nextThinkingLevel: SessionThinkingLevel | null,
  ): Promise<void> {
    invalidateBtwLifecycle();
    btwThinkingOverride = nextThinkingLevel;
    const details: BtwThinkingOverrideDetails = nextThinkingLevel
      ? { action: "set", timestamp: Date.now(), thinkingLevel: nextThinkingLevel }
      : { action: "clear", timestamp: Date.now() };
    pi.appendEntry(BTW_THINKING_OVERRIDE_TYPE, details);
    await disposeBtwSession();
    const settings = await resolveBtwSettings(ctx);
    const message = nextThinkingLevel
      ? `BTW thinking override set to ${nextThinkingLevel}.`
      : "BTW thinking override cleared. BTW now inherits the main thread thinking level.";
    setOverlayStatus(message, ctx);
    notify(ctx, `${message} ${describeResolvedThinking(settings)}`, "info");
  }

  async function createBtwSubSession(
    ctx: ExtensionCommandContext,
    mode: BtwThreadMode,
    settings: ResolvedBtwSettings,
    restartReason?: string,
  ): Promise<BtwSessionRuntime> {
    if (!settings.model) {
      throw new Error(settings.fallbackReason || "No active model selected.");
    }

    const agentDir = getAgentDir();
    const sources = mode === "readonly" ? [] : await readBtwExtensionSources({
      cwd: ctx.cwd,
      agentDir,
      projectTrusted: ctx.isProjectTrusted(),
    });
    const modelRuntimeOptions = await createBtwModelRuntimeOptions(ctx, settings.model);
    const extensionResources = sources.length > 0 ? await loadBtwExtensionResources({
      cwd: ctx.cwd,
      agentDir,
      sources,
      parentExtensionPaths: [
        ...pi.getAllTools().map((tool) => tool.sourceInfo.path),
        ...pi.getCommands().flatMap((command) => command.sourceInfo ? [command.sourceInfo.path] : []),
      ],
    }) : undefined;
    const sessionManager = SessionManager.inMemory(ctx.cwd);
    const seedLeafId = getMainLeafId(ctx);
    const seedMainIdle = isMainIdle(ctx);
    // A child created while the thread already has exchanges (main branch switch, window full, model
    // or thinking change, reload, failed request) carries them over so the conversation stays connected.
    const earlier = pendingThread.map((entry) => ({ question: entry.question, answer: entry.answer }));
    const seedMessages = buildBtwSeedState(ctx, mode, settings.model, earlier, restartReason);
    const seedAt = Date.now();

    // The session manager is the source of provider context. Seed it before
    // creating the AgentSession so its initial context includes these messages.
    for (const message of seedMessages) {
      sessionManager.appendMessage(message);
    }

    const builtinTools = BTW_TOOLS_BY_MODE[mode];
    let childSession: AgentSession | undefined;
    const sessionOptions: CreateAgentSessionOptions = {
      cwd: ctx.cwd,
      sessionManager,
      settingsManager: createBtwSettingsManager(ctx.cwd, agentDir),
      model: settings.model,
      ...modelRuntimeOptions,
      thinkingLevel: settings.thinkingLevel,
      // Extension sessions need a live registry for tools registered at startup
      // or later. Read-only sessions keep the structural built-in allowlist.
      ...(extensionResources ? { noTools: "builtin" as const } : { tools: [...builtinTools, ...(mode === "tangent" ? [] : [BTW_UPDATE_TOOL])] }),
      ...(mode === "tangent" ? {} : { customTools: [createMainSessionUpdateTool(ctx)] }),
      resourceLoader: createBtwResourceLoader(
        ctx, () => childSession?.getActiveToolNames() ?? builtinTools, [BTW_SYSTEM_PROMPT], extensionResources,
      ),
    };
    const { session, extensionsResult } = await createAgentSession(sessionOptions);
    childSession = session;
    const hasExtensions = !!extensionResources;
    if (hasExtensions) {
      try {
        if (extensionsResult.errors.length > 0) {
          throw new Error(extensionsResult.errors.map((error) => `${error.path}: ${error.error}`).join("\n"));
        }
        const collectToolNames = () => {
          const builtinNames = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "powershell", BTW_UPDATE_TOOL]);
          const extensionNames = new Set<string>();
          for (const extension of extensionsResult.extensions) {
            for (const name of extension.tools.keys()) {
              if (builtinNames.has(name) || extensionNames.has(name)) {
                throw new Error(`BTW extension tool name collision: ${name}.`);
              }
              extensionNames.add(name);
            }
          }
          return [...extensionNames];
        };
        session.setActiveToolsByName([...builtinTools, ...(mode === "tangent" ? [] : [BTW_UPDATE_TOOL]), ...collectToolNames()]);
        const startupErrors: string[] = [];
        let starting = true;
        await session.bindExtensions({
          onError: (error) => {
            const message = `${error.extensionPath}: ${error.error}`;
            if (starting) startupErrors.push(message);
            else notify(ctx, `BTW extension error: ${message}`, "error");
          },
        });
        starting = false;
        if (startupErrors.length > 0) throw new Error(startupErrors.join("\n"));
        collectToolNames();
      } catch (error) {
        try {
          await session.abort();
        } finally {
          await disposeChildSession(session, true);
        }
        throw error;
      }
    }

    const sync: BtwSyncPoint = { leafId: seedLeafId, mainRunning: !seedMainIdle, at: seedAt };
    const baseAt = mode === "tangent" || seedMessages.length === 0 ? null : seedAt;
    return { session, mode, subscriptions: new Set(), seedLeafId, seedMainIdle, used: false, sync, baseAt, promptQueue: Promise.resolve(), hasExtensions };
  }

  /** Main-session activity since the conversation's sync point, or why it cannot be appended. */
  function pendingMainUpdate(
    ctx: ExtensionCommandContext,
    runtime: BtwSessionRuntime,
  ): { kind: "none" } | { kind: "diverged" } | { kind: "update"; text: string; rounds: number; leafId: string | null; mainRunning: boolean } {
    const leafId = getMainLeafId(ctx);
    const mainRunning = !isMainIdle(ctx);
    const delta = collectMainSessionDelta(ctx.sessionManager.getEntries(), leafId, runtime.sync.leafId, BTW_HIDDEN_MAIN_TYPES);
    if (delta.diverged) return { kind: "diverged" };
    if (delta.messages.length === 0 && mainRunning === runtime.sync.mainRunning) return { kind: "none" };
    const update = buildMainSessionUpdate(delta.messages, {
      since: new Date(runtime.sync.at),
      mainRunning,
      previousMainRunning: runtime.sync.mainRunning,
      budgetTokens: Math.max(500, Math.floor(getSnapshotBudgetTokens(ctx, runtime.session.model ?? null) * BTW_UPDATE_SHARE)),
      sessionFile: ctx.sessionManager.getSessionFile?.(),
    });
    if (!update) return { kind: "none" };
    return { kind: "update", text: update.text, rounds: delta.requests, leafId, mainRunning };
  }

  function markSynced(runtime: BtwSessionRuntime, leafId: string | null, mainRunning: boolean): void {
    runtime.sync = { leafId, mainRunning, at: Date.now() };
    runtime.baseAt = runtime.sync.at;
  }

  /** Lets the BTW model pull the main session's latest progress into the conversation itself. */
  function createMainSessionUpdateTool(ctx: ExtensionCommandContext): ToolDefinition {
    return {
      name: BTW_UPDATE_TOOL,
      label: "Main session update",
      description:
        "Read what the main Pi session has done since the last main-session snapshot or update in this conversation (new requests, replies, tool calls, run status). Use it when the question depends on the main session's current state. Read-only.",
      promptSnippet: "main_session_update: fetch the main session's progress since the last snapshot/update",
      parameters: Type.Object({}),
      execute: async () => {
        const runtime = activeBtwSession;
        if (!runtime) return { content: [{ type: "text", text: "No BTW conversation is active." }], details: undefined };
        const pending = pendingMainUpdate(ctx, runtime);
        if (pending.kind === "diverged") {
          return {
            content: [{ type: "text", text: "The main session switched to another branch since this conversation's snapshot, so an incremental update is not possible. Tell the user; their next question will start from a fresh snapshot, or they can run /btw:sync now." }],
            details: undefined,
          };
        }
        if (pending.kind === "none") {
          return { content: [{ type: "text", text: `No new main-session activity since ${new Date(runtime.sync.at).toISOString()}. Main status: ${runtime.sync.mainRunning ? "running" : "idle"}.` }], details: undefined };
        }
        markSynced(runtime, pending.leafId, pending.mainRunning);
        syncUi(ctx);
        return { content: [{ type: "text", text: pending.text }], details: undefined };
      },
    };
  }

  /** Header text: how current the main-session context in this BTW conversation is. */
  let baseTextCache: { key: string; text: string } | null = null;
  function describeBtwBase(): string {
    if (pendingMode === "tangent") return "no main context";
    const ctx = lastUiContext;
    const runtime = activeBtwSession;
    const auto = isBtwAutosnap() ? " · autosnap" : "";
    if (!runtime || runtime.baseAt === null || !runtime.used || !ctx) return `main context: latest on next question${auto}`;
    let leafId: string | null = null;
    try {
      leafId = ctx.sessionManager.getLeafId() ?? null;
    } catch {}
    // Refreshes run per streamed token: walk the main tree only when the leaf or sync point moved.
    const key = `${leafId}|${runtime.sync.leafId}|${runtime.sync.at}|${runtime.syncRequested ? 1 : 0}|${auto}`;
    if (baseTextCache?.key === key) return baseTextCache.text;
    let behind = "";
    try {
      const delta = collectMainSessionDelta(ctx.sessionManager.getEntries(), leafId, runtime.sync.leafId, BTW_HIDDEN_MAIN_TYPES);
      behind = delta.diverged
        ? " · main switched branch, refreshes on next question"
        : runtime.syncRequested
          ? " · syncs with next question"
          : delta.requests > 0
            ? ` · main +${delta.requests} round${delta.requests === 1 ? "" : "s"} since (/btw:sync)`
            : delta.messages.length > 0 ? " · main progressed since (/btw:sync)" : " · up to date";
    } catch {}
    const text = `main context ${formatClock(runtime.baseAt)}${behind}${auto}`;
    baseTextCache = { key, text };
    return text;
  }

  function ensureBtwSession(ctx: ExtensionCommandContext, mode: BtwThreadMode): Promise<BtwSessionRuntime | null> {
    const generation = btwLifecycleGeneration;
    // Composer-only commands can overlap while npm resolution is in flight.
    // Serialize creation so they reuse one child and never race package installs.
    const creation = btwSessionCreationQueue.then(() => createOrReuseBtwSession(ctx, mode, generation));
    btwSessionCreationQueue = creation.then(() => {}, () => {});
    return creation;
  }

  async function createOrReuseBtwSession(
    ctx: ExtensionCommandContext,
    mode: BtwThreadMode,
    generation: number,
  ): Promise<BtwSessionRuntime | null> {
    if (generation !== btwLifecycleGeneration) return null;
    const settings = await resolveBtwSettings(ctx, true);
    if (generation !== btwLifecycleGeneration || !settings.model) {
      return null;
    }

    // One child carries the whole BTW conversation; later main activity is appended, never swapped in.
    // An unused child (e.g. prewarmed when the pane opened) is rebuilt if its seed went stale. A used
    // one is restarted (fresh snapshot + earlier exchanges) only when the main session switched branch
    // or the conversation is close to filling the window.
    let restartReason: string | undefined;
    if (activeBtwSession?.mode === mode) {
      const current = activeBtwSession;
      if (!current.used) {
        if (current.seedLeafId === getMainLeafId(ctx) && current.seedMainIdle === isMainIdle(ctx)) return current;
      } else if (mode === "tangent") {
        if (!isNearlyFull(ctx, current)) return current;
        restartReason = "restarted because the conversation was filling the context window";
      } else {
        const delta = collectMainSessionDelta(ctx.sessionManager.getEntries(), getMainLeafId(ctx), current.sync.leafId, BTW_HIDDEN_MAIN_TYPES);
        if (!delta.diverged && !isNearlyFull(ctx, current)) return current;
        restartReason = delta.diverged
          ? "the main session has since switched to another branch"
          : "restarted because the conversation was filling the context window";
      }
    }

    await disposeBtwSession();
    if (generation !== btwLifecycleGeneration) return null;
    try {
      const created = await createBtwSubSession(ctx, mode, settings, restartReason);
      if (restartReason && pendingThread.length > 0) {
        setOverlayStatus(restartReason.startsWith("the main") ? "Main session switched branch: BTW restarted from a fresh snapshot, earlier exchanges kept." : "BTW conversation was filling the window: restarted from a fresh snapshot, earlier exchanges kept.", ctx);
      }
      if (generation !== btwLifecycleGeneration) {
        await requestBtwSessionAbort(created);
        await disposeChildSession(created.session, created.hasExtensions);
        return null;
      }
      activeBtwSession = created;
    } catch (error) {
      if (generation !== btwLifecycleGeneration) return null;
      const message = `Could not start BTW session: ${error instanceof Error ? error.message : String(error)}`;
      setOverlayStatus(message, ctx);
      notify(ctx, message, "error");
      return null;
    }
    return activeBtwSession;
  }

  function isNearlyFull(ctx: ExtensionCommandContext, runtime: BtwSessionRuntime): boolean {
    try {
      const usage = runtime.session.getContextUsage();
      if (!usage || usage.tokens === null || !(usage.contextWindow > 0)) return false;
      let reserve = 16384;
      try {
        const model = runtime.session.model;
        if (model) reserve = createBtwSettingsManager(ctx.cwd, getAgentDir()).getCompactionReserveTokens(model);
      } catch {}
      const room = Math.max(usage.contextWindow * 0.5, usage.contextWindow - reserve);
      return usage.tokens >= room * BTW_RESTART_CONTEXT_SHARE;
    } catch {
      return false;
    }
  }

  function useNativeSurface(): boolean {
    return process.env.HERDR_ENV === "1" && (surfaceOverride ?? process.env.PI_BTW_SURFACE) !== "internal";
  }

  async function openComposer(ctx: ExtensionCommandContext, mode: BtwThreadMode): Promise<void> {
    // Paint/input first in Herdr; child model/tool initialization is not a startup prerequisite.
    if (useNativeSurface()) {
      await ensureOverlay(ctx);
      if (overlayRuntime?.native) void ensureBtwSession(ctx, mode).then(() => {
        subscribeOverlayToActiveBtwSession(ctx);
        syncUi(ctx);
      }).catch((error) => notify(ctx, String(error), "error"));
    } else {
      await ensureBtwSession(ctx, mode);
      await ensureOverlay(ctx);
    }
  }

  async function ensureNativeOverlay(ctx: ExtensionCommandContext | ExtensionContext): Promise<void> {
    if (overlayRuntime && !overlayRuntime.closed) {
      const existing = overlayRuntime;
      await existing.opening;
      if (overlayRuntime !== existing || existing.closed) return;
      // The child session can be replaced while the pane stays open (thinking/model change,
      // failed lazy creation retried by a submit). Always attach the pane to the current one.
      subscribeOverlayToActiveBtwSession(ctx);
      existing.refresh?.();
      if (existing.native) await existing.native.pane.focus();
      return;
    }
    const runtime: OverlayRuntime = {};
    overlayRuntime = runtime;
    let errorReported = false;
    const reportError = (error: unknown) => {
      if (errorReported) return;
      errorReported = true;
      notify(ctx, `Native BTW failed: ${error instanceof Error ? error.message : String(error)}. No internal fallback was opened.`, "error");
    };
    runtime.close = () => {
      runtime.closed = true;
      if (runtime.native) void runtime.native.close();
      if (overlayRuntime === runtime) overlayRuntime = null;
    };
    runtime.opening = (async () => {
      const { theme, keys } = await getBtwUiResources(ctx, pi);
      if (runtime.closed) return;
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile || !process.env.HERDR_PANE_ID) throw new Error("Native BTW requires a persistent parent Pi session and Herdr pane identity.");
      const surface = new NativeSurface({
        pluginRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
        hostDir: getPackageDir(), parentPaneId: process.env.HERDR_PANE_ID, sessionFile, cwd: ctx.cwd,
        createComponent: (tui, geometry) => {
          const component = new BtwOverlayComponent(tui, theme, keys,
            () => transcriptState.entries, () => overlayStatus, () => pendingMode, () => "full",
            (value) => { void submitFromOverlay(ctx, value).catch((error) => setOverlayStatus(String(error), ctx)); },
            () => { void dismissOrAbortOverlaySession(); },
            () => { void surface.pane.focus(true).catch((error) => notify(ctx, String(error), "error")); },
            () => { void surface.pane.zoom().catch((error) => notify(ctx, String(error), "error")); },
            geometry, true);
          component.getPromptHistory = () => promptHistory;
          component.getBaseText = describeBtwBase;
          component.setDraft(overlayDraft);
          return component;
        },
        onClosed: () => {
          overlayDraft = surface.component?.getDraft?.() ?? overlayDraft;
          runtime.closed = true;
          if (overlayRuntime === runtime) overlayRuntime = null;
          if (activeBtwSession) clearBtwSessionSubscriptions(activeBtwSession);
        },
        onError: reportError,
      });
      nativeSurfaces.add(surface);
      void surface.done.finally(() => nativeSurfaces.delete(surface));
      runtime.native = surface;
      runtime.setDraft = (value) => surface.setDraft(value);
      runtime.refresh = () => surface.refresh(activeBtwSession?.session.isStreaming || hasStreamingTranscriptEntry(transcriptState.entries) || overlayStatus?.startsWith("⏳") ? "working" : "idle");
      await surface.open();
      await surface.ready;
      if (runtime.closed) { await surface.close(); return; }
      subscribeOverlayToActiveBtwSession(ctx);
      runtime.refresh();
    })();
    try { await runtime.opening; }
    catch (error) {
      runtime.close?.();
      // Do not silently reintroduce the single-PTY split on launch failure.
      reportError(error);
    }
  }

  async function ensureOverlay(ctx: ExtensionCommandContext | ExtensionContext): Promise<void> {
    if (!canRenderBtwOverlay(ctx)) {
      return;
    }
    lastUiContext = ctx;

    if (useNativeSurface()) {
      await ensureNativeOverlay(ctx);
      return;
    }
    if (overlayRuntime?.opening) {
      await overlayRuntime.opening;
      return;
    }
    if (overlayRuntime?.handle) {
      subscribeOverlayToActiveBtwSession(ctx);
      focusOverlay();
      return;
    }

    const runtime: OverlayRuntime = {};
    let splitLayout: ReturnType<typeof createBtwSplitLayout> | undefined;
    const closeRuntime = () => {
      if (runtime.closed) {
        splitLayout?.dispose();
        runtime.finish?.();
        return;
      }
      runtime.closed = true;
      if (activeBtwSession) {
        clearBtwSessionSubscriptions(activeBtwSession);
      }
      if (overlayRuntime === runtime) {
        overlayRuntime = null;
        overlayWidthMode = "window";
      }
      splitLayout?.dispose();
      runtime.finish?.();
    };

    runtime.close = closeRuntime;
    overlayRuntime = runtime;

    void showBtwOverlay(ctx, pi,
        async (tui, theme, keybindings) => {
          splitLayout = createBtwSplitLayout(tui, () => overlayWidthMode);
          if (tui.mode === "fullscreen" && !splitLayout.supported) {
            notify(ctx, "BTW sidebar unavailable for this Pi layout; using the original window.", "warning");
          }
          const overlay = new BtwOverlayComponent(
            tui,
            theme,
            keybindings,
            () => transcriptState.entries,
            () => overlayStatus,
            () => pendingMode,
            () => overlayWidthMode,
            (value) => {
              void submitFromOverlay(ctx, value);
            },
            () => {
              void dismissOrAbortOverlaySession();
            },
            () => {
              overlayRuntime?.handle?.unfocus();
              overlayRuntime?.refresh?.();
            },
            () => {
              void toggleOverlayWidth(ctx);
            },
            () => splitLayout!.geometry(),
          );

          splitLayout.bindOverlay(overlay);
          overlay.focused = runtime.handle?.isFocused() ?? true;
          overlay.getPromptHistory = () => promptHistory;
          overlay.getBaseText = describeBtwBase;
          overlay.setDraft(overlayDraft);
          runtime.setDraft = (value) => {
            overlay.setDraft(value);
          };
          runtime.refresh = () => {
            overlay.focused = runtime.handle?.isFocused() ?? false;
            overlay.refresh();
          };
          runtime.close = () => {
            overlayDraft = overlay.getDraft();
            closeRuntime();
          };

          subscribeOverlayToActiveBtwSession(ctx);

          runtime.finish = () => {
            runtime.handle?.hide();
            overlay.dispose();
          };
          return overlay;
        },
        () => splitLayout!.options,
      ).then(({ handle }) => {
        runtime.handle = handle;
        if (runtime.closed) {
          closeRuntime();
        } else {
          handle.focus();
          runtime.refresh?.();
        }
      })
      .catch((error) => {
        closeRuntime();
        if (overlayRuntime === runtime) {
          overlayRuntime = null;
        }
        notify(ctx, error instanceof Error ? error.message : String(error), "error");
      });
  }

  async function dispatchBtwCommand(name: string, args: string, ctx: ExtensionCommandContext): Promise<boolean> {
    const trimmedArgs = args.trim();

    if (name === "btw:ui") {
      if (trimmedArgs !== "internal" && trimmedArgs !== "native") {
        notify(ctx, "Usage: /btw:ui native|internal. Native requires Herdr; internal is the explicit single-PTY rollback.", "info");
        return true;
      }
      if (trimmedArgs === "native" && process.env.HERDR_ENV !== "1") {
        notify(ctx, "Native BTW requires Herdr.", "error");
        return true;
      }
      dismissOverlay();
      await Promise.all([...nativeSurfaces].map((surface) => surface.close()));
      surfaceOverride = trimmedArgs;
      notify(ctx, `BTW UI: ${trimmedArgs}. Thread preserved; /btw reopens it.`, "info");
      return true;
    }

    if (name === "btw") {
      const { question, save } = parseBtwArgs(trimmedArgs);
      if (!question) {
        if (!canRenderBtwOverlay(ctx)) {
          notifyInlineQuestionRequired(ctx, "/btw");
          return true;
        }
        await openComposer(ctx, pendingMode);
        return true;
      }

      if (pendingMode !== "contextual") {
        await resetThread(ctx, true, "contextual");
      }

      await runBtw(ctx, question, save, "contextual");
      return true;
    }

    if (name === "btw:tangent") {
      const { question, save } = parseBtwArgs(trimmedArgs);
      if (!question && !canRenderBtwOverlay(ctx)) {
        notifyInlineQuestionRequired(ctx, "/btw:tangent");
        return true;
      }
      if (pendingMode !== "tangent") {
        await resetThread(ctx, true, "tangent");
      }

      if (!question) {
        await openComposer(ctx, "tangent");
        return true;
      }

      await runBtw(ctx, question, save, "tangent");
      return true;
    }

    if (name === "btw:ask") {
      const { question, save } = parseBtwArgs(trimmedArgs);
      if (!question && !canRenderBtwOverlay(ctx)) {
        notifyInlineQuestionRequired(ctx, "/btw:ask");
        return true;
      }

      // Read-only mode is a distinct capability boundary, so switching into it
      // resets the thread and lets ensureBtwSession recreate the child session.
      if (pendingMode !== "readonly") {
        await resetThread(ctx, true, "readonly");
      }

      if (!question) {
        await openComposer(ctx, "readonly");
        return true;
      }

      await runBtw(ctx, question, save, "readonly");
      return true;
    }

    if (name === "btw:sync") {
      if (pendingMode === "tangent") {
        notify(ctx, "This is a tangent thread without main-session context; /btw:new starts one with it.", "info");
        return true;
      }
      const runtime = activeBtwSession;
      if (!runtime?.used) {
        setOverlayStatus("The next question reads the latest main session.", ctx);
        notify(ctx, "The next question reads the latest main session.", "info");
        return true;
      }
      const pending = pendingMainUpdate(ctx, runtime);
      if (pending.kind === "diverged") {
        // Cannot append across a branch switch: restart from a fresh snapshot with the earlier exchanges.
        await disposeBtwSession();
        setOverlayStatus("Main session switched branch: the next question starts from a fresh snapshot, earlier exchanges kept.", ctx);
      } else if (pending.kind === "none") {
        setOverlayStatus("Already up to date with the main session.", ctx);
      } else {
        runtime.syncRequested = true;
        setOverlayStatus("Main-session progress will be added before your next question.", ctx);
      }
      syncUi(ctx);
      return true;
    }

    if (name === "btw:autosnap") {
      const value = trimmedArgs.toLowerCase();
      if (value && value !== "on" && value !== "off") {
        notify(ctx, "Usage: /btw:autosnap [on|off]", "info");
        return true;
      }
      if (value) {
        try {
          writeBtwAutosnap(value === "on");
        } catch (error) {
          notify(ctx, error instanceof Error ? error.message : String(error), "error");
          return true;
        }
        btwAutosnapCache = value === "on";
      }
      const message = isBtwAutosnap()
        ? "BTW autosnap is on: the main session's latest progress is added before every question."
        : "BTW autosnap is off: use /btw:sync, or BTW reads main_session_update when it needs to.";
      setOverlayStatus(message, ctx);
      notify(ctx, message, "info");
      syncUi(ctx);
      return true;
    }

    if (name === "btw:new") {
      const { question, save } = parseBtwArgs(trimmedArgs);
      if (!question && !canRenderBtwOverlay(ctx)) {
        notifyInlineQuestionRequired(ctx, "/btw:new");
        return true;
      }

      await resetThread(ctx, true, "contextual");
      if (question) {
        await runBtw(ctx, question, save, "contextual");
      } else {
        setOverlayStatus("Started a fresh BTW thread.", ctx);
        await openComposer(ctx, "contextual");
        notify(ctx, "Started a fresh BTW thread.", "info");
      }
      return true;
    }

    if (name === "btw:clear") {
      discardHandoffs();
      await resetThread(ctx);
      dismissOverlay();
      notify(ctx, "Cleared BTW thread.", "info");
      return true;
    }

    if (name === "btw:model") {
      const parsed = parseBtwModelArgs(trimmedArgs);
      if (parsed.action === "invalid") {
        setOverlayStatus(parsed.message, ctx);
        notify(ctx, parsed.message, "error");
        return true;
      }

      if (parsed.action === "show") {
        const settings = await resolveBtwSettings(ctx);
        const message = describeResolvedModel(settings);
        setOverlayStatus(message, ctx);
        notify(ctx, message, settings.model ? "info" : "warning");
        return true;
      }

      if (parsed.action === "clear") {
        await setBtwModelOverride(ctx, null);
        return true;
      }
      const ref = parsed.model;
      const resolved = ctx.modelRegistry.find(ref.provider, ref.id);
      if (!resolved) {
        const message = `Unknown model ${ref.provider}/${ref.id}. Use /login or /models to add it before setting it as the BTW override.`;
        setOverlayStatus(message, ctx);
        notify(ctx, message, "error");
        return true;
      }
      await setBtwModelOverride(ctx, resolved);
      return true;
    }

    if (name === "btw:thinking") {
      const parsed = parseBtwThinkingArgs(trimmedArgs);
      if (parsed.action === "show") {
        const settings = await resolveBtwSettings(ctx);
        const message = describeResolvedThinking(settings);
        setOverlayStatus(message, ctx);
        notify(ctx, message, "info");
        return true;
      }

      await setBtwThinkingOverride(ctx, parsed.action === "clear" ? null : parsed.thinkingLevel);
      return true;
    }

    if (name === "btw:inject" || name === "btw:summarize") {
      const kind: BtwHandoffKind = name === "btw:summarize" ? "summary" : "thread";
      await btwSubmissionQueue;
      if (pendingHandoff) {
        notify(ctx, `${handoffLabel(pendingHandoff)} is still on its way to the main session.`, "warning");
        return true;
      }
      const instructions = trimmedArgs;
      const cached = reusableHandoff(kind, instructions);
      if (!cached && pendingThread.length === 0) {
        notify(ctx, `No BTW thread to ${kind === "summary" ? "summarize" : "inject"}.`, "warning");
        return true;
      }

      setOverlayStatus(
        cached ? "⏳ resending to the main session..." : kind === "summary" ? "⏳ summarizing..." : "⏳ injecting into the main session...",
        ctx,
      );
      await ensureOverlay(ctx);

      try {
        let record = cached;
        if (!record) {
          const { thread } = await getBtwHandoffThread();
          const body = kind === "summary" ? await summarizeThread(ctx, thread) : formatThread(thread);
          record = createHandoffRecord(kind, body, thread.length, instructions);
        }
        sendHandoffToMain(ctx, record);
        if (kind === "summary" && !cached) {
          // The summary carries the thread now (and is saved for resend): start BTW afresh.
          await resetThread(ctx);
          setOverlayStatus(`${handoffLabel(record)} sent; waiting for the main session to receive it.`, ctx);
        }
        // An inject keeps the thread until the main session has it (see checkPendingHandoff).
        dismissOverlay();
      } catch (error) {
        setOverlayStatus(
          kind === "summary" ? "Summarize failed. Thread preserved for retry or injection." : "Inject failed. Thread preserved for retry or summarize.",
          ctx,
        );
        notify(ctx, error instanceof Error ? error.message : String(error), "error");
      }
      return true;
    }

    return false;
  }

  function parseOverlayBtwCommand(value: string): { name: string; args: string } | null {
    return parseComposerCommand(value);
  }

  async function submitFromOverlay(ctx: ExtensionCommandContext | ExtensionContext, value: string): Promise<void> {
    const question = value.trim();
    if (!question) {
      setOverlayStatus("Enter a BTW prompt before submitting.", ctx);
      return;
    }
    addPromptHistory(question);

    if (!("getSystemPrompt" in ctx)) {
      setOverlayStatus("BTW overlay submit requires a command context. Reopen BTW from a command.", ctx);
      return;
    }

    const cmdCtx = ctx as ExtensionCommandContext;
    const btwCommand = parseOverlayBtwCommand(question);
    if (btwCommand) {
      setOverlayDraft("");
      await dispatchBtwCommand(btwCommand.name, btwCommand.args, cmdCtx);
      return;
    }

    const prefix = resolveComposerPrefix(question);
    if (prefix?.kind === "run") {
      setOverlayDraft("");
      await dispatchBtwCommand(prefix.name, prefix.args, cmdCtx);
      return;
    }
    if (prefix?.kind === "prompt") {
      setOverlayStatus(prefix.message, ctx);
      return;
    }
    if (isUnknownBtwComposerCommand(question)) {
      // Keep the draft so it can be corrected; never send a mistyped command to the model.
      const token = question.split(/\s+/, 1)[0];
      setOverlayStatus(`Unknown BTW command ${token}. Type / to list commands; Tab completes.`, ctx);
      return;
    }
    const blocked = pendingHandoffBlock();
    if (blocked) {
      // Keep the draft: it can be sent once the handoff has arrived.
      setOverlayStatus(blocked, ctx);
      return;
    }
    setOverlayDraft("");
    setOverlayStatus("⏳ streaming...", ctx);
    syncUi(ctx);
    await runBtw(cmdCtx, question, false, pendingMode);
  }

  async function resetThread(
    ctx: ExtensionContext | ExtensionCommandContext,
    persist = true,
    mode: BtwThreadMode = "contextual",
  ): Promise<void> {
    invalidateBtwLifecycle();
    clearThreadHandoffState();
    await disposeBtwSession();
    pendingThread = [];
    pendingMode = mode;
    transcriptState = createEmptyTranscriptState();
    setOverlayDraft("");
    setOverlayStatus(null, ctx);
    if (persist) {
      const details: BtwResetDetails = { timestamp: Date.now(), mode };
      pi.appendEntry(BTW_RESET_TYPE, details);
    }
    syncUi(ctx);
  }

  async function restoreThread(ctx: ExtensionContext): Promise<void> {
    invalidateBtwLifecycle();
    clearHandoffState();
    dismissOverlay();
    await Promise.all([...nativeSurfaces].map((surface) => surface.close()));
    overlayWidthMode = "window";
    await disposeBtwSession();
    pendingThread = [];
    pendingMode = "contextual";
    btwModelOverride = null;
    btwThinkingOverride = null;
    transcriptState = createEmptyTranscriptState();
    overlayDraft = "";
    promptHistory = [];
    lastUiContext = ctx;
    overlayStatus = null;
    btwAutosnapCache = null;

    const branch = ctx.sessionManager.getBranch();
    let lastResetIndex = -1;
    let lastHandoffIndex = -1;
    const discardedHandoffIds = new Set<string>();

    for (let i = 0; i < branch.length; i++) {
      if (isCustomEntry(branch[i], BTW_MODEL_OVERRIDE_TYPE)) {
        const details = (branch[i] as unknown as { data?: BtwModelOverrideDetails }).data;
        if (details?.action === "set") {
          const resolved = ctx.modelRegistry.find(details.provider, details.id);
          if (resolved) {
            btwModelOverride = resolved;
          } else {
            // Configured override is no longer in the registry; drop it on restore.
            btwModelOverride = null;
          }
        } else if (details?.action === "clear") {
          btwModelOverride = null;
        }
      }

      if (isCustomEntry(branch[i], BTW_THINKING_OVERRIDE_TYPE)) {
        const details = (branch[i] as unknown as { data?: BtwThinkingOverrideDetails }).data;
        btwThinkingOverride =
          details?.action === "set"
            ? details.thinkingLevel
            : details?.action === "clear"
              ? null
              : btwThinkingOverride;
      }

      if (isCustomEntry(branch[i], BTW_RESET_TYPE)) {
        lastResetIndex = i;
        const details = (branch[i] as unknown as { data?: BtwResetDetails }).data;
        pendingMode = details?.mode ?? "contextual";
      }

      if (isCustomEntry(branch[i], BTW_HANDOFF_PENDING_TYPE)) {
        lastHandoffIndex = i;
      }

      if (isCustomEntry(branch[i], BTW_HANDOFF_DISCARDED_TYPE)) {
        const id = (branch[i] as unknown as { data?: { id?: string } }).data?.id;
        if (id) discardedHandoffIds.add(id);
      }
    }

    // Like the main editor after a reload: every BTW question on this branch, across resets.
    for (const entry of branch) {
      const question = isCustomEntry(entry, BTW_ENTRY_TYPE) ? (entry as unknown as { data?: BtwDetails }).data?.question : undefined;
      if (typeof question === "string") addPromptHistory(question);
    }

    for (const entry of branch.slice(lastResetIndex + 1)) {
      if (!isCustomEntry(entry, BTW_ENTRY_TYPE)) {
        continue;
      }

      const details = (entry as unknown as { data?: BtwDetails }).data;
      if (!details?.question || !details.answer) {
        continue;
      }

      const normalizedDetails: BtwDetails = {
        ...details,
        api: details.api || ctx.model?.api || "openai-responses",
      };

      pendingThread.push(normalizedDetails);
      appendPersistedTranscriptTurn(transcriptState, normalizedDetails);
    }

    // The latest handoff: delivered, discarded by /btw:clear, or lost with Pi's queues.
    // An inject only matters if sent after the last reset (it keeps its thread); a summary
    // cleared its thread when sent, so it may precede later resets.
    const handoff = lastHandoffIndex >= 0
      ? (branch[lastHandoffIndex] as unknown as { data?: BtwHandoffRecord }).data
      : undefined;
    const handoffCurrent = !!handoff?.id && !!handoff.content && !discardedHandoffIds.has(handoff.id) &&
      (lastHandoffIndex > lastResetIndex || (handoff.kind === "summary" && handoff.threadCleared === true));
    if (handoff && handoffCurrent) {
      if (isBtwHandoffInBranch(branch, handoff.id)) {
        if (handoff.kind === "thread") {
          await resetThread(ctx);
          return;
        }
      } else {
        undeliveredHandoff = handoff;
        overlayStatus = `${handoffLabel(handoff)} did not reach the main session; ${handoffCommand(handoff.kind)} resends it.`;
      }
    }

    syncUi(ctx);
  }

  async function runBtw(
    ctx: ExtensionCommandContext,
    question: string,
    saveRequested: boolean,
    mode: BtwThreadMode,
  ): Promise<void> {
    // Questions sent with /btw from the main editor are recalled in the BTW composer too.
    addPromptHistory(question);
    const blocked = pendingHandoffBlock();
    if (blocked) {
      setOverlayStatus(blocked, ctx);
      notify(ctx, blocked, "warning");
      return;
    }
    if (useNativeSurface() && canRenderBtwOverlay(ctx) && !overlayRuntime) {
      await ensureOverlay(ctx);
      if (!(overlayRuntime as OverlayRuntime | null)?.native) return; // Failed native launch must not start an invisible model request.
    }
    const generation = btwLifecycleGeneration;
    const submission = btwSubmissionQueue.then(async () => {
      if (generation !== btwLifecycleGeneration) {
        return;
      }
      await executeBtw(ctx, question, saveRequested, mode, generation);
    });
    btwSubmissionQueue = submission.catch(() => {});
    await submission;
  }

  async function executeBtw(
    ctx: ExtensionCommandContext,
    question: string,
    saveRequested: boolean,
    mode: BtwThreadMode,
    generation: number,
  ): Promise<void> {
    const isCurrentGeneration = () => generation === btwLifecycleGeneration;
    lastUiContext = ctx;
    const settings = await resolveBtwSettings(ctx);
    if (!isCurrentGeneration()) {
      return;
    }
    const model = settings.model;
    if (!model) {
      const message = settings.fallbackReason || "No active model selected.";
      setOverlayStatus(message, ctx);
      notify(ctx, message, "error");
      return;
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!isCurrentGeneration()) {
      return;
    }
    if (!hasUsableModelAuth(ctx, model, auth)) {
      const message = auth.ok ? `No credentials available for ${model.provider}/${model.id}.` : auth.error;
      setOverlayStatus(message, ctx);
      notify(ctx, message, "error");
      await ensureOverlay(ctx);
      return;
    }

    const sessionRuntime = await ensureBtwSession(ctx, mode);
    if (!isCurrentGeneration()) {
      if (sessionRuntime && activeBtwSession === sessionRuntime) {
        await disposeBtwSession();
      }
      return;
    }
    if (!sessionRuntime) {
      return;
    }

    const session = sessionRuntime.session;
    const wasBusy = !ctx.isIdle();
    const overlayAvailable = canRenderBtwOverlay(ctx);
    pendingMode = mode;
    const thinkingLevel = settings.thinkingLevel;

    let releasePromptTurn!: () => void;
    const previousPromptTurns = sessionRuntime.promptQueue;
    const currentPromptTurn = new Promise<void>((resolve) => {
      releasePromptTurn = resolve;
    });
    sessionRuntime.promptQueue = previousPromptTurns.then(() => currentPromptTurn);

    if (session.isStreaming || sessionRuntime.abortPromise) {
      setOverlayStatus("⏳ waiting for the current BTW turn to finish...", ctx);
    }
    await previousPromptTurns;
    if (activeBtwSession !== sessionRuntime) {
      releasePromptTurn();
      return;
    }

    if (sessionRuntime.abortPromise) {
      setOverlayStatus("⏳ waiting for cancellation to finish...", ctx);
      await sessionRuntime.abortPromise;
      if (activeBtwSession !== sessionRuntime) {
        releasePromptTurn();
        return;
      }
    }

    if (!isCurrentGeneration()) {
      releasePromptTurn();
      return;
    }

    sessionRuntime.abortPromise = undefined;
    // Autosnap (or an explicit /btw:sync queued earlier): append the main session's progress before the question.
    let promptText = question;
    if (sessionRuntime.used && sessionRuntime.mode !== "tangent" && (isBtwAutosnap() || sessionRuntime.syncRequested)) {
      const pending = pendingMainUpdate(ctx, sessionRuntime);
      if (pending.kind === "update") {
        promptText = `${pending.text}\n\n${question}`;
        markSynced(sessionRuntime, pending.leafId, pending.mainRunning);
      }
    }
    sessionRuntime.syncRequested = false;
    sessionRuntime.used = true;
    setOverlayStatus("⏳ streaming...", ctx);
    await ensureOverlay(ctx);

    try {
      await session.prompt(promptText, { source: "extension" });
      if (!isCurrentGeneration()) {
        return;
      }

      const response = getLastAssistantMessage(session);
      if (!response) {
        throw new Error("BTW request finished without a response.");
      }
      if (response.stopReason === "aborted") {
        const abortedTurnId = transcriptState.currentTurnId ?? transcriptState.lastTurnId;
        finishTranscriptTurn(transcriptState, abortedTurnId, "aborted");
        setOverlayStatus("⏹ Aborted. Press Esc again to dismiss the BTW overlay.", ctx);
        return;
      }
      if (response.stopReason === "error") {
        // Pi handles compaction/retry when enabled. Offer a fallback if overflow still reaches us.
        const overflowHint = isContextOverflow(response, model.contextWindow)
          ? " The BTW thread no longer fits the model's context. Check your Pi compaction settings, use /btw:summarize to hand it off, or /btw:new to start over."
          : "";
        throw new Error((response.errorMessage || "BTW request failed.") + overflowHint);
      }

      const completedTurnId = transcriptState.lastTurnId ?? transcriptState.currentTurnId;
      const streamedThinking =
        completedTurnId !== null ? findLatestTranscriptEntry(transcriptState, completedTurnId, "thinking")?.text : "";
      const answer = extractAnswer(response);
      const thinking = extractThinking(response) || streamedThinking || "";

      const details: BtwDetails = {
        question,
        thinking,
        answer,
        provider: model.provider,
        model: model.id,
        api: model.api,
        thinkingLevel,
        timestamp: Date.now(),
        usage: response.usage,
      };

      pendingThread.push(details);
      pi.appendEntry(BTW_ENTRY_TYPE, details);

      const saveState = saveVisibleBtwNote(pi, details, saveRequested || !overlayAvailable, wasBusy);
      if (!overlayAvailable) {
        const message =
          saveState === "queued"
            ? "BTW response queued to display after the current turn finishes."
            : "Displayed BTW response in the session.";
        notify(ctx, message, "info");
        setOverlayStatus(message, ctx);
      } else if (saveState === "saved") {
        notify(ctx, "Saved BTW note to the session.", "info");
        setOverlayStatus("Saved BTW note to the session.", ctx);
      } else if (saveState === "queued") {
        notify(ctx, "BTW note queued to save after the current turn finishes.", "info");
        setOverlayStatus("BTW note queued to save after the current turn finishes.", ctx);
      } else {
        setOverlayStatus("Ready for a follow-up.", ctx);
      }
    } catch (error) {
      if (!isCurrentGeneration()) {
        return;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      setTranscriptFailure(transcriptState, errorMessage);
      setOverlayStatus("Request failed. Thread preserved for retry or follow-up.", ctx);
      notify(ctx, errorMessage, "error");
      await disposeBtwSession();
    } finally {
      releasePromptTurn();
      syncUi(ctx);
    }
  }

  function getPendingThreadForHandoff(): BtwHandoffExchange[] {
    return pendingThread.map((entry) => ({ user: entry.question, assistant: entry.answer }));
  }

  /** The handoff is the persisted thread: every completed exchange, across per-question children. */
  async function getBtwHandoffThread(): Promise<{ thread: BtwHandoffExchange[] }> {
    await btwSubmissionQueue;
    const sessionRuntime = activeBtwSession;
    if (sessionRuntime) {
      await sessionRuntime.promptQueue;
      await sessionRuntime.abortPromise;
    }

    const thread = getPendingThreadForHandoff();
    if (thread.length === 0) {
      throw new Error("No BTW thread available for handoff.");
    }

    return { thread };
  }

  async function summarizeThread(ctx: ExtensionCommandContext, thread: BtwHandoffExchange[]): Promise<string> {
    const settings = await resolveBtwSettings(ctx, true);
    const model = settings.model;
    if (!model) {
      throw new Error(settings.fallbackReason || "No active model selected.");
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!hasUsableModelAuth(ctx, model, auth)) {
      throw new Error(auth.ok ? `No credentials available for ${model.provider}/${model.id}.` : auth.error);
    }

    const modelRuntimeOptions = await createBtwModelRuntimeOptions(ctx, model);

    const sessionOptions: CreateAgentSessionOptions = {
      sessionManager: SessionManager.inMemory(),
      model,
      ...modelRuntimeOptions,
      thinkingLevel: "off",
      tools: [],
      resourceLoader: createBtwResourceLoader(ctx, [], [BTW_SUMMARIZE_SYSTEM_PROMPT]),
    };
    const { session } = await createAgentSession(sessionOptions);

    try {
      await session.prompt(formatThread(thread), { source: "extension" });

      const response = getLastAssistantMessage(session);
      if (!response) {
        throw new Error("BTW summarize finished without a response.");
      }
      if (response.stopReason === "error") {
        throw new Error(response.errorMessage || "Failed to summarize BTW thread.");
      }
      if (response.stopReason === "aborted") {
        throw new Error("BTW summarize aborted.");
      }

      return extractAnswer(response);
    } finally {
      try {
        await session.abort();
      } catch {
        // Ignore abort errors during summarize session shutdown.
      }
      session.dispose();
    }
  }

  /** Main-session card for a BTW handoff: source label, then the body (collapsed to a preview). */
  pi.registerMessageRenderer(BTW_HANDOFF_TYPE, (message, { expanded }, theme) => {
    const details = message.details as BtwHandoffDetails | undefined;
    const raw = typeof message.content === "string"
      ? message.content
      : message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
    const body = extractBtwHandoffBody(raw);
    const exchanges = details?.exchanges ?? 0;
    const title = `BTW → main · ${details?.kind === "thread" ? "full thread" : "summary"} · ${exchanges} exchange${exchanges === 1 ? "" : "s"}`;
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(theme.fg("accent", theme.bold(title)), 0, 0));
    if (details?.instructions) box.addChild(new Text(theme.fg("dim", `instructions: ${details.instructions}`), 0, 0));
    const lines = body.split("\n");
    const previewLines = 8;
    const shown = expanded || lines.length <= previewLines ? body : lines.slice(0, previewLines).join("\n");
    box.addChild(new Markdown(shown, 0, 0, getMarkdownTheme(), { color: (text: string) => theme.fg("customMessageText", text) }));
    if (!expanded && lines.length > previewLines) {
      box.addChild(new Text(theme.fg("dim", `… ${lines.length - previewLines} more lines (expand to show all)`), 0, 0));
    }
    return box;
  });

  pi.on("message_end", async (event, ctx) => {
    const message = event.message as { role?: string; customType?: string; details?: { id?: string } };
    if (message.role !== "custom" || message.customType !== BTW_HANDOFF_TYPE || !message.details?.id) return;
    const id = message.details.id;
    const record = pendingHandoff?.id === id ? pendingHandoff : undeliveredHandoff?.id === id ? undeliveredHandoff : null;
    // Defer past Pi's own persistence of this message so the reset entry follows it.
    if (record) setTimeout(() => void markHandoffDelivered(ctx, record).catch(() => {}), 0);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (pendingHandoff) await checkPendingHandoff(ctx);
    if (overlayRuntime) overlayRuntime.refresh?.();
  });

  // Keep the "main +N rounds since" header current while the pane is open.
  pi.on("turn_end", async () => {
    if (overlayRuntime) overlayRuntime.refresh?.();
  });
  pi.registerMessageRenderer(BTW_MESSAGE_TYPE, (message, { expanded }, theme) => {
    const details = message.details as BtwDetails | undefined;
    const content = details
      ? buildBtwMessageContent(details.question, details.answer)
      : typeof message.content === "string"
        ? message.content
        : "[non-text btw message]";

    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(theme.fg("accent", theme.bold("[BTW]")), 0, 0));
    box.addChild(
      new Markdown(content, 0, 0, getMarkdownTheme(), {
        color: (text: string) => theme.fg("customMessageText", text),
      }),
    );

    if (expanded && details) {
      box.addChild(
        new Text(
          theme.fg(
            "dim",
            `model: ${details.provider}/${details.model} (${details.api ?? "openai-responses"}) · thinking: ${details.thinkingLevel}`,
          ),
          0,
          0,
        ),
      );

      if (details.usage) {
        box.addChild(
          new Text(
            theme.fg(
              "dim",
              `tokens: in ${details.usage.input} · out ${details.usage.output} · total ${details.usage.totalTokens}`,
            ),
            0,
            0,
          ),
        );
      }
    }

    return box;
  });

  pi.on("context", async (event) => {
    return {
      messages: event.messages.filter((message) => !isVisibleBtwMessage(message)),
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    await restoreThread(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    await restoreThread(ctx);
  });

  pi.on("session_shutdown", async () => {
    invalidateBtwLifecycle();
    clearHandoffState();
    await disposeBtwSession();
    dismissOverlay();
    await Promise.all([...nativeSurfaces].map((surface) => surface.close()));
  });

  for (const shortcut of BTW_FOCUS_SHORTCUTS) {
    pi.registerShortcut(shortcut, {
      description: "Toggle BTW overlay focus while leaving it open.",
      handler: async (_ctx) => {
        toggleOverlayFocus();
      },
    });
  }

  pi.registerShortcut(BTW_WIDTH_TOGGLE_SHORTCUT, {
    description: "Toggle the BTW overlay between window and full-width layouts.",
    handler: async () => {
      if (!overlayRuntime || !lastUiContext) {
        return;
      }
      await toggleOverlayWidth(lastUiContext);
    },
  });

  pi.registerCommand("btw:ui", {
    description: "Choose native Herdr BTW or explicit internal rollback; preserves the side thread.",
    handler: async (args, ctx) => { await dispatchBtwCommand("btw:ui", args, ctx); },
  });

  pi.registerCommand("btw", {
    description: "Continue a side conversation in a focused BTW modal. Add --save to also persist a visible note.",
    handler: async (args, ctx) => {
      await dispatchBtwCommand("btw", args, ctx);
    },
  });

  pi.registerCommand("side", {
    description: "Alias for /btw: continue a side conversation in a focused BTW modal.",
    handler: async (args, ctx) => {
      await dispatchBtwCommand("btw", args, ctx);
    },
  });

  pi.registerCommand("btw:tangent", {
    description: "Start or continue a contextless BTW tangent in the focused BTW modal.",
    handler: async (args, ctx) => {
      await dispatchBtwCommand("btw:tangent", args, ctx);
    },
  });

  pi.registerCommand("btw:ask", {
    description: "Ask a read-only side question: inherits main-session context but exposes only read/grep/find/ls tools.",
    handler: async (args, ctx) => {
      await dispatchBtwCommand("btw:ask", args, ctx);
    },
  });

  pi.registerCommand("btw:new", {
    description: "Start a fresh BTW thread with main-session context. Optionally ask the first question immediately.",
    handler: async (args, ctx) => {
      await dispatchBtwCommand("btw:new", args, ctx);
    },
  });

  pi.registerCommand("btw:sync", {
    description: "Add the main session's progress since the last snapshot to the BTW conversation (with the next question).",
    handler: async (args, ctx) => {
      await dispatchBtwCommand("btw:sync", args, ctx);
    },
  });

  pi.registerCommand("btw:autosnap", {
    description: "Show or set (on|off) whether BTW adds the main session's progress before every question.",
    handler: async (args, ctx) => {
      await dispatchBtwCommand("btw:autosnap", args, ctx);
    },
  });

  pi.registerCommand("btw:clear", {
    description: "Dismiss the BTW modal/widget and clear the current thread.",
    handler: async (args, ctx) => {
      await dispatchBtwCommand("btw:clear", args, ctx);
    },
  });

  pi.registerCommand("btw:inject", {
    description: "Inject the full BTW thread into the main agent as a user message.",
    handler: async (args, ctx) => {
      await dispatchBtwCommand("btw:inject", args, ctx);
    },
  });

  pi.registerCommand("btw:summarize", {
    description: "Summarize the BTW thread, then inject the summary into the main agent.",
    handler: async (args, ctx) => {
      await dispatchBtwCommand("btw:summarize", args, ctx);
    },
  });

  pi.registerCommand("btw:model", {
    description: "Show, set, or clear the BTW-only model override.",
    handler: async (args, ctx) => {
      await dispatchBtwCommand("btw:model", args, ctx);
    },
  });

  pi.registerCommand("btw:thinking", {
    description: "Show, set, or clear the BTW-only thinking override.",
    handler: async (args, ctx) => {
      await dispatchBtwCommand("btw:thinking", args, ctx);
    },
  });
}
