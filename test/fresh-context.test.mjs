import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hostDir, hostDependencyPath } from './host.mjs';

let displayBtwPrompt;
async function loadExtension() {
  const { createJiti } = await import(pathToFileURL(hostDependencyPath('jiti', 'lib/jiti.mjs')));
  const jiti = createJiti(import.meta.url, { fsCache: false, alias: {
    '@earendil-works/pi-tui': hostDependencyPath('@earendil-works/pi-tui', 'dist/index.js'),
    '@earendil-works/pi-coding-agent': path.join(hostDir, 'dist/index.js'),
    '@earendil-works/pi-ai': hostDependencyPath('@earendil-works/pi-ai', 'dist/index.js'),
  } });
  const module = await jiti.import('../extensions/btw.ts');
  displayBtwPrompt = module.displayBtwPrompt;
  return module.default;
}

test('one BTW conversation: earlier turns kept, main progress only appended (sync, autosnap, tool, branch switch)', async () => {
  const extension = await loadExtension();
  const { initTheme, getThemeByName } = await import(pathToFileURL(path.join(hostDir, 'dist/modes/interactive/theme/theme.js')));
  const { createAssistantMessageEventStream } = await import(pathToFileURL(hostDependencyPath('@earendil-works/pi-ai', 'dist/index.js')));
  initTheme('dark', false);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'btw-fresh-context-'));
  const agentDir = path.join(directory, 'agent'); await fs.mkdir(agentDir);
  const savedEnv = Object.fromEntries(['PI_CODING_AGENT_DIR', 'PI_BTW_CONTEXT'].map(key => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = agentDir; delete process.env.PI_BTW_CONTEXT;

  const requests = [];
  let callUpdateTool = false;
  const model = { provider: 'btw-fresh-test', id: 'fixture', name: 'Fixture', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 1024 };
  const provider = { baseUrl: model.baseUrl, api: model.api, apiKey: 'offline-fixture', models: [{ ...model }], streamSimple(model, context) {
    const serialized = JSON.stringify(context.messages);
    requests.push(serialized);
    const last = context.messages[context.messages.length - 1];
    const useTool = callUpdateTool && last?.role === 'user';
    const content = useTool ? [{ type: 'toolCall', id: `upd${requests.length}`, name: 'main_session_update', arguments: {} }] : [{ type: 'text', text: `ANSWER_${requests.length}` }];
    const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: useTool ? 'toolUse' : 'stop', timestamp: Date.now() };
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
  const addMain = (role, text, parentId = leafId) => {
    const id = `main-${mainEntries.length}`;
    const message = role === 'user'
      ? { role, content: [{ type: 'text', text }], timestamp: Date.now() }
      : { role, content: [{ type: 'text', text }], provider: 'main', model: 'main', api: 'openai-completions', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() };
    mainEntries.push({ type: 'message', id, parentId, timestamp: new Date().toISOString(), message });
    leafId = id;
  };
  addMain('user', 'MAIN_BEFORE_FIRST_BTW');
  addMain('assistant', 'MAIN_BEFORE_ANSWER');
  let mainIdle = true;
  const ctx = { hasUI: true, mode: 'rpc', cwd: directory, model, getSystemPrompt: () => '', isIdle: () => mainIdle, isProjectTrusted: () => false,
    sessionManager: { getBranch: () => branch, getEntries: () => mainEntries, getLeafId: () => leafId, getSessionFile: () => undefined },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'offline-fixture' }), getRegisteredNativeProvider: () => undefined, getRegisteredProviderConfig: () => provider, getProviderAuthStatus: () => ({ source: 'models_json_key' }), hasConfiguredAuth: () => true, find: () => model },
    ui: { theme: getThemeByName('dark'), notify: (message, level) => notices.push({ message, level }), setWidget() {} } };

  try {
    await events.get('session_start')({}, ctx);
    await commands.get('btw').handler('Q1', ctx);
    addMain('user', 'MAIN_ROUND_2');
    addMain('assistant', 'MAIN_ROUND_2_ANSWER');
    await commands.get('btw').handler('Q2', ctx);

    // Autosnap off (default): the same conversation continues, the main progress is not swapped in.
    assert.equal(requests.length, 2);
    assert.ok(requests[1].includes('Q1') && requests[1].includes('ANSWER_1'), 'Second question keeps the first exchange');
    assert.ok(requests[1].startsWith(requests[0].slice(0, -1)), 'Earlier turns are an unchanged prefix');
    assert.ok(!requests[1].includes('MAIN_ROUND_2'), 'No automatic update while autosnap is off');
    assert.equal((requests[1].match(/<main-session-snapshot /g) ?? []).length, 1);

    // /btw:sync: the progress is appended once, before the next question.
    await commands.get('btw:sync').handler('', ctx);
    await commands.get('btw').handler('Q3', ctx);
    assert.ok(requests[2].startsWith(requests[1].slice(0, -1)), 'Sync appends, never rewrites');
    const update = requests[2].slice(requests[1].length);
    assert.ok(update.includes('<main-session-update ') && update.includes('MAIN_ROUND_2') && update.includes('MAIN_ROUND_2_ANSWER'));
    assert.ok(update.indexOf('<main-session-update ') < update.indexOf('Q3'), 'Update comes before the question');
    await commands.get('btw').handler('Q4', ctx);
    assert.equal((requests[3].match(/<main-session-update /g) ?? []).length, 1, 'Nothing new: no second update');
    const userQ3 = JSON.parse(requests[2]).filter(m => m.role === 'user').pop().content.map(c => c.text).join('');
    assert.equal(displayBtwPrompt(userQ3), '↻ main session synced\nQ3', 'Pane shows a one-line marker');

    // Autosnap on: updates are appended before each question; saved in btw.json.
    await commands.get('btw:autosnap').handler('on', ctx);
    assert.equal(JSON.parse(await fs.readFile(path.join(agentDir, 'btw.json'), 'utf8')).snapshot.auto, true);
    addMain('user', 'MAIN_ROUND_3');
    mainIdle = false;
    await commands.get('btw').handler('Q5', ctx);
    const auto = requests[4].slice(requests[3].length);
    assert.ok(auto.includes('MAIN_ROUND_3') && auto.includes('main-status=\\"running\\"'), 'Autosnap update with running status');
    mainIdle = true;
    await commands.get('btw:autosnap').handler('off', ctx);

    // The model pulls the update itself with main_session_update.
    addMain('assistant', 'MAIN_ROUND_3_ANSWER');
    callUpdateTool = true;
    await commands.get('btw').handler('Q6', ctx);
    callUpdateTool = false;
    const toolRound = requests[requests.length - 1];
    assert.ok(toolRound.includes('main_session_update') && toolRound.includes('MAIN_ROUND_3_ANSWER'), 'Tool result carries the new progress');
    const afterTool = requests.length;

    // Branch switch: an update cannot be appended, so the next question restarts with earlier exchanges.
    addMain('user', 'MAIN_OTHER_BRANCH', 'main-1');
    await commands.get('btw').handler('Q7', ctx);
    const restarted = requests[afterTool];
    assert.ok(restarted.includes('<btw-earlier-discussion') && restarted.includes('Q1') && restarted.includes('Q6'), 'Earlier exchanges kept');
    assert.ok(restarted.includes('MAIN_OTHER_BRANCH') && !restarted.includes('MAIN_ROUND_3_ANSWER'), 'Fresh snapshot of the new branch');
    assert.ok(restarted.indexOf('<main-session-snapshot ') < restarted.indexOf('<btw-earlier-discussion'), 'Snapshot first, then earlier discussion');

    await commands.get('btw:inject').handler('', ctx);
    assert.equal(handoffs.length, 1);
    for (const kept of ['Q1', 'ANSWER_1', 'Q7']) assert.ok(handoffs[0].message.content.includes(kept), kept);
    assert.ok(!handoffs[0].message.content.includes('<main-session-update'), 'Handoff carries questions, not updates');

    // A tangent gets no main-session context and no update tool.
    await commands.get('btw:tangent').handler('TANGENT_QUESTION', ctx);
    const tangent = requests[requests.length - 1];
    assert.ok(tangent.includes('TANGENT_QUESTION') && !tangent.includes('<main-session-snapshot ') && !tangent.includes('MAIN_ROUND'));
    await commands.get('btw').handler('BACK_TO_CONTEXT', ctx);
    assert.ok(requests[requests.length - 1].includes('<main-session-snapshot '), 'Contextual BTW gets the snapshot again');
    assert.ok(mainEntries.every(e => e.type === 'message'), 'BTW never writes to the main session');
    assert.ok(!notices.some(n => n.level === 'error'), JSON.stringify(notices));
  } finally {
    await events.get('session_shutdown')({}, ctx);
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(directory, { recursive: true, force: true });
  }
});
