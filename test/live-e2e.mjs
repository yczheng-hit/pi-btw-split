import { hostDir, hostDependencyPath, herdrExtension } from './host.mjs';
// Opt-in full live repro: real Pi parent + real BTW extension + native Herdr pane.
// Uses an isolated agent dir and a local fake provider; never calls a network model.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { herdrApi } from '../native/herdr.mjs';

if (process.env.PI_BTW_LIVE_TEST !== '1') throw new Error('Opt-in required: PI_BTW_LIVE_TEST=1');
const api = herdrApi(), nonce = randomUUID(), label = `BTW e2e ${nonce}`;
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'btw-e2e-')); await fs.chmod(directory, 0o700);
const agentDir = path.join(directory, 'agent'); await fs.mkdir(agentDir, { mode: 0o700 });
const sessionFile = path.join(directory, 'session.jsonl');
// Optional: restore a private copy of a real session (isolated agent dir = no credentials).
if (process.env.PI_BTW_E2E_SESSION_COPY) await fs.copyFile(process.env.PI_BTW_E2E_SESSION_COPY, sessionFile);
await fs.chmod(sessionFile, 0o600).catch(() => {});
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(check, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  for (;;) { const value = await check(); if (value) return value; if (Date.now() > deadline) throw new Error('Timed out: ' + description); await sleep(50); }
}
const panes = async () => (await api('pane.list')).panes;
const read = async paneId => (await api('pane.read', { pane_id: paneId, source: 'visible', format: 'text' })).read.text;
const before = await panes(); let parentTerminal;
const runs = Number(process.env.PI_BTW_E2E_RUNS ?? 2);
try {
  const realAgent = process.env.PI_BTW_E2E_REAL_AGENT === '1';
  // Real-agent mode loads the user's actual packages/settings (including this BTW package);
  // only the model is the local fake provider and the session lives in the temp directory.
  const command = [process.execPath, path.join(hostDir, 'dist/bundle/cli.js'), '--offline', '--no-mcp',
    ...(realAgent ? [] : ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
      '-e', herdrExtension, '-e', path.join(root, 'extensions/btw.ts')]),
    '-e', path.join(root, 'test/live-fixtures/fake-provider.ts'),
    '--model', 'btw-live-fake/fixture:high', '--session', sessionFile];
  const env = { PI_SKIP_VERSION_CHECK: '1', BTW_FAKE_THINKING: process.env.BTW_FAKE_THINKING ?? '1', ...(realAgent ? {} : { PI_CODING_AGENT_DIR: agentDir }) };
  for (let run = 1; run <= runs; run++) {
    await api('layout.apply', { workspace_id: process.env.HERDR_WORKSPACE_ID, focus: false, tab_label: label, root: { type: 'pane', label, cwd: directory, command, env } });
    const parent = await until(async () => (await panes()).find(p => p.label === label && !before.some(b => b.terminal_id === p.terminal_id)), 'parent pane');
    parentTerminal = parent.terminal_id;
    await until(async () => { const p = (await panes()).find(p => p.terminal_id === parentTerminal); return p?.agent === 'pi' && p.agent_session?.value === sessionFile; }, 'parent official identity', 30000);
    const current = () => panes().then(list => list.find(p => p.terminal_id === parentTerminal));
    if (process.env.PI_BTW_E2E_MAIN_BUSY === '1') {
      await api('pane.send_text', { pane_id: (await current()).pane_id, text: 'SLOW_MAIN please' });
      await api('pane.send_keys', { pane_id: (await current()).pane_id, keys: ['enter'] });
      await until(async () => (await current()).agent_status === 'working', 'main busy');
    }
    await api('pane.send_text', { pane_id: (await current()).pane_id, text: '/btw' });
    await api('pane.send_keys', { pane_id: (await current()).pane_id, keys: ['enter'] });
    const btw = await until(async () => (await panes()).find(p => p.agent === 'btw-light' && !before.some(b => b.terminal_id === p.terminal_id)), 'native BTW pane');
    const btwId = async () => (await panes()).find(p => p.terminal_id === btw.terminal_id).pane_id;
    await until(async () => (await read(await btwId())).includes('Enter submits') || (await read(await btwId())).includes('BTW ·'), 'BTW initial frame');
    const question = `QUESTION_${run}`;
    await api('pane.send_text', { pane_id: await btwId(), text: question });
    await until(async () => (await read(await btwId())).includes(question), 'typed text visible');
    await api('pane.send_keys', { pane_id: await btwId(), keys: ['enter'] });
    try {
      const replies = async () => ((await read(await btwId())).match(/FAKE_REPLY_\d+/g) ?? []).length;
      const baseline = run === 1 && !process.env.PI_BTW_E2E_SESSION_COPY ? 0 : await replies();
      await until(async () => (await replies()) > baseline || (await read(await btwId())).includes(`FAKE_REPLY_${process.env.PI_BTW_E2E_EXPECT ?? 1}`), `reply visible in BTW pane (run ${run})`, 8000);
      const dump = async tag => { if (process.env.PI_BTW_E2E_DEBUG) console.log(`--- ${tag}\n` + (await read(await btwId())).split('\n').filter(l => l.trim() && !/^[─]+$/.test(l.trim())).join('\n')); };
      await until(async () => (await read(await btwId())).includes('Ready for a follow-up'), 'first BTW turn completed'); await dump('after first reply');
      // A thinking change replaces the child session while the pane stays open (user-reported bug).
      const before = await replies();
      // Real Herdr Tab key → frontend → composer completion.
      await api('pane.send_text', { pane_id: await btwId(), text: '/th' });
      await until(async () => (await read(await btwId())).includes('Tab → /btw:thinking'), 'live slash hint');
      await api('pane.send_keys', { pane_id: await btwId(), keys: ['tab'] });
      // pane.read trims trailing spaces; the usage hint (no "Tab →") proves the completed `/btw:thinking `.
      await until(async () => { const text = await read(await btwId()); return text.includes('> /btw:thinking') && text.includes('\n/btw:thinking [<level> | clear]'); }, 'live Tab completion');
      await api('pane.send_text', { pane_id: await btwId(), text: 'off' });
      await api('pane.send_keys', { pane_id: await btwId(), keys: ['enter'] });
      await until(async () => (await read(await btwId())).includes('thinking override set to off'), 'completed command ran'); await dump('after /btw:thinking off');
      await api('pane.send_text', { pane_id: await btwId(), text: `SECOND_${run}` });
      await api('pane.send_keys', { pane_id: await btwId(), keys: ['enter'] });
      await until(async () => (await replies()) > before, `reply after session replacement visible (run ${run})`, 8000);
      await until(async () => (await read(await btwId())).includes(`SECOND_${run}`), 'previous exchanges retained');
      console.log(JSON.stringify({ run, replyVisible: true, replyAfterThinkingChange: true }));
    } catch (error) {
      console.log(JSON.stringify({ run, replyVisible: false, btwScreen: await read(await btwId()), parentScreen: await read((await current()).pane_id) }, null, 1));
      throw error;
    }
    // Close parent (simulated Pi exit); next run resumes the same session.
    await api('pane.close', { pane_id: (await current()).pane_id });
    await until(async () => !(await panes()).some(p => p.terminal_id === parentTerminal || p.terminal_id === btw.terminal_id), 'cleanup after parent exit');
    parentTerminal = undefined;
  }
} finally {
  if (parentTerminal) { const p = (await panes()).find(p => p.terminal_id === parentTerminal); if (p?.label === label) await api('pane.close', { pane_id: p.pane_id }).catch(() => {}); }
  for (const p of await panes()) if (p.agent === 'btw-light' && !before.some(b => b.terminal_id === p.terminal_id)) await api('plugin.pane.close', { pane_id: p.pane_id }).catch(() => {});
  await fs.rm(directory, { recursive: true, force: true });
}
