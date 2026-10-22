import { hostDir as host, hostDependencyPath } from './host.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const tuiDir = hostDependencyPath('@earendil-works/pi-tui', 'dist');
async function loadExtension() {
  const { createJiti } = await import(pathToFileURL(hostDependencyPath('jiti', 'lib/jiti.mjs')));
  const jiti = createJiti(import.meta.url, { fsCache: false, alias: {
    '@earendil-works/pi-tui': path.join(tuiDir, 'index.js'),
    '@earendil-works/pi-coding-agent': path.join(host, 'dist/index.js'),
    '@earendil-works/pi-ai': hostDependencyPath('@earendil-works/pi-ai', 'dist/index.js'),
  } });
  return { btw: await jiti.import('../extensions/btw.ts'), context: await jiti.import('../extensions/btw-context.ts') };
}

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = content => ({ role: 'assistant', content, provider: 'main', model: 'main', api: 'openai-completions', usage, stopReason: 'stop', timestamp: 1 });
const user = text => ({ role: 'user', content: [{ type: 'text', text }], timestamp: 1 });
const toolResult = (id, text) => ({ role: 'toolResult', toolCallId: id, toolName: 'bash', content: [{ type: 'text', text }], isError: false, timestamp: 1 });

/** A main-session context with everything BTW should not copy. */
function mainContext() {
  return [
    { role: 'system', content: 'MAIN_SYSTEM_PROMPT', timestamp: 1 },
    { role: 'compactionSummary', summary: 'MAIN_COMPACTION_SUMMARY', tokensBefore: 1, timestamp: 1 },
    user('第一轮问题'), assistant([{ type: 'text', text: '第一轮回答' }]),
    user('第二轮问题'), assistant([{ type: 'text', text: '第二轮回答' }]),
    user('第三轮问题'),
    assistant([{ type: 'thinking', thinking: 'SECRET_THINKING' }, { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls' } }]),
    toolResult('t1', 'TOOL_OUTPUT_' + 'x'.repeat(20000)),
    assistant([{ type: 'text', text: '第三轮回答' }]),
    { role: 'custom', customType: 'btw-note', content: 'BTW_NOTE_TEXT', display: true, timestamp: 1 },
    user('第四轮：只调工具'),
    assistant([{ type: 'toolCall', id: 't2', name: 'read', arguments: { path: 'a' } }, { type: 'toolCall', id: 't3', name: 'read', arguments: { path: 'b' } }]),
    toolResult('t2', 'TOOL_OUTPUT_2'), toolResult('t3', 'TOOL_OUTPUT_3'),
    user('插话：顺便看看 B'), assistant([{ type: 'text', text: '插话回答' }]),
  ];
}

test('main-session snapshot: task, progress, earlier rounds and summary; no hidden content', async () => {
  const { context: { buildMainSessionSnapshot, clipMiddle, useFullMainContext } } = await loadExtension();
  const snapshot = buildMainSessionSnapshot(mainContext(), { sessionFile: '/sessions/main.jsonl', budgetTokens: 8000 });
  const text = snapshot.text;
  assert.equal(snapshot.totalRounds, 4, 'A user message after tool results is a steer of that round');
  assert.ok(text.startsWith('<main-session-snapshot ') && text.includes('main-status="idle"') && text.includes('compacted="yes"'));
  assert.ok(text.includes('Main transcript (JSONL): /sessions/main.jsonl'));
  // Every round fits, including the ones the old fixed "last 3 rounds" dropped, and the summary.
  for (const kept of ['第一轮问题', '第一轮回答', '第二轮问题', '第三轮回答', '第四轮：只调工具', '插话：顺便看看 B', '插话回答', 'MAIN_COMPACTION_SUMMARY']) {
    assert.ok(text.includes(kept), kept);
  }
  for (const dropped of ['MAIN_SYSTEM_PROMPT', 'SECRET_THINKING', 'TOOL_OUTPUT', 'BTW_NOTE_TEXT']) assert.ok(!text.includes(dropped), dropped);
  assert.ok(text.includes('(1 tool call)') && text.includes('read(path: b) [t3] → ok'), 'A finished round with tool calls reports them');
  assert.ok(snapshot.tokens <= 8000);

  // No session file: says so. Nothing to show: null.
  assert.ok(buildMainSessionSnapshot(mainContext()).text.includes('no transcript file'));
  assert.equal(buildMainSessionSnapshot([{ role: 'system', content: 'x', timestamp: 1 }]), null);

  // A BTW handoff starts a round of its own.
  const withHandoff = buildMainSessionSnapshot([...mainContext(), { role: 'custom', customType: 'btw-handoff', content: 'HANDOFF_BODY', display: true, timestamp: 1 }, assistant([{ type: 'text', text: '收到交回' }])]);
  assert.ok(withHandoff.text.includes('[BTW handoff]\nHANDOFF_BODY') && withHandoff.text.includes('收到交回'));

  assert.equal(clipMiddle('short', 10), 'short');
  assert.equal(useFullMainContext({}), false);
  assert.equal(useFullMainContext({ PI_BTW_CONTEXT: 'full' }), true);
});

test('main-session snapshot: a long running task shows its recorded progress', async () => {
  const { context: { buildMainSessionSnapshot } } = await loadExtension();
  const call = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args });
  const failed = (id, text) => ({ ...toolResult(id, text), isError: true });
  const messages = [
    user('之前的问题'), assistant([{ type: 'text', text: '之前的回答' }]),
    user('LONG_TASK_INSTRUCTION'),
    assistant([{ type: 'text', text: 'STEP_1_PLAN' }, call('c1', 'read', { path: 'src/a.ts' })]),
    toolResult('c1', 'OK_OUTPUT_SHOULD_NOT_APPEAR'),
    assistant([{ type: 'text', text: 'STEP_2_FOUND_BUG' }, call('c2', 'bash', { command: 'npm test' })]),
    failed('c2', 'TEST_FAILURE_LINE\nmore failure detail SHOULD_NOT_APPEAR'),
    user('STEER_FOLLOW_UP'),
    assistant([{ type: 'text', text: 'STEP_3_FIXING' }, call('c3', 'bash', { command: 'npm run build' })]),
  ];
  const running = buildMainSessionSnapshot(messages, { mainRunning: true, sessionFile: '/s.jsonl' });
  const text = running.text;
  assert.ok(text.includes('main-status="running"') && text.includes('## Current task'));
  assert.ok(text.includes('LONG_TASK_INSTRUCTION') && text.includes('STEER_FOLLOW_UP'), 'Instruction and steer');
  const order = ['STEP_1_PLAN', 'read(path: src/a.ts) [c1] → ok', 'STEP_2_FOUND_BUG', 'bash(command: npm test) [c2] → ERROR: TEST_FAILURE_LINE', 'STEP_3_FIXING', 'bash(command: npm run build) [c3] → waiting for result'];
  let at = -1;
  for (const item of order) { const next = text.indexOf(item); assert.ok(next > at, `${item} in order`); at = next; }
  assert.ok(text.includes('3 tool calls, 1 failed, 1 without result') && text.includes('Now: still working'));
  assert.ok(!text.includes('SHOULD_NOT_APPEAR'), 'No tool output beyond the first error line');
  assert.ok(text.includes('之前的问题') && text.includes('之前的回答'), 'Earlier round');

  // Many steps over a tight budget: the first steps and the newest progress survive.
  const many = [user('BIG_TASK')];
  for (let i = 1; i <= 200; i++) {
    many.push(assistant([{ type: 'text', text: `STEP_${i}_` + '说明'.repeat(100) }, call(`k${i}`, 'bash', { command: `cmd ${i}` })]), toolResult(`k${i}`, 'x'.repeat(5000)));
  }
  const tight = buildMainSessionSnapshot(many, { mainRunning: true, budgetTokens: 3000 });
  assert.ok(tight.tokens <= 3000, `${tight.tokens} tokens`);
  assert.ok(tight.text.includes('BIG_TASK') && tight.text.includes('STEP_1_') && tight.text.includes('STEP_200_') && tight.text.includes('[k200]'));
  assert.ok(tight.omitted.progressItems > 0 && tight.text.includes('items omitted; see the main transcript'));

  // Compacted mid-turn: the request went into the summary, the later work is still shown as progress.
  const midTurn = buildMainSessionSnapshot([
    { role: 'compactionSummary', summary: '## Goal\nMID_TURN_GOAL', tokensBefore: 1, timestamp: 1 },
    assistant([{ type: 'text', text: 'AFTER_COMPACTION_STEP' }, call('m1', 'bash', { command: 'make' })]),
  ], { mainRunning: true });
  for (const kept of ['Started before the latest compaction', 'AFTER_COMPACTION_STEP', '[m1] → waiting for result', 'MID_TURN_GOAL']) assert.ok(midTurn.text.includes(kept), kept);
});

test('main-session snapshot: existing compaction summary is trimmed by priority, never regenerated', async () => {
  const { context: { buildMainSessionSnapshot, computeSnapshotBudgetTokens } } = await loadExtension();
  const summary = [
    '## Goal\nGOAL_TEXT', '## Constraints & Preferences\n' + 'c'.repeat(3000), '## Progress\n### Done\nDONE_TEXT\n### In Progress\nIN_PROGRESS_TEXT',
    '## Blocked\nBLOCKED_TEXT', '## Key Decisions\n' + 'd'.repeat(2000), '## Next Steps\nNEXT_TEXT', '## Critical Context\n' + 'z'.repeat(40000),
    '<read-files>\nREAD_FILE_LIST\n</read-files>', '<modified-files>\nMODIFIED_FILE_LIST\n</modified-files>',
  ].join('\n\n');
  const messages = [{ role: 'compactionSummary', summary, tokensBefore: 1, timestamp: 1 }];
  for (let i = 0; i < 4; i++) messages.push(user(`AFTER_COMPACTION_${i}`), assistant([{ type: 'text', text: `AFTER_ANSWER_${i}` }]));
  const snapshot = buildMainSessionSnapshot(messages, { budgetTokens: 3000 });
  assert.ok(snapshot.tokens <= 3000, `${snapshot.tokens}`);
  for (const kept of ['GOAL_TEXT', 'DONE_TEXT', 'IN_PROGRESS_TEXT', 'BLOCKED_TEXT', 'NEXT_TEXT', 'AFTER_COMPACTION_0', 'AFTER_COMPACTION_3', 'AFTER_ANSWER_3']) assert.ok(snapshot.text.includes(kept), kept);
  for (const dropped of ['READ_FILE_LIST', 'MODIFIED_FILE_LIST']) assert.ok(!snapshot.text.includes(dropped), dropped);
  assert.ok(snapshot.omitted.summarySections > 0 && /summary (sections omitted|trimmed to fit)/.test(snapshot.text));

  // Budget: 60% of what is left, at least 1.5k, never more than what is left; no fixed ceiling.
  assert.equal(computeSnapshotBudgetTokens({ contextWindow: 1_000_000, reserveTokens: 16384, fixedTokens: 5000 }), 585969);
  assert.equal(computeSnapshotBudgetTokens({ contextWindow: 1_000_000, reserveTokens: 16384, fixedTokens: 5000, maxTokens: 1_000_000 }), 585969, 'Main window as ceiling');
  assert.equal(computeSnapshotBudgetTokens({ contextWindow: 32000, reserveTokens: 16384, fixedTokens: 4000 }), 5769);
  assert.equal(computeSnapshotBudgetTokens({ contextWindow: 24000, reserveTokens: 16384, fixedTokens: 4600 }), 1016);
  assert.equal(computeSnapshotBudgetTokens({ contextWindow: 8000, reserveTokens: 16384 }), 500, 'No room: a minimal status snapshot');
  assert.equal(computeSnapshotBudgetTokens({}), 8000);
  // Configurable share and ceiling.
  assert.equal(computeSnapshotBudgetTokens({ contextWindow: 200_000, reserveTokens: 16384, fixedTokens: 5000, share: 0.5, maxTokens: 50_000 }), 50000);
  assert.equal(computeSnapshotBudgetTokens({ contextWindow: 64000, reserveTokens: 16384, fixedTokens: 5000, share: 0.5, maxTokens: 50_000 }), 20308);
  const { context: { snapshotBudgetSettings } } = await loadExtension();
  assert.deepEqual(snapshotBudgetSettings({}, {}), { share: 0.6 }, 'Defaults: 60%, ceiling = main window');
  for (const share of [0.5, 50, '50%', '0.5']) assert.equal(snapshotBudgetSettings({ share }, {}).share, 0.5, String(share));
  assert.equal(snapshotBudgetSettings({ maxTokens: '24k' }, {}).maxTokens, 24000);
  assert.deepEqual(snapshotBudgetSettings({ share: 0.5, maxTokens: 24000 }, { PI_BTW_SNAPSHOT_SHARE: '30%', PI_BTW_SNAPSHOT_MAX_TOKENS: '16k' }), { share: 0.3, maxTokens: 16000 }, 'Env wins');
  assert.deepEqual(snapshotBudgetSettings({ share: 'abc', maxTokens: -1 }, {}), { share: 0.6 }, 'Invalid values are ignored');
  assert.deepEqual(snapshotBudgetSettings({ share: 0.99, maxTokens: 10 }, {}), { share: 0.9, maxTokens: 1500 }, 'Clamped');
});

test('BTW child settings: lean/full both inherit compaction settings without writing files', async () => {
  const { btw: { createBtwSettingsManager } } = await loadExtension();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'btw-settings-'));
  const agentDir = path.join(dir, 'agent'); await fs.mkdir(agentDir);
  const settingsFile = path.join(agentDir, 'settings.json');
  const original = JSON.stringify({ compaction: { enabled: true, reserveTokens: 1234 } }, null, 2);
  await fs.writeFile(settingsFile, original);
  const saved = process.env.PI_BTW_CONTEXT;
  try {
    delete process.env.PI_BTW_CONTEXT;
    const lean = createBtwSettingsManager(dir, agentDir);
    assert.equal(lean.getCompactionEnabled(), true);
    assert.equal(lean.getCompactionSettings().reserveTokens, 1234, 'Other user settings are kept');
    await lean.flush?.();
    assert.equal(await fs.readFile(settingsFile, 'utf8'), original);
    process.env.PI_BTW_CONTEXT = 'full';
    assert.equal(createBtwSettingsManager(dir, agentDir).getCompactionEnabled(), true);
    await fs.writeFile(settingsFile, JSON.stringify({ compaction: { enabled: false } }));
    for (const mode of ['lean', 'full']) {
      process.env.PI_BTW_CONTEXT = mode;
      assert.equal(createBtwSettingsManager(dir, agentDir).getCompactionEnabled(), false, 'Explicit user opt-out is respected');
    }
    await fs.unlink(settingsFile);
    delete process.env.PI_BTW_CONTEXT;
    assert.equal(createBtwSettingsManager(dir, agentDir).getCompactionEnabled(), true, 'Pi default is on');
  } finally {
    if (saved === undefined) delete process.env.PI_BTW_CONTEXT; else process.env.PI_BTW_CONTEXT = saved;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('real BTW session: budgeted snapshot by default, no compaction on a near-full main session; full mode A/B', async () => {
  const { btw, context } = await loadExtension();
  const extension = btw.default;
  const { initTheme, getThemeByName } = await import(pathToFileURL(path.join(host, 'dist/modes/interactive/theme/theme.js')));
  initTheme('dark', false);
  const { createAssistantMessageEventStream } = await import(pathToFileURL(hostDependencyPath('@earendil-works/pi-ai', 'dist/index.js')));

  // Small window: the full main context (~25k tokens of tool output) crosses the compaction threshold.
  const mockModel = { provider: 'btw-offline-test', id: 'fixture', name: 'Fixture', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 };
  const requests = [];
  const providerConfig = { baseUrl: mockModel.baseUrl, api: mockModel.api, apiKey: 'offline-fixture', models: [{ ...mockModel }], streamSimple(model, context) {
    const serialized = JSON.stringify(context.messages) + '\n' + (context.systemPrompt ?? '');
    requests.push(serialized);
    const stream = createAssistantMessageEventStream();
    // Report realistic input usage so Pi's threshold compaction sees how full the context is.
    const input = Math.ceil(serialized.length / 4);
    const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [{ type: 'text', text: '离线回答 ' + requests.length }], usage: { ...usage, input, totalTokens: input + 1 }, stopReason: 'stop', timestamp: Date.now() };
    setTimeout(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: 'stop', message }); stream.end(message); }, 5);
    return stream;
  } };
  const main = mainContext();
  main.splice(8, 1, toolResult('t1', 'TOOL_OUTPUT_' + 'x'.repeat(100000)));
  // A real compaction entry with a long summary, then a task still running with many steps.
  const longSummary = ['## Goal\nSUMMARY_GOAL', '## Progress\nSUMMARY_PROGRESS', '## Critical Context\n' + '细节'.repeat(30000)].join('\n\n');
  const running = [user('RUNNING_TASK')];
  for (let i = 1; i <= 60; i++) {
    running.push(assistant([{ type: 'text', text: `RUN_STEP_${i} ` + '进展'.repeat(200) }, { type: 'toolCall', id: `r${i}`, name: 'bash', arguments: { command: `step ${i}` } }]));
    if (i < 60) running.push(toolResult(`r${i}`, 'RUN_OUTPUT_' + 'y'.repeat(5000)));
  }
  let parentId = null;
  const entries = [];
  const add = (entry) => { entries.push({ ...entry, id: `e${entries.length}`, parentId, timestamp: new Date().toISOString() }); parentId = entries.at(-1).id; };
  for (const message of main.filter(m => m.role !== 'compactionSummary')) add({ type: 'message', message });
  add({ type: 'compaction', summary: longSummary, firstKeptEntryId: entries.at(-2).id, tokensBefore: 100000 });
  for (const message of running) add({ type: 'message', message });

  // A temporary agent dir: the user's real btw.json and settings must not change the result.
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'btw-context-agent-'));
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  async function ask(mode, btwConfig) {
    if (btwConfig) await fs.writeFile(path.join(agentDir, 'btw.json'), JSON.stringify(btwConfig));
    else await fs.rm(path.join(agentDir, 'btw.json'), { force: true });
    const commands = new Map(), events = new Map(), notices = [];
    extension({ registerCommand: (name, value) => commands.set(name, value), registerShortcut() {}, registerMessageRenderer() {},
      on: (name, value) => events.set(name, value), events: { emit() {} }, getThinkingLevel: () => 'off',
      appendEntry() {}, sendMessage() {}, sendUserMessage() {}, getAllTools: () => [], getCommands: () => [] });
    const ctx = { hasUI: true, mode: 'rpc', cwd: '/tmp', model: mockModel, getSystemPrompt: () => 'PARENT_PROMPT ' + 'p'.repeat(12000), isIdle: () => false, isProjectTrusted: () => false,
      sessionManager: { getBranch: () => [], getEntries: () => entries, getLeafId: () => parentId, getSessionFile: () => '/sessions/main.jsonl' },
      modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'offline-fixture' }), getRegisteredNativeProvider: () => undefined, getRegisteredProviderConfig: () => providerConfig, getProviderAuthStatus: () => ({ source: 'models_json_key' }), hasConfiguredAuth: () => true, find: () => mockModel },
      ui: { theme: getThemeByName('dark'), notify: (message, level) => notices.push({ message, level }), setWidget() {} } };
    const saved = process.env.PI_BTW_CONTEXT;
    if (mode === 'full') process.env.PI_BTW_CONTEXT = 'full'; else delete process.env.PI_BTW_CONTEXT;
    const before = requests.length;
    try {
      await events.get('session_start')({}, ctx);
      await commands.get('btw:ask').handler('旁路问题', ctx);
      return { calls: requests.slice(before), notices };
    } finally {
      await events.get('session_shutdown')({}, ctx);
      if (saved === undefined) delete process.env.PI_BTW_CONTEXT; else process.env.PI_BTW_CONTEXT = saved;
    }
  }

  const lean = await ask('lean');
  assert.equal(lean.calls.length, 1, 'One model call: no compaction before answering');
  const request = lean.calls[0];
  assert.ok(request.includes('main-session-snapshot') && request.includes('main-status=\\"running\\"') && request.includes('旁路问题'));
  for (const kept of ['SUMMARY_GOAL', 'SUMMARY_PROGRESS', 'RUNNING_TASK', 'RUN_STEP_1 ', 'RUN_STEP_60 ', '[r60] → waiting for result']) assert.ok(request.includes(kept), kept);
  assert.ok(request.includes('/sessions/main.jsonl'));
  assert.ok(!request.includes('TOOL_OUTPUT') && !request.includes('RUN_OUTPUT') && !request.includes('MAIN_SYSTEM_PROMPT') && !request.includes('SECRET_THINKING'));
  const snapshotText = JSON.parse(request.slice(0, request.lastIndexOf('\n')))[0].content[0].text;
  const budget = context.computeSnapshotBudgetTokens({ contextWindow: 32000, reserveTokens: 16384, fixedTokens: context.estimateTextTokens('PARENT_PROMPT ' + 'p'.repeat(12000)) + context.estimateTextTokens(btw.BTW_SYSTEM_PROMPT) + context.BTW_TOOL_SCHEMA_TOKENS });
  assert.ok(context.estimateTextTokens(snapshotText) <= budget, `snapshot ${context.estimateTextTokens(snapshotText)} > ${budget}`);
  assert.ok(!lean.notices.some(n => n.level === 'error'), JSON.stringify(lean.notices));

  // Old behavior for comparison: the whole main context, which this window cannot hold.
  const full = await ask('full');
  assert.ok(full.calls.some(call => call.includes('RUN_OUTPUT')), 'Full mode copies tool output');
  assert.ok(full.calls.length > 1 || full.notices.some(n => n.level === 'error'),
    `Full mode compacts or overflows: ${full.calls.length} calls, ${JSON.stringify(full.notices)}`);
  if (process.env.PI_BTW_TEST_VERBOSE) console.log(JSON.stringify({ leanCalls: lean.calls.length, leanChars: request.length, fullCalls: full.calls.length, fullChars: full.calls.map(c => c.length) }));

  // btw.json snapshot.share 25%: a smaller snapshot within its budget, still one call.
  const quarter = await ask('lean', { snapshot: { share: '25%' } });
  assert.equal(quarter.calls.length, 1, '25% share still answers without compaction');
  const quarterSnapshot = JSON.parse(quarter.calls[0].slice(0, quarter.calls[0].lastIndexOf('\n')))[0].content[0].text;
  const quarterBudget = context.computeSnapshotBudgetTokens({ contextWindow: 32000, reserveTokens: 16384, fixedTokens: context.estimateTextTokens('PARENT_PROMPT ' + 'p'.repeat(12000)) + context.estimateTextTokens(btw.BTW_SYSTEM_PROMPT) + context.BTW_TOOL_SCHEMA_TOKENS, share: 0.25 });
  assert.ok(quarterBudget < budget && context.estimateTextTokens(quarterSnapshot) <= quarterBudget);
  assert.ok(context.estimateTextTokens(quarterSnapshot) < context.estimateTextTokens(snapshotText), 'Smaller share gives a smaller snapshot');
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  await fs.rm(agentDir, { recursive: true, force: true });
});
