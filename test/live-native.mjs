import { hostDir, hostDependencyPath, herdrExtension } from './host.mjs';
// Opt-in live Herdr PTY smoke. Never run by npm test; no models, no user pane input.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { NativeSurface } from '../native/surface.mjs';
import { herdrApi, PLUGIN_ID } from '../native/herdr.mjs';

if (process.env.PI_BTW_LIVE_TEST !== '1' || !process.env.HERDR_SOCKET_PATH) throw new Error('Opt-in required: PI_BTW_LIVE_TEST=1 node test/live-native.mjs');
const api = herdrApi(), nonce = randomUUID(), label = `BTW smoke ${nonce}`, source = 'herdr:pi' /* ONLY the isolated fake parent; official session refs require this source */;
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { Input } = await import(pathToFileURL(hostDependencyPath('@earendil-works/pi-tui', 'dist/index.js')));
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'btw-live-test-')); await fs.chmod(directory, 0o700);
const sessionFile = path.join(directory, 'test-session.jsonl');
await fs.writeFile(sessionFile, JSON.stringify({ type: 'session', version: 3, id: nonce, timestamp: new Date().toISOString(), cwd: directory }) + '\n', { mode: 0o600 });
const before = (await api('pane.list')).panes;
const originalFocus = before.filter(p => p.focused).map(p => p.terminal_id);
const userMain = before.find(p => p.pane_id === process.env.HERDR_PANE_ID);
const parentSnapshot = userMain && { terminal_id: userMain.terminal_id, agent: userMain.agent, session: userMain.agent_session };
const surfaces = [], ownedTabs = new Set(); let parentTerminal;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(check, description) {
  const deadline = Date.now() + 10000;
  while (true) { const value = await check(); if (value) return value; if (Date.now() > deadline) throw new Error('Timed out: ' + description); await sleep(20); }
}
const rounded = n => +n.toFixed(1);
try {
  const plugins = (await api('plugin.list')).plugins;
  assert.ok(plugins.some(p => p.plugin_id === PLUGIN_ID && p.enabled && path.resolve(p.plugin_root) === root), 'Owned plugin must already be linked');
  // A full Pi is ONLY the isolated test parent; the BTW pane still runs the SDK-free frontend.
  // Live Herdr accepts official session identity only after detecting the actual Pi process.
  await api('layout.apply', { workspace_id: process.env.HERDR_WORKSPACE_ID, focus: false, tab_label: label, root: { type: 'pane', label, cwd: directory,
    command: [process.execPath, path.join(hostDir, 'dist/bundle/cli.js'), '--no-extensions', '-e', herdrExtension, '--no-skills', '--no-prompt-templates', '--session', sessionFile] } });
  const parent = await until(async () => (await api('pane.list')).panes.find(p => p.label === label && !before.some(b => b.terminal_id === p.terminal_id)), 'temporary parent');
  parentTerminal = parent.terminal_id; ownedTabs.add(parent.tab_id);
  await until(async () => { const p = (await api('pane.list')).panes.find(p => p.terminal_id === parentTerminal); return p?.agent === 'pi' && p.agent_session?.value === sessionFile; }, 'isolated parent official identity');
  const measured = [];
  for (let iteration = 0; iteration < 5; iteration++) {
    let timing, inputs = [], submitted = [], component;
    const surface = new NativeSurface({ pluginRoot: root, parentPaneId: parent.pane_id, sessionFile, hostDir, cwd: directory, focus: false,
      onTiming: t => { timing = t; }, onError: e => console.error('Surface:', e.message),
      createComponent: (shadow, geometry) => {
        const input = new Input(); input.focused = true; input.onSubmit = value => submitted.push(value);
        component = {
          render(width) { const rows = geometry().height; return ['BTW · live smoke', ...Array(Math.max(0, rows - 4)).fill(''), ...input.render(width), '', 'No model · 独立输入']; },
          handleInput(data) { inputs.push(data); input.handleInput(data); shadow.requestRender(); },
          handleMouse(event) { if (event.y === geometry().height - 3) return input.handleMouse?.({ ...event, y: 0, height: 1 }); },
          invalidate() { input.invalidate(); }, dispose() {}, setDraft(value) { input.setValue(value); },
        }; return component;
      } });
    surfaces.push(surface);
    const requestAt = performance.timeOrigin + performance.now();
    await surface.open(); const paneRpcMs = performance.timeOrigin + performance.now() - requestAt;
    await surface.ready; await until(() => timing, 'PTY frame write telemetry');
    const offset = timing.startedAtMs - requestAt;
    measured.push({ run: iteration + 1, kind: iteration ? 'warm (new Node process)' : 'first launch (OS cache not evicted)', paneSetupMs: rounded(paneRpcMs), requestToFirstPTYWriteMs: rounded(offset + timing.firstWriteMs), requestToInputReadyMs: rounded(offset + timing.inputReadyMs), requestToBackendFrameWriteMs: rounded(offset + timing.frameWriteMs), frontendEntryToFirstWriteMs: rounded(timing.firstWriteMs) });
    const owned = await surface.pane.current(); assert.equal(owned.agent, 'btw-light'); assert.equal(owned.agent_session, undefined, 'Not an independently restorable Pi');
    assert.notEqual(owned.terminal_id, parent.terminal_id);
    const terminal = owned.terminal_id;
    assert.equal((await surface.pane.current()).terminal_id, terminal, 'Stable terminal identity');
    // Do not invoke reuse/focus shortcuts here: reuse focuses by design and is tested offline.
    await api('pane.send_text', { pane_id: (await surface.pane.current()).pane_id, text: '中文输入' });
    await until(() => inputs.join('').includes('中文输入'), 'real PTY Chinese input');
    await until(async () => (await api('pane.read', { pane_id: (await surface.pane.current()).pane_id, source: 'visible', format: 'text' })).read.text.includes('中文输入'), 'real rendered input');
    await api('pane.send_keys', { pane_id: (await surface.pane.current()).pane_id, keys: ['enter'] });
    await until(() => submitted.length === 1, 'single ordered submission'); assert.deepEqual(submitted, ['中文输入']);
    if (iteration === 1) {
      const oldSize = { ...surface.size };
      await api('pane.resize', { pane_id: owned.pane_id, direction: 'left', amount: 0.05 });
      await until(() => surface.size.columns !== oldSize.columns, 'native resize reaches backend');
    }
    if (iteration === 2) {
      await api('pane.move', { pane_id: owned.pane_id, focus: false, destination: { type: 'new_tab', label } });
      const moved = await surface.pane.current(); assert.ok(moved); assert.equal(moved.terminal_id, terminal); ownedTabs.add(moved.tab_id);
      await api('pane.send_text', { pane_id: moved.pane_id, text: '移动后' });
      await until(() => inputs.join('').includes('移动后'), 'input after move');
    }
    if (iteration === 3) {
      await api('plugin.pane.close', { pane_id: (await surface.pane.current()).pane_id });
      await surface.done; assert.equal(surface.closed, true);
    } else if (iteration === 4) {
      const liveParent = (await api('pane.list')).panes.find(p => p.terminal_id === parentTerminal);
      assert.equal(liveParent.label, label);
      await api('pane.close', { pane_id: liveParent.pane_id });
      await surface.done; assert.equal(surface.closed, true, 'Parent exit disconnects and cleans the frontend');
    } else await surface.close();
    await assert.rejects(fs.stat(surface.directory));
    await until(async () => !(await api('pane.list')).panes.some(p => p.terminal_id === terminal), 'frontend cleanup');
  }
  const after = (await api('pane.list')).panes;
  const unchanged = after.find(p => p.terminal_id === parentSnapshot?.terminal_id);
  if (parentSnapshot) assert.deepEqual({ terminal_id: unchanged.terminal_id, agent: unchanged.agent, session: unchanged.agent_session }, parentSnapshot);
  assert.deepEqual(after.filter(p => p.focused && before.some(b => b.terminal_id === p.terminal_id)).map(p => p.terminal_id), originalFocus, 'Never steal the user focus');
  console.log(JSON.stringify({ noModelCalls: true, separatePTY: true, resize: true, move: true, manualClose: true, parentExit: true, measured }, null, 2));
} finally {
  for (const surface of surfaces) await surface.close();
  if (parentTerminal) {
    const parent = (await api('pane.list')).panes.find(p => p.terminal_id === parentTerminal);
    if (parent?.label === label) { await api('pane.release_agent', { pane_id: parent.pane_id, source, agent: 'pi', seq: 2 }).catch(() => {}); await api('pane.close', { pane_id: parent.pane_id }); }
  }
  // Moved plugin panes normally auto-remove their now-empty tabs. Close only our empty test tabs.
  const tabs = (await api('tab.list')).tabs;
  for (const tab of tabs) if (ownedTabs.has(tab.tab_id) && tab.label === label && !(await api('pane.list')).panes.some(p => p.tab_id === tab.tab_id)) await api('tab.close', { tab_id: tab.tab_id });
  await fs.rm(directory, { recursive: true, force: true });
}
