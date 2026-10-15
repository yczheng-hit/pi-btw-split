// Shared by the in-process backend and the SDK-free terminal frontend.
export const VERSION = 1;
export const MAX_MESSAGE_BYTES = 1024 * 1024;
export const MAX_INPUT_BYTES = 64 * 1024;

export function createDecoder(onMessage, onError, maxBytes = MAX_MESSAGE_BYTES) {
  let pending = Buffer.alloc(0), failed = false;
  return chunk => {
    if (failed) return;
    try {
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      let end;
      while ((end = pending.indexOf(10)) !== -1) {
        if (end > maxBytes) throw new Error('IPC message too large');
        const line = pending.subarray(0, end); pending = pending.subarray(end + 1);
        const message = JSON.parse(line.toString('utf8'));
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('IPC object required');
        onMessage(message);
      }
      if (pending.length > maxBytes) throw new Error('IPC message too large');
    } catch (error) { failed = true; pending = Buffer.alloc(0); onError(error); }
  };
}

export function createSender(socket) {
  let blocked = false, latest, controls = [], bytes = 0;
  const write = text => { blocked = !socket.write(text); };
  socket.on('drain', () => {
    blocked = false;
    while (!blocked && controls.length) { const text = controls.shift(); bytes -= Buffer.byteLength(text); write(text); }
    if (!blocked && latest) { const text = latest; latest = undefined; write(text); }
  });
  return (message, coalesce = false) => {
    if (socket.destroyed) return;
    const text = JSON.stringify(message) + '\n';
    const size = Buffer.byteLength(text);
    if (size > MAX_MESSAGE_BYTES || socket.writableLength > MAX_MESSAGE_BYTES * 2) { socket.destroy(); return; }
    if (!blocked) write(text);
    else if (coalesce) latest = text;
    else {
      controls.push(text); bytes += size;
      if (controls.length > 128 || bytes > MAX_MESSAGE_BYTES) socket.destroy();
    }
  };
}

export function dimensions(message) {
  if (!Number.isInteger(message.columns) || !Number.isInteger(message.rows) || message.columns < 1 || message.rows < 1 || message.columns > 512 || message.rows > 256) throw new Error('Invalid terminal dimensions');
  return { columns: message.columns, rows: message.rows };
}

export function validMouse(event, size = { columns: 512, rows: 256 }) {
  return event && ['press', 'release', 'move', 'drag', 'click', 'wheel'].includes(event.type) &&
    ['left', 'middle', 'right', 'none'].includes(event.button) &&
    ['x', 'y', 'screenX', 'screenY', 'width', 'height'].every(key => Number.isInteger(event[key])) &&
    event.width > 0 && event.width <= size.columns && event.height > 0 && event.height <= size.rows &&
    event.x >= 0 && event.x < event.width && event.y >= 0 && event.y < event.height &&
    event.screenX >= 0 && event.screenX < size.columns && event.screenY >= 0 && event.screenY < size.rows &&
    ['shift', 'alt', 'ctrl'].every(key => typeof event[key] === 'boolean') &&
    (event.wheelDelta === undefined || (Number.isFinite(event.wheelDelta) && Math.abs(event.wheelDelta) <= 256)) &&
    (event.clickCount === undefined || (Number.isInteger(event.clickCount) && event.clickCount >= 0 && event.clickCount <= 16));
}

export function validTiming(message) {
  return ['firstWriteMs', 'inputReadyMs', 'frameWriteMs'].every(key => Number.isFinite(message[key]) && message[key] >= 0 && message[key] < 60000) &&
    message.frameWriteMs >= message.firstWriteMs && message.frameWriteMs >= message.inputReadyMs &&
    (message.startedAtMs === undefined || (Number.isFinite(message.startedAtMs) && Math.abs(Date.now() - message.startedAtMs) < 60000));
}
