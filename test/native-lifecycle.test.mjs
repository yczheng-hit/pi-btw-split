import assert from 'node:assert/strict';
import { test } from 'node:test';
import net from 'node:net';
import fs from 'node:fs/promises';
import { NativeSurface, sweepStaleDirectories } from '../native/surface.mjs';
import os from 'node:os';
import path from 'node:path';
import { createDecoder } from '../native/protocol.mjs';

function fixture(options = {}) {
  const parent = { pane_id: 'w1:p1', terminal_id: 'parent', agent: 'pi', agent_session: { value: 'test-session' } };
  let child; const calls = [];
  const api = async (method, params) => {
    calls.push({ method, params });
    if (method === 'plugin.list') return { plugins: [{ plugin_id: 'local.pi-btw-light', plugin_root: '/test/plugin', enabled: true }] };
    if (method === 'pane.list') return { panes: [parent, ...(child ? [child] : [])] };
    if (method === 'plugin.pane.open') { child = { pane_id: 'w1:p2', terminal_id: 'child' }; return { plugin_pane: { plugin_id: 'local.pi-btw-light', entrypoint: 'btw', pane: child } }; }
    if (method === 'pane.report_metadata') child.tokens = params.tokens;
    if (method === 'pane.report_agent') child.agent = params.agent;
    if (method === 'plugin.pane.close') child = undefined;
    return {};
  };
  const surface = new NativeSurface({ api, pluginRoot: '/test/plugin', parentPaneId: parent.pane_id, sessionFile: 'test-session', hostDir: '/host', cwd: '/tmp', createComponent: () => ({ render: () => ['frame'], invalidate() {}, handleInput() {}, dispose() {} }), ...options });
  return { surface, calls, parent, get child() { return child; } };
}
async function connect(surface) {
  const cap = JSON.parse(await fs.readFile(surface.capabilityPath, 'utf8'));
  const socket = net.createConnection(cap.socket), messages = [];
  socket.on('error', () => {});
  socket.on('data', createDecoder(m => messages.push(m), () => socket.destroy()));
  await new Promise(r => socket.once('connect', r));
  socket.write(JSON.stringify({ type: 'hello', version: 1, token: cap.token, session: cap.session, pane: 'w1:p2', terminal: 'child', columns: 60, rows: 20 }) + '\n');
  await surface.ready;
  return { socket, messages };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('background launch stays unfocused; private timing is authenticated and bounded', async () => {
  const timings = [], f = fixture({ focus: false, onTiming: m => timings.push(m) });
  try {
    await f.surface.open();
    assert.equal(f.calls.find(c => c.method === 'plugin.pane.open').params.focus, false);
    const c = await connect(f.surface);
    c.socket.write('{"type":"timing","seq":1,"firstWriteMs":10,"inputReadyMs":20,"frameWriteMs":30}\n');
    await sleep(20);
    assert.equal(timings.length, 1); assert.equal(timings[0].frameWriteMs, 30);
    assert.ok(c.messages.some(m => m.type === 'ack' && m.seq === 1));
    c.socket.write('{"type":"timing","seq":2,"firstWriteMs":-1,"inputReadyMs":20,"frameWriteMs":30}\n');
    await new Promise(r => c.socket.once('close', r));
    assert.equal(timings.length, 1);
  } finally { await f.surface.close(); }
});

test('closing during component initialization never launches a pane; callbacks cannot prevent cleanup', async () => {
  let release, disposed = 0;
  const f = fixture({ onClosed() { throw new Error('bad callback'); }, createComponent: () => new Promise(r => { release = () => r({ render: () => [], dispose() { disposed++; throw new Error('bad dispose'); } }); }) });
  const opening = f.surface.open();
  while (!release) await sleep(1);
  const closed = f.surface.close(); release();
  await Promise.all([opening, closed]); await f.surface.done;
  assert.equal(f.calls.filter(c => c.method === 'plugin.pane.open').length, 0);
  assert.equal(disposed, 1); await assert.rejects(fs.stat(f.surface.directory));
});

test('resize and mouse stay within the owned terminal; malformed authenticated input disconnects', async () => {
  const mouse = [], sizes = [];
  const f = fixture({ createComponent: shadow => ({ render: () => [], handleInput() {}, handleMouse: e => mouse.push(e), invalidate: () => sizes.push([shadow.terminal.columns, shadow.terminal.rows]), dispose() {} }) });
  try {
    await f.surface.open(); const c = await connect(f.surface);
    const event = { type: 'wheel', button: 'none', x: 1, y: 1, screenX: 1, screenY: 1, width: 30, height: 12, shift: false, alt: false, ctrl: false, wheelDelta: -3 };
    c.socket.write(JSON.stringify({ type: 'resize', seq: 1, columns: 30, rows: 12 }) + '\n' + JSON.stringify({ type: 'mouse', seq: 2, event }) + '\n');
    await sleep(10); assert.deepEqual(sizes, [[30, 12]]); assert.equal(mouse.length, 1);
    c.socket.write(JSON.stringify({ type: 'mouse', seq: 3, event: { ...event, x: 50 } }) + '\n');
    await new Promise(r => c.socket.once('close', r)); assert.equal(mouse.length, 1);
  } finally { await f.surface.close(); }
});

test('authoritative reconciliation stops on parent session replacement without touching it', async () => {
  const f = fixture();
  try {
    await f.surface.open(); await connect(f.surface);
    f.parent.agent_session.value = 'foreign-session';
    await f.surface.reconcile(); await f.surface.done;
    assert.equal(f.surface.closed, true);
    assert.ok(f.calls.filter(c => c.method === 'plugin.pane.close').every(c => c.params.pane_id === 'w1:p2'));
    assert.equal(f.parent.agent_session.value, 'foreign-session');
  } finally { await f.surface.close(); }
});

test('stale IPC sweep removes only aged, own, dead pi-btw directories', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'btw-sweep-test-'));
  const make = async (name, files) => { const dir = path.join(root, name); await fs.mkdir(dir, { mode: 0o700 }); for (const f of files) await fs.writeFile(path.join(dir, f), '{}'); return dir; };
  const old = new Date(Date.now() - 10 * 60_000);
  const dead = await make('pi-btw-DEAD01', ['connection.json']);
  const live = await make('pi-btw-LIVE01', ['connection.json']);
  const server = net.createServer(); await new Promise(r => server.listen(path.join(live, 'ui.sock'), r));
  const foreignShape = await make('pi-btw-OTHER1', ['connection.json', 'notes.txt']);
  const young = await make('pi-btw-YOUNG1', ['connection.json']);
  const unrelated = await make('pi-btw-validate', ['connection.json']);
  for (const dir of [dead, live, foreignShape, unrelated]) await fs.utimes(dir, old, old);
  try {
    assert.deepEqual(await sweepStaleDirectories(root), [dead]);
    for (const dir of [live, foreignShape, young, unrelated]) await fs.stat(dir);
    await assert.rejects(fs.stat(dead));
  } finally { await new Promise(r => server.close(r)); await fs.rm(root, { recursive: true, force: true }); }
});
