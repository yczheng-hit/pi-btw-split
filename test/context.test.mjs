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

test('main-session excerpt: last 3 rounds of messages and text answers only', async () => {
  const { context: { buildMainSessionExcerpt, clipMiddle, useFullMainContext } } = await loadExtension();
  const excerpt = buildMainSessionExcerpt(mainContext(), { sessionFile: '/sessions/main.jsonl' });
  const text = excerpt.text;
  assert.equal(excerpt.rounds, 3); assert.equal(excerpt.totalRounds, 5);
  assert.ok(text.startsWith('<main-session-excerpt rounds="3" total-rounds="5">'));
  assert.ok(text.includes('Full main-session transcript (JSONL): /sessions/main.jsonl'));
  for (const kept of ['第三轮问题', '第三轮回答', '第四轮：只调工具', '插话：顺便看看 B', '插话回答']) assert.ok(text.includes(kept), kept);
  for (const dropped of ['第一轮', '第二轮', 'MAIN_SYSTEM_PROMPT', 'MAIN_COMPACTION_SUMMARY', 'SECRET_THINKING', 'TOOL_OUTPUT', 'BTW_NOTE_TEXT']) {
    assert.ok(!text.includes(dropped), dropped);
  }
  assert.ok(text.includes('(1 tool call omitted)') && text.includes('(2 tool calls omitted)'));
  assert.ok(text.includes('Assistant:\n(no text answer)'), 'Tools-only round');
  assert.ok(text.length < 1500, `excerpt stays small: ${text.length}`);

  // No session file (in-memory main session): no transcript line. No user rounds: no excerpt.
  assert.ok(!buildMainSessionExcerpt(mainContext()).text.includes('transcript'));
  assert.equal(buildMainSessionExcerpt([{ role: 'system', content: 'x', timestamp: 1 }]), null);

  // A BTW handoff starts a round of its own.
  const withHandoff = buildMainSessionExcerpt([...mainContext(), { role: 'custom', customType: 'btw-handoff', content: 'HANDOFF_BODY', display: true, timestamp: 1 }, assistant([{ type: 'text', text: '收到交回' }])]);
  assert.ok(withHandoff.text.includes('[BTW handoff]\nHANDOFF_BODY') && withHandoff.text.includes('收到交回'));

  // Limits: long messages keep head and tail; the whole excerpt has a ceiling.
  const long = buildMainSessionExcerpt([user('HEAD' + 'a'.repeat(20000) + 'TAIL'), assistant([{ type: 'text', text: 'b'.repeat(20000) }])]);
  assert.ok(long.text.includes('HEAD') && long.text.includes('TAIL') && long.text.includes('characters omitted'));
  assert.ok(long.text.length < 13000);
  const capped = buildMainSessionExcerpt(Array.from({ length: 3 }, (_, i) => [user(`U${i}` + 'u'.repeat(5000)), assistant([{ type: 'text', text: `A${i}` + 'v'.repeat(5000) }])]).flat(), { maxTotalChars: 12000 });
  assert.ok(capped.text.length <= 12000, String(capped.text.length));
  assert.ok(capped.text.includes('U2') && capped.text.includes('A2'), 'Newest round survives the ceiling');
  assert.equal(clipMiddle('short', 10), 'short');

  assert.equal(useFullMainContext({}), false);
  assert.equal(useFullMainContext({ PI_BTW_CONTEXT: 'full' }), true);
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

test('real BTW session: lean excerpt by default, no compaction on a near-full main session; full mode A/B', async () => {
  const { btw: { default: extension } } = await loadExtension();
  const { initTheme, getThemeByName } = await import(pathToFileURL(path.join(host, 'dist/modes/interactive/theme/theme.js')));
  initTheme('dark', false);
  const { createAssistantMessageEventStream } = await import(pathToFileURL(hostDependencyPath('@earendil-works/pi-ai', 'dist/index.js')));

  // Small window: the full main context (~25k tokens of tool output) would not fit.
  const mockModel = { provider: 'btw-offline-test', id: 'fixture', name: 'Fixture', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 24000, maxTokens: 1024 };
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
  let parentId = null;
  const entries = main.filter(m => m.role !== 'compactionSummary').map((message, i) => {
    const entry = { type: 'message', id: `e${i}`, parentId, timestamp: new Date().toISOString(), message };
    parentId = entry.id; return entry;
  });

  async function ask(mode) {
    const commands = new Map(), events = new Map(), notices = [];
    extension({ registerCommand: (name, value) => commands.set(name, value), registerShortcut() {}, registerMessageRenderer() {},
      on: (name, value) => events.set(name, value), events: { emit() {} }, getThinkingLevel: () => 'off',
      appendEntry() {}, sendMessage() {}, sendUserMessage() {}, getAllTools: () => [], getCommands: () => [] });
    const ctx = { hasUI: true, mode: 'rpc', cwd: '/tmp', model: mockModel, getSystemPrompt: () => 'PARENT_PROMPT', isIdle: () => true, isProjectTrusted: () => false,
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
  assert.ok(request.includes('main-session-excerpt') && request.includes('插话：顺便看看 B') && request.includes('旁路问题'));
  assert.ok(request.includes('/sessions/main.jsonl'));
  assert.ok(!request.includes('TOOL_OUTPUT') && !request.includes('MAIN_SYSTEM_PROMPT') && !request.includes('SECRET_THINKING'));
  assert.ok(request.length < 20000, `lean request ${request.length} chars`);
  assert.ok(!lean.notices.some(n => n.level === 'error'), JSON.stringify(lean.notices));

  // Old behavior for comparison: the whole main context, which this window cannot hold.
  const full = await ask('full');
  assert.ok(full.calls.some(call => call.includes('TOOL_OUTPUT')), 'Full mode copies tool output');
  assert.ok(full.calls.length > 1 || full.notices.some(n => n.level === 'error'),
    `Full mode compacts or overflows: ${full.calls.length} calls, ${JSON.stringify(full.notices)}`);
  if (process.env.PI_BTW_TEST_VERBOSE) console.log(JSON.stringify({ leanCalls: lean.calls.length, leanChars: request.length, fullCalls: full.calls.length, fullChars: full.calls.map(c => c.length) }));
});
