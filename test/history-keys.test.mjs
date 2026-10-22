import { hostDir as host, hostDependencyPath } from './host.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
// Up/Down in the BTW composer must match the main editor: prompt history, not transcript scrolling.
process.env.PI_BTW_SURFACE = 'internal';
const tuiDir = hostDependencyPath('@earendil-works/pi-tui', 'dist');
const { createJiti } = await import(pathToFileURL(hostDependencyPath('jiti', 'lib/jiti.mjs')));
const jiti = createJiti(import.meta.url, { fsCache: false, alias: {
  '@earendil-works/pi-tui': path.join(tuiDir, 'index.js'),
  '@earendil-works/pi-coding-agent': path.join(host, 'dist/index.js'),
  '@earendil-works/pi-ai': hostDependencyPath('@earendil-works/pi-ai', 'dist/index.js'),
} });
const { TuiAltScreen, ScrollView, VStack, Text, KeybindingsManager, TUI_KEYBINDINGS } = await import(pathToFileURL(path.join(tuiDir, 'index.js')));
const { KEYBINDINGS } = await import(pathToFileURL(path.join(host, 'dist/core/keybindings.js')));
const { initTheme, getThemeByName } = await import(pathToFileURL(path.join(host, 'dist/modes/interactive/theme/theme.js')));
initTheme('dark', false);

const UP = '\x1b[A', DOWN = '\x1b[B', PGUP = '\x1b[5~', HOME = '\x1b[H';
const saved = (question) => ({ type: 'custom', customType: 'btw-thread-entry',
  data: { question, answer: `answer to ${question}`, timestamp: 1, provider: 'p', model: 'm', api: 'openai-responses' } });

