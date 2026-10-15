import { hostDir as host, hostDependencyPath } from './host.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
// These are intentionally internal-surface regressions; native has separate coverage.
process.env.PI_BTW_SURFACE = 'internal';
const tuiDir = hostDependencyPath('@earendil-works/pi-tui', 'dist');
const { createJiti } = await import(pathToFileURL(hostDependencyPath('jiti', 'lib/jiti.mjs')));
const jiti = createJiti(import.meta.url, { fsCache: false, alias: {
  '@earendil-works/pi-tui': path.join(tuiDir, 'index.js'),
  '@earendil-works/pi-coding-agent': path.join(host, 'dist/index.js'),
  '@earendil-works/pi-ai': hostDependencyPath('@earendil-works/pi-ai', 'dist/index.js'),
} });
const { createBtwSplitLayout, getBtwGeometry } = await jiti.import('../extensions/btw-split-layout.ts');
const { TuiAltScreen, ScrollView, VStack, Text, Markdown, visibleWidth } = await import(pathToFileURL(path.join(tuiDir, 'index.js')));
const { renderLayoutFrame } = await import(pathToFileURL(path.join(tuiDir, 'layout.js')));

function fixture(columns = 160, rows = 40) {
  const terminal = { columns, rows, write() {}, start() {}, stop() {}, hideCursor() {}, showCursor() {} };
  const tui = new TuiAltScreen(terminal);
  const widths = [];
  const content = { render(width) { widths.push(width); return ['主聊天 ' + '文字'.repeat(70)].flatMap(line => {
    const chunks = []; for (let i = 0; i < line.length; i += Math.max(1, Math.floor(width / 2))) chunks.push(line.slice(i, i + Math.floor(width / 2)));
    return chunks;
  }); }, invalidate() {} };
  const transcript = new ScrollView(content, { primary: true, follow: 'end' });
  const original = new VStack([{ component: transcript, basis: 0, grow: 1 }, new Text('MAIN EDITOR')]);
  tui.setLayoutRoot(original);
  let mode = 'window';
  const layout = createBtwSplitLayout(tui, () => mode);
  return { terminal, tui, layout, original, widths, transcript, setMode(value) { mode = value; },
    frame() { layout.options.visible(terminal.columns, terminal.rows); return renderLayoutFrame(tui.layoutRoot, terminal.columns, terminal.rows, () => {}); } };
}

