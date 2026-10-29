// Opt-in identity lifecycle repro. Isolated Pi + local fake model; no user input/config.
import { hostDir, herdrExtension } from './host.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { herdrApi } from '../native/herdr.mjs';
if (process.env.PI_BTW_LIVE_TEST !== '1' || !process.env.HERDR_SOCKET_PATH) throw new Error('PI_BTW_LIVE_TEST=1 and explicit HERDR_SOCKET_PATH required');
const api = herdrApi(), root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'btw-identity-'));
const label = `BTW identity ${randomUUID()}`, log = path.join(directory, 'identity.jsonl');
const panes = async () => (await api('pane.list')).panes;
const before = await panes(); let terminal;
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(check, description) {
  const deadline = Date.now() + 15000;
  do { const value = await check(); if (value) return value; await delay(40); } while (Date.now() < deadline);
  throw new Error('Timed out: ' + description);
}
const refs = async () => (await fs.readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(s => JSON.parse(s));
try {
  await api('layout.apply', { workspace_id: process.env.HERDR_WORKSPACE_ID, focus: false, tab_label: label,
    root: { type: 'pane', label, cwd: directory, env: { PI_CODING_AGENT_DIR: path.join(directory, 'agent'), PI_SKIP_VERSION_CHECK: '1', BTW_IDENTITY_LOG: log },
      command: [process.execPath, path.join(hostDir, 'dist/bundle/cli.js'), '--offline', '--no-mcp', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
        '-e', herdrExtension, '-e', path.join(root, 'test/live-fixtures/identity-probe.ts'), '-e', path.join(root, 'extensions/btw.ts'),
        '-e', path.join(root, 'test/live-fixtures/fake-provider.ts'), '--model', 'btw-live-fake/fixture', '--session', path.join(directory, 'session.jsonl')] } });
  const parent = await until(async () => (await panes()).find(p => p.label === label), 'test Pi'); terminal = parent.terminal_id;
  const current = async () => (await panes()).find(p => p.terminal_id === terminal);
  const send = async text => { const p = await current(); await api('pane.send_text', { pane_id: p.pane_id, text }); await api('pane.send_keys', { pane_id: p.pane_id, keys: ['enter'] }); };
  const screen = async () => (await api('pane.read', { pane_id: (await current()).pane_id, source: 'visible', format: 'text' })).read.text;
  for (const step of ['startup', 'new', 'reload']) {
    const count = (await refs()).length;
    if (step !== 'startup') await send('/' + step);
    const ref = await until(async () => { const r = await refs(); return r.length >= (step === 'startup' ? 1 : count + 1) && r.at(-1); }, step + ' session_start');
    const official = (await current()).agent_session;
    console.log(JSON.stringify({ step, expected: ref.sessionFile, official }));
    await send('/btw');
    const result = await until(async () => {
      const child = (await panes()).find(p => p.agent === 'btw-light' && !before.some(b => b.terminal_id === p.terminal_id));
      const text = await screen();
      const error = text.match(/(?:Native BTW failed:|Could not open native BTW:)[^\n]*/)?.[0];
      return child ? { child } : error ? { error } : null;
    }, step + ' BTW result');
    assert.equal(result.error, undefined, `${step}: ${JSON.stringify({ ...result, expected: ref.sessionFile, official: (await current()).agent_session })}`);
    await until(async () => (await api('pane.read', { pane_id: result.child.pane_id, source: 'visible', format: 'text' })).read.text.includes('BTW ·'), step + ' frontend frame');
    await api('plugin.pane.close', { pane_id: result.child.pane_id });
    await until(async () => !(await panes()).some(p => p.terminal_id === result.child.terminal_id), 'child cleanup');
    console.log(step + ': PASS');
  }
} finally {
  if (terminal) { const p = (await panes()).find(p => p.terminal_id === terminal); if (p?.label === label) await api('pane.close', { pane_id: p.pane_id }); }
  for (const p of await panes()) if (p.agent === 'btw-light' && !before.some(b => b.terminal_id === p.terminal_id)) await api('plugin.pane.close', { pane_id: p.pane_id });
  await fs.rm(directory, { recursive: true, force: true });
}
