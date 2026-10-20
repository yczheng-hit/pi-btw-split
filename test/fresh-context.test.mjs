import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hostDir, hostDependencyPath } from './host.mjs';

async function loadExtension() {
  const { createJiti } = await import(pathToFileURL(hostDependencyPath('jiti', 'lib/jiti.mjs')));
  const jiti = createJiti(import.meta.url, { fsCache: false, alias: {
    '@earendil-works/pi-tui': hostDependencyPath('@earendil-works/pi-tui', 'dist/index.js'),
    '@earendil-works/pi-coding-agent': path.join(hostDir, 'dist/index.js'),
    '@earendil-works/pi-ai': hostDependencyPath('@earendil-works/pi-ai', 'dist/index.js'),
  } });
  return (await jiti.import('../extensions/btw.ts')).default;
}

test('each contextual BTW question sees the latest main session, not old BTW answers', async () => {
  const extension = await loadExtension();
  const { initTheme, getThemeByName } = await import(pathToFileURL(path.join(hostDir, 'dist/modes/interactive/theme/theme.js')));
  const { createAssistantMessageEventStream } = await import(pathToFileURL(hostDependencyPath('@earendil-works/pi-ai', 'dist/index.js')));
  initTheme('dark', false);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'btw-fresh-context-'));
  const agentDir = path.join(directory, 'agent'); await fs.mkdir(agentDir);
  const savedEnv = Object.fromEntries(['PI_CODING_AGENT_DIR', 'PI_BTW_CONTEXT'].map(key => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = agentDir; delete process.env.PI_BTW_CONTEXT;

  const requests = [];
  const model = { provider: 'btw-fresh-test', id: 'fixture', name: 'Fixture', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 1024 };
  const provider = { baseUrl: model.baseUrl, api: model.api, apiKey: 'offline-fixture', models: [{ ...model }], streamSimple(model, context) {
    const serialized = JSON.stringify(context.messages);
    requests.push(serialized);
    const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [{ type: 'text', text: `OLD_ANSWER_${requests.length}` }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() };
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
  const mainEntries = [];
  let leafId = null;
  const addMain = (role, text) => {
    const id = `main-${mainEntries.length}`;
    const message = role === 'user'
      ? { role, content: [{ type: 'text', text }], timestamp: Date.now() }
      : { role, content: [{ type: 'text', text }], provider: 'main', model: 'main', api: 'openai-completions', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() };
    mainEntries.push({ type: 'message', id, parentId: leafId, timestamp: new Date().toISOString(), message });
    leafId = id;
  };
  addMain('user', 'MAIN_BEFORE_FIRST_BTW');
  addMain('assistant', 'MAIN_BEFORE_ANSWER');
  const ctx = { hasUI: true, mode: 'rpc', cwd: directory, model, getSystemPrompt: () => '', isIdle: () => true, isProjectTrusted: () => false,
    sessionManager: { getBranch: () => branch, getEntries: () => mainEntries, getLeafId: () => leafId, getSessionFile: () => undefined },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'offline-fixture' }), getRegisteredNativeProvider: () => undefined, getRegisteredProviderConfig: () => provider, getProviderAuthStatus: () => ({ source: 'models_json_key' }), hasConfiguredAuth: () => true, find: () => model },
    ui: { theme: getThemeByName('dark'), notify: (message, level) => notices.push({ message, level }), setWidget() {} } };

  try {
    await events.get('session_start')({}, ctx);
    await commands.get('btw').handler('OLD_BTW_QUESTION', ctx);
    addMain('user', 'MAIN_AFTER_FIRST_BTW');
    addMain('assistant', 'MAIN_AFTER_ANSWER');
    await commands.get('btw').handler('NEW_BTW_QUESTION', ctx);

    assert.equal(requests.length, 2);
    assert.ok(requests[1].includes('MAIN_AFTER_FIRST_BTW') && requests[1].includes('MAIN_AFTER_ANSWER'), 'Second BTW sees the latest main session');
    for (const old of ['OLD_BTW_QUESTION', 'OLD_ANSWER_1']) assert.ok(!requests[1].includes(old), `Second BTW must not include ${old}`);
    assert.equal(branch.filter(e => e.customType === 'btw-thread-entry').length, 2, 'Visible BTW history keeps both exchanges');

    await commands.get('btw:inject').handler('', ctx);
    assert.equal(handoffs.length, 1);
    for (const kept of ['OLD_BTW_QUESTION', 'OLD_ANSWER_1', 'NEW_BTW_QUESTION', 'OLD_ANSWER_2']) assert.ok(handoffs[0].message.content.includes(kept), kept);
    assert.ok(!notices.some(n => n.level === 'error'), JSON.stringify(notices));
  } finally {
    await events.get('session_shutdown')({}, ctx);
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(directory, { recursive: true, force: true });
  }
});