test('integer geometry covers width exactly at odd and even terminal sizes', () => {
  for (const width of [120, 121, 159, 160, 201]) {
    const g = getBtwGeometry(width, 40, true, 'window');
    assert.equal(g.split, true); assert.equal(g.col, g.leftWidth); assert.equal(g.col + g.width, width);
  }
});
test('main document genuinely reflows at left width; primary ScrollView remains intact', () => {
  const f = fixture(); const frame = f.frame();
  assert.equal(f.layout.geometry().leftWidth, 96);
  assert.ok(f.widths.every(width => width <= 96));
  assert.equal(frame.primaryScrollView, f.transcript);
  assert.equal(frame.root.children[0].rect.width, 96);
  assert.equal(frame.root.children[1].rect.x, 96);
  assert.equal(f.layout.options.col, 96); assert.equal(f.layout.options.width, 64);
  assert.ok(frame.lines.every(line => visibleWidth(line) <= 160));
  f.layout.dispose(); assert.equal(f.tui.layoutRoot, f.original);
});
test('resize fallback and restoration keep the same root, focus and aligned options', () => {
  const f = fixture(); const root = f.tui.layoutRoot;
  const editor = { render: () => ['editor'], invalidate() {}, focused: false };
  f.tui.setFocus(editor);
  f.terminal.columns = 100; f.frame();
  assert.equal(f.layout.geometry().split, false); assert.equal(f.tui.layoutRoot, root);
  assert.equal(f.tui.getFocusedComponent(), editor);
  f.terminal.columns = 161; const frame = f.frame();
  assert.equal(f.layout.options.col, frame.root.children[1].rect.x);
  assert.equal(f.layout.options.width, frame.root.children[1].rect.width);
  f.terminal.rows = 10; f.frame(); assert.equal(f.layout.geometry().split, false);
  f.terminal.rows = 40; f.frame(); assert.equal(f.layout.geometry().split, true);
});
test('Alt+w full mode stops reserving the sidebar and returning restores it', () => {
  const f = fixture(); f.setMode('full'); const full = f.frame();
  assert.equal(full.root.children.length, 1); assert.equal(full.root.children[0].rect.width, 160);
  assert.equal(f.layout.options.width, 160); assert.equal(f.layout.options.col, 0);
  f.setMode('window'); assert.equal(f.frame().root.children.length, 2);
});
test('dispose is idempotent and never restores over a different layout owner', () => {
  const f = fixture(); f.layout.dispose(); f.layout.dispose(); assert.equal(f.tui.layoutRoot, f.original);
  const second = createBtwSplitLayout(f.tui, () => 'window');
  const replacement = new Text('replacement'); f.tui.setLayoutRoot(replacement);
  second.dispose(); assert.equal(f.tui.layoutRoot, replacement);
});
test('missing private root and regular mode fall back without mounting', () => {
  for (const mode of ['regular', 'fullscreen']) {
    const tui = { mode, terminal: { columns: 160, rows: 40 } };
    const layout = createBtwSplitLayout(tui, () => 'window');
    assert.equal(layout.supported, false); assert.equal(layout.geometry().split, false); layout.dispose();
  }
});
test('small terminal geometry never exceeds its bounds', () => {
  for (const columns of [1, 10, 24, 80, 119, 120, 160]) for (const rows of [1, 4, 8, 13, 14, 40]) {
    for (const mode of ['window', 'full']) {
      const g = getBtwGeometry(columns, rows, true, mode);
      assert.ok(g.width > 0 && g.height > 0);
      assert.ok(g.col >= 0 && g.col + g.width <= columns);
      assert.ok(g.row >= 0 && g.row + g.height <= rows);
    }
  }
});