async function openOverlay({ branch = [], userBindings = {} } = {}) {
  const { default: extension } = await jiti.import('../extensions/btw.ts');
  const commands = new Map(), events = new Map();
  extension({ registerCommand: (name, value) => commands.set(name, value), registerShortcut() {},
    registerMessageRenderer() {}, on: (name, value) => events.set(name, value), events: { emit() {} },
    appendEntry() {}, getThinkingLevel: () => 'off' });
  const terminal = { columns: 160, rows: 40, write() {}, start() {}, stop() {}, hideCursor() {}, showCursor() {} };
  const tui = new TuiAltScreen(terminal);
  const content = { render: () => Array.from({ length: 5 }, (_, i) => `main ${i}`), invalidate() {} };
  tui.setLayoutRoot(new VStack([{ component: new ScrollView(content, { primary: true, follow: 'end' }), basis: 0, grow: 1 }, new Text('EDITOR')]));
  const keys = new KeybindingsManager({ ...TUI_KEYBINDINGS, ...KEYBINDINGS }, userBindings);
  let overlay;
  const show = tui.showOverlay.bind(tui);
  tui.showOverlay = (component, options) => { overlay = component; return show(component, options); };
  const ctx = { mode: 'tui', hasUI: true, model: undefined, cwd: '/tmp', isIdle: () => true,
    sessionManager: { getBranch: () => branch },
    ui: { theme: getThemeByName('dark'), setWidget() {}, notify() {},
      custom: async (factory) => { let done; const p = new Promise(r => { done = r; }); await factory(tui, getThemeByName('dark'), keys, done); return p; } } };
  await events.get('session_start')({}, ctx);
  await commands.get('btw').handler('', ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(overlay, 'overlay opened');
  const type = (text) => { for (const ch of text) overlay.handleInput(ch); };
  return { overlay, current: () => overlay, type, ctx, events, commands, shutdown: () => events.get('session_shutdown')({}, ctx) };
}

test('Up/Down browse saved BTW questions like the main editor and restore the draft', async () => {
  // Questions from before a /btw:new reset still count, like the main editor after a reload.
  const branch = [saved('first'), { type: 'custom', customType: 'btw-thread-reset', data: { timestamp: 2, mode: 'contextual' } },
    saved('second'), saved('second'), saved('third')];
  const { overlay, type, shutdown } = await openOverlay({ branch });
  const cursor = () => overlay.input.cursor;
  overlay.handleInput(UP); assert.equal(overlay.getDraft(), 'third');
  assert.equal(cursor(), 0, 'Up places the cursor at the start, like the editor');
  overlay.handleInput(UP); assert.equal(overlay.getDraft(), 'second', 'consecutive duplicates collapse');
  overlay.handleInput(UP); assert.equal(overlay.getDraft(), 'first');
  overlay.handleInput(UP); assert.equal(overlay.getDraft(), 'first', 'stops at the oldest entry');
  overlay.handleInput(DOWN); assert.equal(overlay.getDraft(), 'second');
  assert.equal(cursor(), 'second'.length, 'Down places the cursor at the end');
  overlay.handleInput(DOWN); overlay.handleInput(DOWN); assert.equal(overlay.getDraft(), '', 'back to the empty draft');
  overlay.handleInput(DOWN); assert.equal(overlay.getDraft(), '');

  // A typed draft: Up first jumps to the line start, a second Up browses, Down restores it.
  type('half typed');
  overlay.handleInput(UP); assert.equal(overlay.getDraft(), 'half typed'); assert.equal(cursor(), 0);
  overlay.handleInput(UP); assert.equal(overlay.getDraft(), 'third');
  overlay.handleInput(DOWN); assert.equal(overlay.getDraft(), 'half typed');
  assert.equal(cursor(), 0, 'draft cursor restored');
  overlay.handleInput(DOWN); assert.equal(cursor(), 'half typed'.length, 'Down jumps to the end when not browsing');

  // Editing a recalled entry leaves browsing: Down no longer walks history.
  overlay.setDraft(''); overlay.handleInput(UP); overlay.handleInput(UP);
  assert.equal(overlay.getDraft(), 'second');
  overlay.handleInput(DOWN); overlay.handleInput(DOWN);
  assert.equal(overlay.getDraft(), '');
  overlay.handleInput(UP); overlay.handleInput('\x1b[F'); type('!');
  assert.equal(overlay.getDraft(), 'third!');
  overlay.handleInput(DOWN); assert.equal(overlay.getDraft(), 'third!', 'edited entry is now the draft');
  overlay.handleInput(HOME); overlay.handleInput(UP); assert.equal(overlay.getDraft(), 'third', 'Up at column 0 browses again');
  await shutdown();
});

test('Up/Down no longer scroll the transcript; PgUp still does', async () => {
  const { overlay, shutdown } = await openOverlay({ branch: Array.from({ length: 30 }, (_, i) => saved(`q${i}\n${'line\n'.repeat(5)}`)) });
  overlay.render(64);
  const start = overlay.transcriptScrollOffset;
  overlay.handleInput(UP); overlay.render(64);
  assert.equal(overlay.transcriptScrollOffset, start, 'Up must not scroll');
  overlay.handleInput(PGUP); overlay.render(64);
  assert.ok(overlay.transcriptScrollOffset < start, 'PgUp scrolls the transcript');
  assert.match(overlay.hintsTextValue, /↑↓ history/);
  await shutdown();
});

test('history survives closing BTW and includes newly submitted prompts; respects remapped keys', async () => {
  const { overlay, current, type, ctx, commands, shutdown } = await openOverlay({ branch: [saved('old')],
    userBindings: { 'tui.editor.historyPrevious': 'alt+p', 'tui.editor.historyNext': 'alt+n' } });
  // Every submitted prompt is recorded, even one the extension then refuses to send.
  type('/btw:nope'); overlay.handleInput('\r');
  assert.equal(overlay.getDraft(), '/btw:nope', 'refused submit keeps its draft');
  overlay.setDraft('');
  overlay.handleInput('\x1bp'); assert.equal(overlay.getDraft(), '/btw:nope', 'Alt+P = historyPrevious');
  overlay.handleInput('\x1bp'); assert.equal(overlay.getDraft(), 'old');
  overlay.handleInput('\x1bn'); assert.equal(overlay.getDraft(), '/btw:nope', 'Alt+N = historyNext');
  overlay.setDraft('');
  overlay.handleInput('\x1b');            // idle Esc closes the pane, keeping the thread
  await new Promise(resolve => setImmediate(resolve));
  await commands.get('btw').handler('', ctx); await new Promise(resolve => setImmediate(resolve));
  const reopened = current();
  assert.notEqual(reopened, overlay, 'a new component after reopening');
  reopened.handleInput(UP); assert.equal(reopened.getDraft(), '/btw:nope');
  reopened.handleInput(UP); assert.equal(reopened.getDraft(), 'old');
  reopened.setDraft('');
  // /btw <question> typed in the main editor is recalled too (the model call itself fails here).
  await commands.get('btw').handler('from main', ctx).catch(() => {});
  reopened.exitHistoryBrowsing(); reopened.setDraft('');
  reopened.handleInput(UP); assert.equal(current().getDraft(), 'from main');
  await shutdown();
});
