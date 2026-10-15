// Lightweight PTY surface. Intentionally NEVER import Pi SDK, extensions or models.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createDecoder, createSender, VERSION, MAX_INPUT_BYTES } from './protocol.mjs';
import { herdrApi } from './herdr.mjs';

const started = performance.now();
let tui, socket, heartbeat, stopped = false;
function stop(message = '') {
  if (stopped) return; stopped = true; clearInterval(heartbeat); socket?.destroy();
  tui?.stop();
  if (message) process.stdout.write(`\r\nBTW disconnected: ${message}\r\nReopen /btw in the main Pi pane.\r\n`);
  process.exitCode = message ? 1 : 0;
}
process.on('SIGTERM', () => stop()); process.on('SIGINT', () => stop());

try {
  const capabilityPath = process.env.PI_BTW_CAPABILITY;
  const stat = await fs.stat(capabilityPath);
  const dir = await fs.stat(path.dirname(capabilityPath));
  if ((stat.mode & 0o077) || (dir.mode & 0o077) || stat.uid !== process.getuid() || !stat.isFile() || stat.size > 4096) throw new Error('Unsafe BTW connection file');
  const capability = JSON.parse(await fs.readFile(capabilityPath, 'utf8'));
  if (capability.version !== VERSION) throw new Error('BTW protocol version mismatch');
  const hostRequire = createRequire(path.join(process.env.PI_BTW_HOST_DIR, 'package.json'));
  const dist = path.dirname(hostRequire.resolve('@earendil-works/pi-tui'));
  // Avoid the barrel: it eagerly imports Markdown/LaTeX/editor modules we never use.
  const [{ TuiAltScreen }, { ProcessTerminal }, { truncateToWidth }, { CURSOR_MARKER }] = await Promise.all([
    'tui-alt-screen.js', 'terminal.js', 'utils.js', 'tui.js',
  ].map(file => import(pathToFileURL(path.join(dist, file)))));
  if (stopped) throw new Error('Stopped during startup');
  const terminal = new ProcessTerminal(); tui = new TuiAltScreen(terminal, true);
  let lines = ['BTW · connecting…', '', '> ' + CURSOR_MARKER], welcome = false, seq = 0, pending = [], pendingBytes = 0, lastSeen = Date.now(), lastSize = '';
  let firstWriteMs, inputReadyMs, framePending = false, timingSent = false;
  const write = terminal.write.bind(terminal);
  terminal.write = data => {
    write(data);
    // This measures handoff to the PTY, NOT Herdr compositor / physical display latency.
    if (firstWriteMs === undefined && data.includes('BTW')) firstWriteMs = performance.now() - started;
    if (framePending && !timingSent && firstWriteMs !== undefined && inputReadyMs !== undefined) {
      timingSent = true; framePending = false;
      transmit({ type: 'timing', startedAtMs: performance.timeOrigin + started, firstWriteMs, inputReadyMs, frameWriteMs: performance.now() - started });
    }
  };
  const size = () => ({ columns: Math.max(1, Math.min(512, terminal.columns)), rows: Math.max(1, Math.min(256, terminal.rows)) });
  const transmit = message => {
    if (stopped) return;
    if (!welcome) {
      pendingBytes += Buffer.byteLength(JSON.stringify(message)); pending.push(message);
      if (pending.length > 128 || pendingBytes > MAX_INPUT_BYTES) stop('Startup input queue exceeded');
    } else send({ ...message, seq: ++seq });
  };
  const resize = () => {
    if (!welcome) return;
    const dimensions = size(), key = `${dimensions.columns}:${dimensions.rows}`;
    if (key !== lastSize) { lastSize = key; transmit({ type: 'resize', ...dimensions }); }
  };
  const component = {
    focused: true,
    render(width) { resize(); return lines.slice(0, terminal.rows).map(line => truncateToWidth(line, width, '')); },
    invalidate() { resize(); },
    handleInput(data) { if (Buffer.byteLength(data) > MAX_INPUT_BYTES) stop('Paste too large (64 KiB limit)'); else transmit({ type: 'input', data }); },
    handleMouse(event) {
      if (event.type === 'wheel' || ((event.type === 'press' || event.type === 'click') && event.y === lines.findIndex(line => line.includes(CURSOR_MARKER)))) {
        transmit({ type: 'mouse', event }); return { handled: true, focus: true };
      }
      // Let pi-tui / Herdr handle normal selection instead of capturing drags.
      return undefined;
    },
  };
  tui.setLayoutRoot(component); tui.setFocus(component); tui.start(); tui.requestRender();
  const api = herdrApi();
  const { pane } = await api('pane.current', { caller_pane_id: process.env.HERDR_PANE_ID });
  if (stopped) throw new Error('Stopped during startup');
  socket = net.createConnection(capability.socket); const send = createSender(socket);
  socket.on('connect', () => send({ type: 'hello', version: VERSION, token: capability.token, session: capability.session, pane: pane.pane_id, terminal: pane.terminal_id, ...size() }));
  socket.on('error', error => stop(error.message)); socket.on('close', () => stop('Main Pi closed or reloaded'));
  socket.on('data', createDecoder(message => {
    lastSeen = Date.now();
    if (message.type === 'welcome' && message.version === VERSION && !welcome) {
      welcome = true; inputReadyMs = performance.now() - started;
      resize(); for (const input of pending) transmit(input); pending = []; pendingBytes = 0;
      send({ type: 'ping' });
    } else if (message.type === 'frame' && Array.isArray(message.lines) && message.lines.every(line => typeof line === 'string')) {
      const current = size();
      if (message.columns === current.columns && message.rows === current.rows) { lines = message.lines; framePending = true; tui.requestRender(); }
      else { lastSize = ''; resize(); }
    } else if (message.type === 'shutdown') stop();
    else if (!['ack', 'pong'].includes(message.type)) throw new Error('Unexpected BTW backend response');
  }, error => stop(error.message)));
  heartbeat = setInterval(() => {
    if (Date.now() - lastSeen > 12000) stop('Backend heartbeat timed out');
    else if (welcome) send({ type: 'ping' });
  }, 3000); heartbeat.unref();
} catch (error) { stop(error.message); }
