import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hostDir, hostDependencyPath } from './host.mjs';

test('lean BTW starts small, compacts a long thread, continues, and hands back all exchanges', async () => {
  const { createJiti } = await import(pathToFileURL(hostDependencyPath('jiti', 'lib/jiti.mjs')));
  const jiti = createJiti(import.meta.url, { fsCache: false, alias: {
    '@earendil-works/pi-tui': hostDependencyPath('@earendil-works/pi-tui', 'dist/index.js'),
    '@earendil-works/pi-coding-agent': path.join(hostDir, 'dist/index.js'),
    '@earendil-works/pi-ai': hostDependencyPath('@earendil-works/pi-ai', 'dist/index.js'),
  } });
  const { default: extension } = await jiti.import('../extensions/btw.ts');
  const { initTheme, getThemeByName } = await import(pathToFileURL(path.join(hostDir, 'dist/modes/interactive/theme/theme.js')));
  const { createAssistantMessageEventStream } = await import(pathToFileURL(hostDependencyPath('@earendil-works/pi-ai', 'dist/index.js')));
  initTheme('dark', false);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'btw-compact-test-'));
  const agentDir = path.join(directory, 'agent'); await fs.mkdir(agentDir);
  const settingsFile = path.join(agentDir, 'settings.json');
  const settingsText = JSON.stringify({ compaction: { enabled: true, reserveTokens: 2000, keepRecentTokens: 1000 } });
  await fs.writeFile(settingsFile, settingsText);
  const savedEnv = Object.fromEntries(['PI_CODING_AGENT_DIR', 'PI_BTW_CONTEXT'].map(key => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = agentDir; delete process.env.PI_BTW_CONTEXT;
  const requests = [];
  let answers = 0;
  const model = { provider: 'btw-compact-test', id: 'fixture', name: 'Fixture', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 14000, maxTokens: 4096 };
  const provider = { baseUrl: model.baseUrl, api: model.api, apiKey: 'offline-fixture', models: [{ ...model }], streamSimple(model, context) {
    const serialized = JSON.stringify(context.messages);
    const compact = [context.systemPrompt ?? '', ...context.messages.filter(m => m.role === 'system').map(m => JSON.stringify(m.content))]
      .some(text => text.includes('You are a context summarization assistant'));
    requests.push({ compact, serialized });
    const text = compact ? 'COMPACTED_BTW_SUMMARY: earlier questions and answers.' : `ANSWER_${++answers} ` + 'x'.repeat(12000);
    const input = Math.ceil((serialized.length + (context.systemPrompt ?? '').length) / 4), output = Math.ceil(text.length / 4);
    const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [{ type: 'text', text }], usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() };
    const stream = createAssistantMessageEventStream();
    setTimeout(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: 'stop', message }); stream.end(message); }, 5);
    return stream;
  } };
  const commands = new Map(), events = new Map(), branch = [], handoffs = [], notices = [];
  extension({ registerCommand: (name, value) => commands.set(name, value), registerShortcut() {}, registerMessageRenderer() {},
    on: (name, handler) => events.set(name, handler), events: { emit() {} }, getThinkingLevel: () => 'off',
    appendEntry: (customType, data) => branch.push({ type: 'custom', customType, data }),
    sendMessage: (message, options) => { if (message.customType === 'btw-handoff') handoffs.push({ message, options }); },
    sendUserMessage() {}, getAllTools: () => [], getCommands: () => [] });
  const mainEntries = [{ type: 'message', id: 'seed', parentId: null, message: { role: 'user', content: [{ type: 'text', text: 'MAIN_SEED' }], timestamp: Date.now() } }];
  const ctx = { hasUI: true, mode: 'rpc', cwd: directory, model, getSystemPrompt: () => '', isIdle: () => true, isProjectTrusted: () => false,
    sessionManager: { getBranch: () => branch, getEntries: () => mainEntries, getLeafId: () => 'seed', getSessionFile: () => undefined },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'offline-fixture' }), getRegisteredNativeProvider: () => undefined, getRegisteredProviderConfig: () => provider, getProviderAuthStatus: () => ({ source: 'models_json_key' }), hasConfiguredAuth: () => true, find: () => model },
    ui: { theme: getThemeByName('dark'), notify: (message, level) => notices.push({ message, level }), setWidget() {} } };
  try {
    await events.get('session_start')({}, ctx);
    await commands.get('btw:ask').handler('QUESTION_1', ctx);
    assert.equal(requests.length, 1, 'Lean first question needs no compaction');
    assert.ok(requests[0].serialized.includes('main-session-excerpt'));
    for (let i = 2; i <= 6; i++) await commands.get('btw:ask').handler(`QUESTION_${i}`, ctx);
    assert.ok(requests.some(r => r.compact), 'Long BTW thread invokes Pi auto-compaction');
    assert.ok(requests.some(r => !r.compact && r.serialized.includes('COMPACTED_BTW_SUMMARY')), 'Later questions use compacted context');
    assert.equal(branch.filter(e => e.customType === 'btw-thread-entry').length, 6);
    await commands.get('btw:inject').handler('', ctx);
    assert.equal(handoffs.length, 1);
    assert.equal(handoffs[0].message.details.exchanges, 6);
    for (let i = 1; i <= 6; i++) {
      assert.ok(handoffs[0].message.content.includes(`QUESTION_${i}`), 'Handoff retains question ' + i);
      assert.ok(handoffs[0].message.content.includes(`ANSWER_${i}`), 'Handoff retains answer ' + i);
    }
    assert.ok(!handoffs[0].message.content.includes('MAIN_SEED'), 'Main context excluded from handoff');
    assert.ok(!notices.some(n => n.level === 'error'), JSON.stringify(notices));
    assert.equal(await fs.readFile(settingsFile, 'utf8'), settingsText, 'Compaction does not rewrite user settings');
    assert.equal(mainEntries.length, 1, 'Parent context unchanged');
  } finally {
    await events.get('session_shutdown')({}, ctx);
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(directory, { recursive: true, force: true });
  }
});
