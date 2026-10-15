import { hostDir, hostDependencyPath, herdrExtension } from './host.mjs';
// Opt-in live handoff repro: real Pi parent + real BTW extension + native Herdr pane + local fake provider.
// Cases (PI_BTW_HANDOFF_CASE): idle | busy | busy-steer | busy-esc. Never calls a network model.
// Reports whether the BTW handoff reached the main session, and the parent screen on failure.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { herdrApi } from '../native/herdr.mjs';

if (process.env.PI_BTW_LIVE_TEST !== '1') throw new Error('Opt-in required: PI_BTW_LIVE_TEST=1');
const scenario = process.env.PI_BTW_HANDOFF_CASE ?? 'busy-steer';
const command = process.env.PI_BTW_HANDOFF_COMMAND ?? '/btw:summarize';
const api = herdrApi(), label = `BTW handoff ${randomUUID()}`;
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'btw-e2e-')); await fs.chmod(directory, 0o700);
const agentDir = path.join(directory, 'agent'); await fs.mkdir(agentDir, { mode: 0o700 });
const sessionFile = path.join(directory, 'session.jsonl');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(check, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  for (;;) { const value = await check(); if (value) return value; if (Date.now() > deadline) throw new Error('Timed out: ' + description); await sleep(50); }
}
const panes = async () => (await api('pane.list')).panes;
const read = async paneId => (await api('pane.read', { pane_id: paneId, source: 'visible', format: 'text' })).read.text;
const entries = async () => (await fs.readFile(sessionFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
const text = content => typeof content === 'string' ? content : (content ?? []).map(part => part.text ?? '').join('');
const handoffs = list => list.filter(e =>
  (e.type === 'custom_message' && e.customType === 'btw-handoff') ||
  (e.type === 'message' && e.message?.role === 'user' && /side conversation I had/.test(text(e.message.content))));
const before = await panes(); let parentTerminal;
const result = { scenario, command, realAgent: process.env.PI_BTW_E2E_REAL_AGENT === '1' };
try {
  const realAgent = result.realAgent;
  const cli = [process.execPath, path.join(hostDir, 'dist/bundle/cli.js'), '--offline', '--no-mcp',
    ...(realAgent ? [] : ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
      '-e', herdrExtension, '-e', path.join(root, 'extensions/btw.ts')]),
    '-e', path.join(root, 'test/live-fixtures/fake-provider.ts'),
    '--model', 'btw-live-fake/fixture:high', '--session', sessionFile];
  const env = { PI_SKIP_VERSION_CHECK: '1', BTW_FAKE_THINKING: '1', BTW_FAKE_SLOW_MS: '1500', ...(realAgent ? {} : { PI_CODING_AGENT_DIR: agentDir }) };
  await api('layout.apply', { workspace_id: process.env.HERDR_WORKSPACE_ID, focus: false, tab_label: label, root: { type: 'pane', label, cwd: directory, command: cli, env } });
  const parent = await until(async () => (await panes()).find(p => p.label === label && !before.some(b => b.terminal_id === p.terminal_id)), 'parent pane');
  parentTerminal = parent.terminal_id;
  await until(async () => { const p = (await panes()).find(p => p.terminal_id === parentTerminal); return p?.agent === 'pi' && p.agent_session?.value === sessionFile; }, 'parent official identity', 30000);
  const current = () => panes().then(list => list.find(p => p.terminal_id === parentTerminal));
  const mainSend = async (value, keys = ['enter']) => {
    const id = (await current()).pane_id;
    if (value) await api('pane.send_text', { pane_id: id, text: value });
    await api('pane.send_keys', { pane_id: id, keys });
  };
  const working = async () => (await current()).agent_status === 'working';

  // BTW thread with one exchange, while the main session is idle.
  await mainSend('/btw');
  const btw = await until(async () => (await panes()).find(p => p.agent === 'btw-light' && !before.some(b => b.terminal_id === p.terminal_id)), 'native BTW pane');
  const btwId = async () => (await panes()).find(p => p.terminal_id === btw.terminal_id)?.pane_id;
  await until(async () => (await read(await btwId())).includes('BTW ·'), 'BTW initial frame');
  await api('pane.send_text', { pane_id: await btwId(), text: 'BTW_QUESTION' });
  await api('pane.send_keys', { pane_id: await btwId(), keys: ['enter'] });
  await until(async () => (await read(await btwId())).includes('Ready for a follow-up'), 'BTW reply');

  if (scenario !== 'idle') {
    await mainSend('SLOW_MAIN please');
    await until(working, 'main busy');
  }
  await api('pane.send_text', { pane_id: await btwId(), text: command });
  await api('pane.send_keys', { pane_id: await btwId(), keys: ['enter'] });
  // Handoff dispatched: the BTW pane closes.
  await until(async () => !(await btwId()), 'BTW pane closed after handoff', 20000);
  result.busyAtHandoff = await working();

  if (scenario === 'busy-steer') {
    result.steerWhileBusy = [];
    for (const n of [1, 2, 3]) {
      result.steerWhileBusy.push(await working());
      await mainSend(`STEER_${n} hi`);
      await sleep(1200);
    }
  } else if (scenario === 'busy-esc') {
    await sleep(300);
    await mainSend('', ['escape']);
  }

  // Wait for the main session to settle (not working for 3s).
  let idleSince = 0;
  await until(async () => {
    if (await working()) { idleSince = 0; return false; }
    idleSince ||= Date.now();
    return Date.now() - idleSince > 3000;
  }, 'main settled', 120000);

  const list = await entries();
  const delivered = handoffs(list);
  result.delivered = delivered.length;
  result.handoffType = delivered[0]?.type === 'custom_message' ? 'custom:btw-handoff' : delivered[0] ? 'user-message' : null;
  const at = delivered[0] ? list.indexOf(delivered[0]) : -1;
  result.mainRepliedAfterHandoff = at >= 0 && list.slice(at + 1).some(e => e.type === 'message' && e.message?.role === 'assistant');
  result.threadResetEntries = list.filter(e => e.type === 'custom' && e.customType === 'btw-thread-reset').length;
  result.order = list.filter(e => e.type === 'message' || e.type === 'custom_message' || (e.type === 'custom' && /^btw-/.test(e.customType)))
    .map(e => e.type === 'message' ? `${e.message.role}:${text(e.message.content).slice(0, 24)}` : `${e.customType}`)
    .filter(s => !s.startsWith('btw-thread-entry'));
  if (scenario === 'busy-esc') {
    // Resend from the main editor: same content, no new BTW model call, then the thread resets.
    const pendingContent = list.filter(e => e.type === 'custom' && e.customType === 'btw-handoff-pending').at(-1)?.data?.content;
    await mainSend(command);
    idleSince = 0;
    await until(async () => handoffs(await entries()).length > 0 && !(await working()) && (idleSince ||= Date.now()) && Date.now() - idleSince > 2000, 'resend delivered', 60000);
    const after = await entries();
    result.resendDelivered = handoffs(after).length;
    result.resendReusedContent = handoffs(after)[0]?.content === pendingContent;
    result.threadResetAfterResend = after.filter(e => e.type === 'custom' && e.customType === 'btw-thread-reset').length;
  }
  result.parentScreen = (await read((await current()).pane_id)).split('\n').filter(l => l.trim()).slice(-14);
  console.log(JSON.stringify(result, null, 1));
} catch (error) {
  result.error = String(error);
  const p = parentTerminal && (await panes()).find(p => p.terminal_id === parentTerminal);
  if (p) result.parentScreen = (await read(p.pane_id)).split('\n').filter(l => l.trim()).slice(-20);
  console.log(JSON.stringify(result, null, 1));
  process.exitCode = 1;
} finally {
  if (parentTerminal) { const p = (await panes()).find(p => p.terminal_id === parentTerminal); if (p?.label === label) await api('pane.close', { pane_id: p.pane_id }).catch(() => {}); }
  for (const p of await panes()) if (p.agent === 'btw-light' && !before.some(b => b.terminal_id === p.terminal_id)) await api('plugin.pane.close', { pane_id: p.pane_id }).catch(() => {});
  await fs.rm(directory, { recursive: true, force: true });
}