test('real extension opens only on command, preserves draft/focus, and cleans up', async () => {
  const { default: extension } = await jiti.import('../extensions/btw.ts');
  const { initTheme } = await import(pathToFileURL(path.join(host, 'dist/modes/interactive/theme/theme.js')));
  initTheme('dark', false);
  const { getThemeByName } = await import(pathToFileURL(path.join(host, 'dist/modes/interactive/theme/theme.js')));
  const theme = getThemeByName('dark');
  const commands = new Map(), events = new Map(), shortcuts = new Map();
  extension({ registerCommand: (name, value) => commands.set(name, value),
    registerShortcut: (name, value) => shortcuts.set(name, value), registerMessageRenderer() {},
    on: (name, value) => events.set(name, value), events: { emit() {} }, appendEntry() {}, getThinkingLevel: () => 'off' });
  const f = fixture(); f.layout.dispose();
  const editor = { render: () => ['editor'], invalidate() {}, focused: false };
  f.tui.setFocus(editor);
  let overlay, overlayHandle, overlayPromise;
  const notices = [];
  const ctx = { mode: 'tui', hasUI: true, model: undefined, cwd: '/tmp', isIdle: () => true,
    sessionManager: { getBranch: () => [] }, ui: { theme, setWidget() {}, notify: (...args) => notices.push(args),
      custom: async (factory) => {
        let done;
        overlayPromise = new Promise(resolve => { done = resolve; });
        await factory(f.tui, theme, { matches: () => false }, done);
        return overlayPromise;
      } } };
  const originalShow = f.tui.showOverlay.bind(f.tui);
  f.tui.showOverlay = (component, options) => {
    overlay = component; overlayHandle = originalShow(component, options); return overlayHandle;
  };
  await events.get('session_start')({}, ctx);
  assert.equal(f.tui.layoutRoot, f.original, 'startup must not split');
  await commands.get('btw').handler('', ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.notEqual(f.tui.layoutRoot, f.original);
  assert.ok(overlay); assert.equal(overlayHandle.isFocused(), true);
  const frame = renderLayoutFrame(f.tui.layoutRoot, 160, 40, () => {});
  const screen = f.tui.compositeOverlays(frame.lines, 160, 40);
  assert.equal(screen.length, 40);
  assert.deepEqual(overlayHandle.getBounds(), { row: 0, col: 96, width: 64, height: 40 });
  assert.ok(screen.every(line => visibleWidth(line) <= 160));
  const entries = Array.from({ length: 60 }, (_, i) => ({ type: 'assistant-text', text: `## Answer ${i}\n\n中文 **text**`, streaming: false }));
  const originalMarkdownRender = Markdown.prototype.render;
  let markdownRenders = 0;
  Markdown.prototype.render = function(width) { markdownRenders++; return originalMarkdownRender.call(this, width); };
  try {
    overlay.readTranscriptEntries = () => entries;
    overlay.refresh(); overlay.render(64);
    assert.ok(markdownRenders >= 60);
    const wrapped = overlay.wrapTranscript(62);
    assert.equal(overlay.wrapTranscript(62), wrapped, 'typing/scroll frames must reuse wrapped history');
    markdownRenders = 0;
    overlay.refresh(); overlay.render(64);
    assert.equal(markdownRenders, 0, 'status/focus refresh must not reparse completed history');
    entries[59] = { ...entries[59], text: entries[59].text + ' token', streaming: true };
    overlay.refresh(); overlay.render(64);
    assert.equal(markdownRenders, 1, 'stream delta must render only changed Markdown');
    markdownRenders = 0;
    overlay.render(80);
    assert.equal(markdownRenders, 60, 'resize must invalidate width-dependent Markdown');
    markdownRenders = 0;
    overlay.invalidate(); overlay.render(80);
    assert.equal(markdownRenders, 60, 'theme invalidation must not retain styled cached history');
  } finally { Markdown.prototype.render = originalMarkdownRender; }
  overlay.setDraft('中文 draft');
  await shortcuts.get('alt+w').handler(ctx); await new Promise(resolve => setImmediate(resolve));
  f.tui.compositeOverlays(renderLayoutFrame(f.tui.layoutRoot, 160, 40, () => {}).lines, 160, 40);
  assert.equal(overlayHandle.getBounds().width, 160);
  await shortcuts.get('alt+w').handler(ctx); await new Promise(resolve => setImmediate(resolve));
  f.tui.compositeOverlays(renderLayoutFrame(f.tui.layoutRoot, 160, 40, () => {}).lines, 160, 40);
  assert.equal(overlayHandle.getBounds().width, 64);
  assert.equal(overlay.getDraft(), '中文 draft');
  await shortcuts.get('alt+/').handler(ctx);
  assert.equal(overlayHandle.isFocused(), false); assert.notEqual(f.tui.layoutRoot, f.original);
  await shortcuts.get('alt+/').handler(ctx); assert.equal(overlayHandle.isFocused(), true);
  overlay.handleInput('\x1b');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.tui.layoutRoot, f.original);
  await commands.get('side').handler('', ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(overlay.getDraft(), '中文 draft');
  f.terminal.columns = 80; f.terminal.rows = 8;
  const narrow = renderLayoutFrame(f.tui.layoutRoot, 80, 8, () => {});
  const narrowScreen = f.tui.compositeOverlays(narrow.lines, 80, 8);
  assert.equal(overlayHandle.getBounds().height, 4);
  assert.ok(narrowScreen.some(line => line.includes('draft')), 'short terminal retains input');
  f.terminal.columns = 160; f.terminal.rows = 40;
  await events.get('session_tree')({}, ctx);
  assert.equal(f.tui.layoutRoot, f.original);
  await commands.get('btw').handler('', ctx); await new Promise(resolve => setImmediate(resolve));
  await commands.get('btw:clear').handler('', ctx);
  assert.equal(f.tui.layoutRoot, f.original);
  const originalCustom = ctx.ui.custom;
  ctx.ui.custom = async () => { throw new Error('injected factory failure'); };
  await commands.get('btw').handler('', ctx); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.tui.layoutRoot, f.original, 'factory failure must release the sidebar');
  assert.ok(notices.some(args => String(args[0]).includes('injected factory failure')));
  ctx.ui.custom = originalCustom;
  await events.get('session_shutdown')({}, ctx);
  assert.equal(f.tui.layoutRoot, f.original);
  assert.ok(!notices.some(args => args[1] === 'error' && String(args[0]).includes('split')));
});


