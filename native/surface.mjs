import net from 'node:net';
import fs from 'node:fs/promises';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { OwnedPane } from './herdr.mjs';
import { VERSION, MAX_INPUT_BYTES, createDecoder, createSender, dimensions, validMouse, validTiming } from './protocol.mjs';

// Remove our private IPC directories if Pi exits without running session_shutdown.
const liveDirectories = new Set();
let exitHookInstalled = false;
function trackDirectory(directory) {
  liveDirectories.add(directory);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => { for (const dir of liveDirectories) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } } });
}

// A killed parent cannot run any hook. Sweep only our own, aged pi-btw-* directories whose
// socket has no listener; never touch other users' or recently created directories.
export async function sweepStaleDirectories(root = os.tmpdir(), minAgeMs = 60_000) {
  const removed = [];
  for (const name of await fs.readdir(root).catch(() => [])) {
    if (!/^pi-btw-[A-Za-z0-9]{6}$/.test(name)) continue;
    const directory = path.join(root, name);
    try {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.uid !== process.getuid() || Date.now() - stat.mtimeMs < minAgeMs || liveDirectories.has(directory)) continue;
      const entries = (await fs.readdir(directory)).sort().join(',');
      if (entries !== 'connection.json,ui.sock' && entries !== 'connection.json') continue;
      const socketPath = path.join(directory, 'ui.sock');
      const alive = await new Promise(resolve => {
        const socket = net.createConnection(socketPath);
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('error', error => resolve(!['ECONNREFUSED', 'ENOENT'].includes(error.code)));
      });
      if (!alive) { await fs.rm(directory, { recursive: true, force: true }); removed.push(directory); }
    } catch { /* leave anything unexpected alone */ }
  }
  return removed;
}
export class NativeSurface {
  constructor(options) {
    this.options = options; this.nonce = randomUUID(); this.token = randomBytes(32).toString('hex');
    this.session = randomUUID(); this.closed = false; this.connections = new Set(); this.size = { columns: 80, rows: 24 };
    this.pane = new OwnedPane({ ...options, nonce: this.nonce });
    this.shadow = { mode: 'fullscreen', terminal: { ...this.size, write() {} }, requestRender: () => this.requestRender() };
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.ready.catch(() => {});
    this.done = new Promise(resolve => { this.resolveClosed = resolve; });
  }
  open() { return this.opening ??= this.start(); }
  async start() {
    try {
      this.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-btw-'));
      trackDirectory(this.directory);
      void sweepStaleDirectories().catch(() => {});
      await fs.chmod(this.directory, 0o700);
      this.capabilityPath = path.join(this.directory, 'connection.json');
      const socketPath = path.join(this.directory, 'ui.sock');
      await fs.writeFile(this.capabilityPath, JSON.stringify({ version: VERSION, socket: socketPath, token: this.token, session: this.session }), { mode: 0o600 });
      this.component = await this.options.createComponent(this.shadow, () => ({ height: this.size.rows, split: false }));
      this.component.focused = true;
      this.server = net.createServer(socket => this.accept(socket));
      await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(socketPath, resolve); });
      await fs.chmod(socketPath, 0o600);
      if (this.closed) return;
      this.launching = this.pane.open({ PI_BTW_CAPABILITY: this.capabilityPath, PI_BTW_HOST_DIR: this.options.hostDir }, this.options.cwd);
      await this.launching;
      if (this.closed) return;
      this.startupTimer = setTimeout(() => this.fail(new Error('BTW frontend did not connect within 8 seconds')), 8000);
      this.startupTimer.unref();
      this.pollTimer = setInterval(() => this.reconcile(), 1500); this.pollTimer.unref();
    } catch (error) { this.fail(error); throw error; }
  }
  fail(error) {
    if (this.closed) return;
    try { this.options.onError?.(error); } catch { /* cleanup still owns the surface */ }
    this.rejectReady(error); void this.close();
  }
  accept(socket) {
    if (this.closed || this.connections.size >= 8) { socket.destroy(); return; }
    this.connections.add(socket);
    const send = createSender(socket); let authenticated = false, authenticating = false, seq = 0;
    let lastActivity = Date.now(), count = 0, epoch = lastActivity;
    const timeout = setInterval(() => { if (Date.now() - lastActivity > (authenticated ? 15000 : 2000)) socket.destroy(); }, 1000); timeout.unref();
    socket.on('error', () => {});
    socket.on('close', () => {
      clearInterval(timeout); this.connections.delete(socket);
      if (this.socket === socket) { this.socket = null; if (!this.closed) void this.close(); }
    });
    socket.on('data', createDecoder(message => {
      lastActivity = Date.now();
      if (lastActivity - epoch > 1000) { epoch = lastActivity; count = 0; }
      if (++count > 2000) throw new Error('IPC input rate exceeded');
      if (!authenticated) {
        if (authenticating || message.type !== 'hello' || message.version !== VERSION || typeof message.token !== 'string' || message.token.length !== this.token.length || !timingSafeEqual(Buffer.from(message.token), Buffer.from(this.token)) || message.session !== this.session) throw new Error('Invalid IPC authentication');
        const size = dimensions(message); authenticating = true;
        void (async () => {
          await this.launching;
          const pane = await this.pane.current();
          if (this.closed || socket.destroyed || this.socket || !pane || pane.pane_id !== message.pane || pane.terminal_id !== message.terminal) { socket.destroy(); return; }
          authenticated = true; this.socket = socket; this.send = send; this.size = size; Object.assign(this.shadow.terminal, size);
          clearTimeout(this.startupTimer); send({ type: 'welcome', version: VERSION }); this.resolveReady(); this.requestRender();
        })().catch(() => socket.destroy());
        return;
      }
      if (message.type === 'ping') { send({ type: 'pong' }); return; }
      if (!Number.isSafeInteger(message.seq) || message.seq !== seq + 1) throw new Error('IPC input sequence mismatch');
      seq = message.seq;
      if (message.type === 'resize') { this.size = dimensions(message); Object.assign(this.shadow.terminal, this.size); this.component.invalidate(); }
      else if (message.type === 'input' && typeof message.data === 'string' && Buffer.byteLength(message.data) <= MAX_INPUT_BYTES) this.component.handleInput(message.data);
      else if (message.type === 'mouse' && validMouse(message.event, this.size)) this.component.handleMouse?.(message.event);
      else if (message.type === 'timing' && validTiming(message)) {
        try { this.options.onTiming?.({ startedAtMs: message.startedAtMs, firstWriteMs: message.firstWriteMs, inputReadyMs: message.inputReadyMs, frameWriteMs: message.frameWriteMs }); } catch { /* optional instrumentation */ }
      }
      else throw new Error('Invalid IPC input');
      send({ type: 'ack', seq }); this.requestRender();
    }, () => socket.destroy()));
  }
  requestRender() {
    if (this.closed || this.renderScheduled) return;
    this.renderScheduled = true;
    setImmediate(() => {
      this.renderScheduled = false;
      if (this.closed || !this.socket) return;
      try { this.send({ type: 'frame', ...this.size, lines: this.component.render(this.size.columns).slice(0, this.size.rows) }, true); }
      catch (error) { this.fail(error); }
    });
  }
  setDraft(value) { this.component?.setDraft?.(value); }
  refresh(state = 'idle') {
    this.component?.refresh?.(); this.requestRender();
    this.desiredState = state;
    if (!this.reporting) this.reporting = this.reportState().finally(() => { this.reporting = null; });
  }
  async reportState() {
    while (!this.closed && this.pane.terminal && this.reportedState !== this.desiredState) {
      const state = this.desiredState;
      try { if (!await this.pane.report(state)) return; this.reportedState = state; } catch { return; }
    }
  }
  async reconcile() {
    if (this.closed || this.reconciling) return;
    this.reconciling = true;
    try {
      await this.pane.parent();
      if (!await this.pane.current()) await this.close();
    } catch (error) { this.fail(error); }
    finally { this.reconciling = false; }
  }
  close() {
    if (this.closed) return this.closing ?? this.done;
    this.closed = true; this.rejectReady(new Error('BTW surface closed'));
    clearInterval(this.pollTimer); clearTimeout(this.startupTimer);
    try { this.options.onClosed?.(); } catch { /* a callback must never prevent cleanup */ }
    this.closing = (async () => {
      await this.opening?.catch(() => {});
      this.send?.({ type: 'shutdown' });
      for (const socket of this.connections) socket.destroy();
      await this.reporting?.catch(() => {});
      await this.pane.close().catch(() => {});
      await new Promise(resolve => this.server ? this.server.close(resolve) : resolve());
      try { this.component?.dispose?.(); } catch { /* still remove the capability directory */ }
      if (this.directory) { await fs.rm(this.directory, { recursive: true, force: true }); liveDirectories.delete(this.directory); }
    })().finally(() => this.resolveClosed());
    return this.closing;
  }
}
