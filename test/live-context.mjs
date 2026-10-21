import { hostDir, hostDependencyPath, herdrExtension } from './host.mjs';
// Opt-in live A/B: how heavy is opening BTW on a near-full main session?
// Real Pi parent (isolated agent dir) + real BTW extension + native Herdr pane + local fake provider.
// PI_BTW_CONTEXT_SESSION=<jsonl> is copied privately; the fake window makes it ~95% full.
// Runs default (lean) and PI_BTW_CONTEXT=full, then reports requests, sizes, compactions, latency.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { herdrApi } from '../native/herdr.mjs';

if (process.env.PI_BTW_LIVE_TEST !== '1') throw new Error('Opt-in required: PI_BTW_LIVE_TEST=1');
const source = process.env.PI_BTW_CONTEXT_SESSION;
if (!source) throw new Error('Set PI_BTW_CONTEXT_SESSION to a session JSONL to copy');
const modes = (process.env.PI_BTW_CONTEXT_MODES ?? 'lean,full').split(',');
const api = herdrApi();
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { parseSessionEntries, buildSessionContext, estimateTokens } = await import(pathToFileURL(path.join(hostDir, 'dist/index.js')));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(check, description, timeout = 30000) {
  const deadline = Date.now() + timeout;
  for (;;) { const value = await check(); if (value) return value; if (Date.now() > deadline) throw new Error('Timed out: ' + description); await sleep(50); }
}
const panes = async () => (await api('pane.list')).panes;
const read = async paneId => (await api('pane.read', { pane_id: paneId, source: 'visible', format: 'text' })).read.text;
const compactions = text => text.split('\n').filter(Boolean).filter(line => JSON.parse(line).type === 'compaction').length;

// Main context size → fake window so the main session sits at ~95%.
const raw = await fs.readFile(source, 'utf8');
const body = parseSessionEntries(raw).filter(e => e.type !== 'session');
const mainTokens = buildSessionContext(body, body.at(-1)?.id).messages.reduce((sum, m) => sum + estimateTokens(m), 0);
const window = Math.ceil(mainTokens / 0.95);
const results = [];
const before = await panes();

for (const mode of modes) {
  const label = `BTW context ${mode} ${randomUUID()}`;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'btw-e2e-')); await fs.chmod(directory, 0o700);
  const agentDir = path.join(directory, 'agent'); await fs.mkdir(agentDir, { mode: 0o700 });
  const sessionFile = path.join(directory, 'session.jsonl');
  const log = path.join(directory, 'fake.jsonl');
  await fs.writeFile(sessionFile, raw, { mode: 0o600 });
  let parentTerminal;
  const result = { mode, mainTokensEst: mainTokens, window };
  try {
    const cli = [process.execPath, path.join(hostDir, 'dist/bundle/cli.js'), '--offline', '--no-mcp',
      '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
      '-e', herdrExtension, '-e', path.join(root, 'extensions/btw.ts'),
      '-e', path.join(root, 'test/live-fixtures/fake-provider.ts'),
      '--model', 'btw-live-fake/fixture:high', '--session', sessionFile];
    const env = { PI_SKIP_VERSION_CHECK: '1', PI_CODING_AGENT_DIR: agentDir, BTW_FAKE_THINKING: '1', BTW_FAKE_WINDOW: String(window), BTW_FAKE_LOG: log,
      ...(mode === 'full' ? { PI_BTW_CONTEXT: 'full' } : {}) };
    await api('layout.apply', { workspace_id: process.env.HERDR_WORKSPACE_ID, focus: false, tab_label: label, root: { type: 'pane', label, cwd: directory, command: cli, env } });
    const parent = await until(async () => (await panes()).find(p => p.label === label && !before.some(b => b.terminal_id === p.terminal_id)), 'parent pane');
    parentTerminal = parent.terminal_id;
    await until(async () => { const p = (await panes()).find(p => p.terminal_id === parentTerminal); return p?.agent === 'pi' && p.agent_session?.value === sessionFile; }, 'parent official identity', 60000);
    const current = () => panes().then(list => list.find(p => p.terminal_id === parentTerminal));
    result.mainCompactionsBefore = compactions(await fs.readFile(sessionFile, 'utf8'));

    await api('pane.send_text', { pane_id: (await current()).pane_id, text: '/btw' });
    await api('pane.send_keys', { pane_id: (await current()).pane_id, keys: ['enter'] });
    const btw = await until(async () => (await panes()).find(p => p.agent === 'btw-light' && !before.some(b => b.terminal_id === p.terminal_id)), 'native BTW pane');
    const btwId = async () => (await panes()).find(p => p.terminal_id === btw.terminal_id)?.pane_id;
    await until(async () => (await read(await btwId())).includes('BTW ·'), 'BTW initial frame');
    await api('pane.send_text', { pane_id: await btwId(), text: 'CONTEXT_PROBE 你好' });
    await until(async () => (await read(await btwId())).includes('CONTEXT_PROBE'), 'typed');
    const started = Date.now();
    await api('pane.send_keys', { pane_id: await btwId(), keys: ['enter'] });
    await until(async () => /FAKE_REPLY_\d+/.test(await read(await btwId())), 'BTW reply visible', 120000);
    result.replyVisibleMs = Date.now() - started;
    await until(async () => (await read(await btwId())).includes('Ready for a follow-up'), 'BTW turn settled', 120000);
    result.settledMs = Date.now() - started;
    await sleep(1500);

    const requests = (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    const first = requests.find(r => r.probe);
    result.btwRequests = requests.length;
    result.firstRequestEstTokens = first?.estTokens;
    result.firstRequestUsesSnapshot = first?.snapshot;
    result.btwCompactionCalls = requests.filter(r => r.summarization).length;
    result.mainCompactionsAfter = compactions(await fs.readFile(sessionFile, 'utf8'));
    if (process.env.PI_BTW_CONTEXT_DEBUG) result.requests = requests;
  } catch (error) {
    result.error = String(error);
    const p = parentTerminal && (await panes()).find(p => p.terminal_id === parentTerminal);
    if (p) result.parentScreen = (await read(p.pane_id)).split('\n').filter(l => l.trim()).slice(-12);
    process.exitCode = 1;
  } finally {
    if (parentTerminal) { const p = (await panes()).find(p => p.terminal_id === parentTerminal); if (p?.label === label) await api('pane.close', { pane_id: p.pane_id }).catch(() => {}); }
    for (const p of await panes()) if (p.agent === 'btw-light' && !before.some(b => b.terminal_id === p.terminal_id)) await api('plugin.pane.close', { pane_id: p.pane_id }).catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  }
  results.push(result);
  console.log(JSON.stringify(result));
}