test('fullscreen wheel, main selection, sticky width, dialogs and proxy cleanup', async () => {
  const { createInteractiveTuiReference } = await import(pathToFileURL(path.join(host, 'dist/modes/interactive/tui-renderer.js')));
  const f = fixture(); f.layout.dispose();
  f.transcript.child.render = width => Array.from({ length: 120 }, (_, i) => ('MAIN line ' + i).padEnd(width, '.'));
  const proxy = createInteractiveTuiReference(() => f.tui);
  const originalHasOverlay = f.tui.hasOverlay;
  const layout = createBtwSplitLayout(proxy, () => 'window');
  let sideWheel = 0;
  const sidebar = { render: width => Array.from({ length: 40 }, () => 'SIDE'.padEnd(width, '-')), invalidate() {},
    handleMouse(event) { if (event.type === 'wheel') { sideWheel += event.wheelDelta; return { handled: true }; } } };
  class PinBar { render(width) { return ['PIN'.padEnd(width, '=')]; } invalidate() {} }
  const pinOptions = { row: 0, col: 0, width: '100%', nonCapturing: true };
  const pin = f.tui.showOverlay(new PinBar(), pinOptions);
  layout.bindOverlay(sidebar);
  const side = f.tui.showOverlay(sidebar, layout.options); side.focus();
  f.tui.start();
  f.tui.renderNow(true);
  assert.equal(f.tui.getScreenLines().length, 40);
  assert.equal(pinOptions.width, 96);
  assert.ok(f.transcript.getContentWidth(160) <= 96, 'sticky anchor measurements must use main allocation');
  assert.equal(f.tui.hasOverlay(), false, 'reserved sidebar must not suppress main selection');
  const before = f.transcript.scrollTop;
  f.tui.handleViewportInput('\x1b[<64;10;10M');
  assert.ok(f.transcript.scrollTop < before); assert.equal(sideWheel, 0);
  f.tui.handleViewportInput('\x1b[<65;120;10M'); assert.ok(sideWheel > 0);
  f.tui.renderNow();
  f.tui.handleViewportInput('\x1b[<0;3;3M');
  f.tui.handleViewportInput('\x1b[<32;8;5M');
  f.tui.handleViewportInput('\x1b[<0;8;5m');
  const copied = f.tui.getActiveSelectionText();
  assert.ok(copied && copied.includes('MAIN')); assert.ok(!copied.includes('SIDE'));
  const dialog = f.tui.showOverlay(new Text('DIALOG'), { width: 20 });
  assert.equal(f.tui.hasOverlay(), true, 'unrelated dialog retains stock selection suppression');
  dialog.hide(); assert.equal(f.tui.hasOverlay(), false);
  layout.dispose(); side.hide();
  assert.equal(pinOptions.width, '100%'); assert.equal(f.tui.layoutRoot, f.original);
  assert.equal(f.tui.hasOverlay(), true, 'preexisting pin remains visible after proxy restoration');
  pin.hide(); assert.equal(f.tui.hasOverlay(), false);
  assert.ok(typeof originalHasOverlay === 'function');
  f.tui.stop();
});
