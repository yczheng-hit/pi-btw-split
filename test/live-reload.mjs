// Opt-in real bundled Pi TUI + native frontend. Only a private XDG pidtest server.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { hostDir, herdrExtension } from './host.mjs';
import { herdrApi } from '../native/herdr.mjs';
const xdg = process.env.XDG_CONFIG_HOME, socket = process.env.HERDR_SOCKET_PATH;
if (process.env.PI_BTW_LIVE_TEST !== '1' || !xdg?.startsWith('/tmp/btw-pidtest-') || socket !== path.join(xdg, 'herdr/sessions/pidtest/herdr.sock')) throw new Error('Private /tmp/btw-pidtest-* XDG pidtest socket and PI_BTW_LIVE_TEST=1 required');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))), api = herdrApi(socket);
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'btw-live-reload-'));
const copy = path.join(dir, 'package'), label = path.basename(dir), log = path.join(dir, 'versions.jsonl');
let terminal, registered = false;
const panes = async () => (await api('pane.list')).panes;
const until = async (check, description) => {
  const end = Date.now() + 20000;
  do { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 40)); } while (Date.now() < end);
  throw new Error('Timed out: ' + description);
};
const refs = async () => (await fs.readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
const cli = (...args) => {
  const result = spawnSync('herdr', ['--session', 'pidtest', ...args], { encoding: 'utf8', env: { ...process.env, HERDR_SOCKET_PATH: socket } });
  assert.equal(result.status, 0, result.stderr); return result.stdout;
};
try {
  const plugins = (await api('plugin.list')).plugins;
  assert.ok(!plugins.some(p => p.plugin_id === 'local.pi-btw-light'), 'Never replace an existing plugin registration');
  await fs.mkdir(copy);
  for (const name of ['extensions', 'native']) await fs.cp(path.join(root, name), path.join(copy, name), { recursive: true });
  for (const name of ['package.json', 'herdr-plugin.toml']) await fs.copyFile(path.join(root, name), path.join(copy, name));
  await fs.symlink(path.join(root, 'node_modules'), path.join(copy, 'node_modules'), 'dir');
  const entry = path.join(copy, 'extensions/btw.ts');
  const originals = Object.fromEntries(await Promise.all(['extensions/btw.ts', 'native/surface.mjs', 'native/herdr.mjs', 'native/protocol.mjs'].map(async name => [name, await fs.readFile(path.join(copy, name), 'utf8')])));
  async function edit(version) {
    let source = originals['extensions/btw.ts'];
    if (process.env.BTW_RELOAD_LEGACY === '1') source = source.replace('import type { NativeSurface } from "../native/surface.mjs";', 'import { NativeSurface } from "../native/surface.mjs";').replace('  const { NativeSurface } = loadNativeBackend();', '');
    source = source.replace('await surface.open();', `await surface.open();\n      writeFileSync(${JSON.stringify(log)}, JSON.stringify({ entry: ${version}, surface: surface.reloadProbe, herdr: surface.pane.reloadProbe, protocol: JSON.parse(readFileSync(surface.capabilityPath, 'utf8')).version, mode: ctx.mode }) + '\\n', { flag: 'a' });`);
    await fs.writeFile(entry, source);
    await fs.writeFile(path.join(copy, 'native/surface.mjs'), originals['native/surface.mjs'] + `\nNativeSurface.prototype.reloadProbe = ${version};\n`);
    await fs.writeFile(path.join(copy, 'native/herdr.mjs'), originals['native/herdr.mjs'] + `\nOwnedPane.prototype.reloadProbe = ${version};\n`);
    await fs.writeFile(path.join(copy, 'native/protocol.mjs'), originals['native/protocol.mjs'].replace('export const VERSION = 1;', `export const VERSION = ${version};`));
  }
  await edit(1); cli('plugin', 'link', copy); registered = true;
  const identityLog = path.join(dir, 'identity.jsonl');
  await api('layout.apply', { focus: false, tab_label: label, root: { type: 'pane', label, cwd: dir,
    env: { PI_CODING_AGENT_DIR: path.join(dir, 'agent'), PI_SKIP_VERSION_CHECK: '1', JITI_FS_CACHE: 'false', BTW_IDENTITY_LOG: identityLog, PI_BTW_SURFACE: 'native' },
    command: [process.execPath, path.join(hostDir, 'dist/bundle/cli.js'), '--offline', '--no-mcp', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '-e', herdrExtension, '-e', path.join(root, 'test/live-fixtures/identity-probe.ts'), '-e', entry, '-e', path.join(root, 'test/live-fixtures/fake-provider.ts'), '--model', 'btw-live-fake/fixture', '--session', path.join(dir, 'session.jsonl')] } });
  const parent = await until(async () => (await panes()).find(p => p.label === label), 'test parent'); terminal = parent.terminal_id;
  const current = async () => (await panes()).find(p => p.terminal_id === terminal);
  const send = async text => { const p = await current(); assert.equal(p.label, label); await api('pane.send_text', { pane_id: p.pane_id, text }); await api('pane.send_keys', { pane_id: p.pane_id, keys: ['enter'] }); };
  let previousChild;
  for (let version = 1; version <= 3; version++) {
    if (version > 1) {
      await edit(version); await send('/reload');
      await until(async () => !(await panes()).some(p => p.terminal_id === previousChild), 'old native pane closed by reload');
    }
    await until(async () => (await fs.readFile(identityLog, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).length === version, 'session_start/reload');
    const official = (await current()).agent_session;
    assert.equal(official?.value, path.join(dir, 'session.jsonl'), 'Only the official integration owns parent identity');
    await send('/btw');
    const versions = await until(async () => { const records = await refs(); return records.length === version && records.at(-1); }, 'native version markers').catch(async error => {
      const p = await current();
      const screen = p ? (await api('pane.read', { pane_id: p.pane_id, source: 'visible', format: 'text' })).read.text : 'test parent exited';
      throw new Error(`${error.message}; fixture records=${JSON.stringify(await refs())}; test-only screen=${screen}`);
    });
    assert.deepEqual(versions, { entry: version, surface: version, herdr: version, protocol: version, mode: 'tui' });
    const child = await until(async () => (await panes()).find(p => p.agent === 'btw-light'), 'owned native child');
    assert.equal(child.agent_session, undefined); previousChild = child.terminal_id;
    await until(async () => (await api('pane.read', { pane_id: (await panes()).find(p => p.terminal_id === previousChild)?.pane_id, source: 'visible', format: 'text' })).read.text.includes('BTW ·'), 'real native frontend frame');
    console.log(`PASS bundled Pi TUI source edit/reload generation ${version}: full graph + official identity + native frame`);
  }
} finally {
  if (terminal) { const p = (await panes()).find(p => p.terminal_id === terminal); if (p?.label === label) await api('pane.close', { pane_id: p.pane_id }); }
  if (registered) cli('plugin', 'unlink', 'local.pi-btw-light');
  await fs.rm(dir, { recursive: true, force: true });
}
