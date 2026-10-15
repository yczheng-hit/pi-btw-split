import { hostDir as host, hostDependencyPath } from './host.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Headless (rpc-like) host: real extension + real BTW AgentSession + local in-memory provider.
test('BTW handoff: labelled message; summary clears at once and resends from cache; inject kept until delivered', async () => {
  const tuiDir = hostDependencyPath('@earendil-works/pi-tui', 'dist');
  const { createJiti } = await import(pathToFileURL(hostDependencyPath('jiti', 'lib/jiti.mjs')));
  const jiti = createJiti(import.meta.url, { fsCache: false, alias: {
    '@earendil-works/pi-tui': path.join(tuiDir, 'index.js'),
    '@earendil-works/pi-coding-agent': path.join(host, 'dist/index.js'),
    '@earendil-works/pi-ai': hostDependencyPath('@earendil-works/pi-ai', 'dist/index.js'),
  } });
  const { default: extension, buildBtwHandoffContent, extractBtwHandoffBody, isBtwHandoffInBranch } = await jiti.import('../extensions/btw.ts');
  const { initTheme, getThemeByName } = await import(pathToFileURL(path.join(host, 'dist/modes/interactive/theme/theme.js')));
  initTheme('dark', false);
  const { stripTerminalSequences } = await import(pathToFileURL(path.join(tuiDir, 'index.js')));
  const { createAssistantMessageEventStream } = await import(pathToFileURL(hostDependencyPath('@earendil-works/pi-ai', 'dist/index.js')));

  // Pure helpers.
  const content = buildBtwHandoffContent('summary', '要点 A\n要点 B', 2, '关注风险');
  assert.ok(content.startsWith('<btw-handoff kind="summary" exchanges="2" initiated-by="user">'));
  assert.ok(content.includes('/btw:summarize') && content.includes('User instructions for this handoff: 关注风险'));
  assert.equal(extractBtwHandoffBody(content), '要点 A\n要点 B');
  assert.equal(isBtwHandoffInBranch([{ type: 'custom_message', customType: 'btw-handoff', details: { id: 'x' } }], 'x'), true);
  assert.equal(isBtwHandoffInBranch([{ type: 'custom', customType: 'btw-handoff', data: { id: 'x' } }], 'x'), false);

  const requests = [];
  const mockModel = { provider: 'btw-offline-test', id: 'fixture', name: 'Fixture', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 4096 };
  const providerConfig = { baseUrl: mockModel.baseUrl, api: mockModel.api, apiKey: 'offline-fixture', models: [{ ...mockModel }], streamSimple(model) {
    requests.push(model.id);
    const stream = createAssistantMessageEventStream();
    const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [{ type: 'text', text: '离线摘要 ' + requests.length }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() };
    setTimeout(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: 'stop', message }); stream.end(message); }, 10);
    return stream;
  } };

  const threadEntry = { type: 'custom', customType: 'btw-thread-entry', data: { question: '旁路问题', thinking: '', answer: '旁路回答', provider: mockModel.provider, model: mockModel.id, api: mockModel.api, thinkingLevel: 'off', timestamp: 1 } };
  let branch = [threadEntry];
  const commands = new Map(), events = new Map(), renderers = new Map(), sent = [], notices = [];
  extension({ registerCommand: (name, value) => commands.set(name, value), registerShortcut() {}, registerMessageRenderer: (type, render) => renderers.set(type, render),
    on: (name, value) => events.set(name, value), events: { emit() {} }, getThinkingLevel: () => 'off',
    appendEntry: (customType, data) => branch.push({ type: 'custom', customType, data }),
    // Non-TUI BTW answers also send visible btw-note messages; only handoffs are tracked here.
    sendMessage: (message, options) => { if (message.customType === 'btw-handoff') sent.push({ message, options }); },
    sendUserMessage: () => assert.fail('Handoffs must not impersonate the user') });
  let idle = true;
  const seed = { id: 'seed', parentId: null, type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'MAIN' }], timestamp: 1 } };
  const ctx = { hasUI: true, mode: 'rpc', cwd: '/tmp', model: mockModel, getSystemPrompt: () => '', isIdle: () => idle, isProjectTrusted: () => false,
    sessionManager: { getBranch: () => branch, getEntries: () => [seed], getLeafId: () => 'seed', getSessionFile: () => undefined },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'offline-fixture' }), getRegisteredNativeProvider: () => undefined, getRegisteredProviderConfig: () => providerConfig, getProviderAuthStatus: () => ({ source: 'models_json_key' }), hasConfiguredAuth: () => true, find: () => mockModel },
    ui: { theme: getThemeByName('dark'), notify: (message, level) => notices.push({ message, level }), setWidget() {} } };
  const waitUntil = async (predicate, what) => {
    const deadline = Date.now() + 5000;
    while (!predicate()) { if (Date.now() > deadline) assert.fail(`${what}: ${JSON.stringify(notices)}`); await new Promise(r => setTimeout(r, 20)); }
  };
  const resets = () => branch.filter(e => e.customType === 'btw-thread-reset').length;
  try {
    await events.get('session_start')({}, ctx);

    // The main-context filter drops visible BTW notes but must keep handoffs.
    const filtered = await events.get('context')({ messages: [{ role: 'custom', customType: 'btw-handoff', content: 'x' }, { role: 'custom', customType: 'btw-note', content: 'y' }] });
    assert.deepEqual(filtered.messages.map(m => m.customType), ['btw-handoff']);

    // 1. Busy main session: labelled custom message, steered; the summary clears the thread at once.
    idle = false;
    await commands.get('btw:summarize').handler('关注风险', ctx);
    assert.equal(sent.length, 1);
    const first = sent[0];
    assert.deepEqual(first.options, { triggerTurn: true, deliverAs: 'steer' });
    assert.equal(first.message.customType, 'btw-handoff'); assert.equal(first.message.display, true);
    assert.equal(first.message.details.kind, 'summary'); assert.equal(first.message.details.exchanges, 1);
    assert.ok(first.message.content.startsWith('<btw-handoff kind="summary" exchanges="1"'));
    assert.ok(first.message.content.includes('User instructions for this handoff: 关注风险'));
    assert.ok(/离线摘要 \d/.test(first.message.content));
    assert.equal(resets(), 1, 'A summary clears the BTW thread as soon as it exists');
    assert.equal(branch.find(e => e.customType === 'btw-handoff-pending').data.threadCleared, true);
    assert.ok(notices.some(n => n.message.includes('queued; the main agent sees it at its next step')));
    const modelCalls = requests.length;

    // New BTW questions run while the summary is in flight; a second handoff waits.
    await commands.get('btw').handler('新问题', ctx);
    assert.equal(requests.length, modelCalls + 1, 'New question runs during a pending summary');
    await commands.get('btw:inject').handler('', ctx);
    assert.equal(sent.length, 1);
    assert.ok(notices.some(n => n.message.includes('is still on its way to the main session')));
    const restartBranch = [...branch];
    const callsAfterQuestion = requests.length;

    // 2. Dropped (Escape clears Pi's queue): the main session settles without it → saved, warned.
    idle = true;
    await events.get('agent_settled')({ type: 'agent_settled', aborted: true }, ctx);
    await waitUntil(() => notices.some(n => n.level === 'warning' && n.message.includes('The summary is saved')), 'undelivered warning');
    assert.equal(resets(), 1, 'No further reset');

    // 3. Resend: cached summary even though the thread now holds a new question; no model call.
    await commands.get('btw:summarize').handler('', ctx);
    assert.equal(sent.length, 2); assert.equal(requests.length, callsAfterQuestion, 'Resend reuses the summary');
    assert.equal(sent[1].message.content, first.message.content, 'No instructions: original instructions kept');
    assert.notEqual(sent[1].message.details.id, first.message.details.id);
    assert.deepEqual(sent[1].options, { triggerTurn: true });
    branch.push({ type: 'custom_message', customType: 'btw-handoff', content: sent[1].message.content, display: true, details: sent[1].message.details });
    await events.get('agent_settled')({ type: 'agent_settled', aborted: false }, ctx);
    await waitUntil(() => notices.some(n => n.message.includes('Handed BTW summary (1 exchange) to the main session.')), 'delivered notice');
    assert.equal(resets(), 1, 'Delivery of a summary does not clear questions asked since');

    // 3b. Inject keeps its thread until delivered and blocks new questions meanwhile.
    await commands.get('btw:inject').handler('', ctx);
    assert.equal(sent.length, 3); assert.equal(sent[2].message.details.kind, 'thread');
    assert.ok(sent[2].message.content.includes('新问题'));
    assert.equal(resets(), 1, 'Inject keeps the thread until delivery');
    await commands.get('btw').handler('再问', ctx);
    assert.equal(requests.length, callsAfterQuestion, 'Questions wait while an inject is in flight');
    assert.ok(notices.some(n => n.message.includes('new BTW questions wait until it arrives')));
    await events.get('message_end')({ type: 'message_end', message: { role: 'custom', ...sent[2].message } }, ctx);
    await waitUntil(() => resets() === 2, 'inject reset after delivery');

    // 4. Card rendering: source label, instructions, collapsed preview.
    const long = buildBtwHandoffContent('thread', Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n'), 3, '');
    const render = (expanded, message) => renderers.get('btw-handoff')(message, { expanded }, ctx.ui.theme).render(70).map(stripTerminalSequences).join('\n');
    const collapsed = render(false, { role: 'custom', customType: 'btw-handoff', content: long, details: { kind: 'thread', exchanges: 3, instructions: '' } });
    assert.ok(collapsed.includes('BTW → main · full thread · 3 exchanges'));
    assert.ok(collapsed.includes('line 8') && !collapsed.includes('line 9') && collapsed.includes('… 4 more lines'));
    assert.ok(!collapsed.includes('<btw-handoff'), 'Card hides the model-facing wrapper');
    assert.ok(render(true, { role: 'custom', customType: 'btw-handoff', content: long, details: { kind: 'thread', exchanges: 3, instructions: '' } }).includes('line 12'));
    assert.ok(render(false, first.message).includes('instructions: 关注风险'));

    // 5. Restart with the undelivered summary (sent before its reset): offered for resend;
    //    new instructions re-wrap the same summary body.
    branch = [...restartBranch]; notices.length = 0;
    await events.get('session_start')({}, ctx);
    await commands.get('btw:summarize').handler('只看结论', ctx);
    assert.equal(requests.length, callsAfterQuestion);
    const resent = sent.at(-1).message;
    assert.ok(resent.content.includes('User instructions for this handoff: 只看结论'));
    assert.equal(extractBtwHandoffBody(resent.content), extractBtwHandoffBody(first.message.content));
    await events.get('message_end')({ type: 'message_end', message: { role: 'custom', ...resent } }, ctx);
    await waitUntil(() => notices.some(n => n.message.includes('Handed BTW summary')), 'delivered after restart');

    // 6. /btw:clear discards an undelivered summary persistently.
    branch = [...restartBranch];
    await events.get('session_start')({}, ctx);
    await commands.get('btw:clear').handler('', ctx);
    assert.ok(branch.some(e => e.customType === 'btw-handoff-discarded' && e.data.id === first.message.details.id));
    await events.get('session_start')({}, ctx);
    const sentBefore = sent.length; notices.length = 0;
    await commands.get('btw:summarize').handler('', ctx);
    assert.equal(sent.length, sentBefore, 'Nothing to resend after /btw:clear');
    assert.ok(notices.some(n => n.message.includes('No BTW thread to summarize')));

    // 7. Restart after the summary was delivered: nothing cached; summarize makes a new summary.
    branch = [...restartBranch, { type: 'custom_message', customType: 'btw-handoff', content: first.message.content, display: true, details: first.message.details }];
    await events.get('session_start')({}, ctx);
    await commands.get('btw:summarize').handler('', ctx);
    assert.equal(requests.length, callsAfterQuestion + 1, 'Delivered summary is not resent');
    assert.ok(sent.at(-1).message.content.includes('新问题') || /离线摘要 \d/.test(sent.at(-1).message.content));
    assert.ok(!notices.some(n => n.level === 'error'), JSON.stringify(notices));
  } finally {
    await events.get('session_shutdown')({}, ctx);
  }
});
