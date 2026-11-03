// Source-edit reload regression: real Pi loader + actual BTW/native graph, no user sessions.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hostDir } from './host.mjs';
process.env.JITI_FS_CACHE = 'false';
const { DefaultResourceLoader, SettingsManager } = await import(pathToFileURL(path.join(hostDir, 'dist/index.js')));
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const probe = `
  pi.registerCommand('reload-native-probe', { description: 'ENTRY_VERSION', async handler(_args, ctx) {
    let child;
    const api = async (method, params) => {
      if (method === 'plugin.list') return { plugins: [{ plugin_id: 'local.pi-btw-light', plugin_root: 'ROOT', enabled: true }] };
      if (method === 'pane.list') return { panes: [{ pane_id: 'w1:p1', terminal_id: 'parent', agent: 'pi', agent_session: { value: 'fixture-session' } }, ...(child ? [child] : [])] };
      if (method === 'plugin.pane.open') { child = { pane_id: 'w1:p2', terminal_id: 'child' }; return { plugin_pane: { plugin_id: 'local.pi-btw-light', entrypoint: 'btw', pane: child } }; }
      if (method === 'pane.report_metadata') child.tokens = params.tokens;
      if (method === 'pane.report_agent') child.agent = params.agent;
      if (method === 'plugin.pane.close') child = undefined;
      return {};
    };
    const surface = new NativeSurface({ api, pluginRoot: 'ROOT', parentPaneId: 'w1:p1', sessionFile: 'fixture-session', hostDir: '/fixture', cwd: '/tmp', createComponent: () => ({ focused: false, render: () => [], invalidate() {}, handleInput() {}, dispose() {} }) });
    try {
      await surface.open();
      const cap = JSON.parse(readFileSync(surface.capabilityPath, 'utf8'));
      ctx.result = { entry: 'ENTRY_VERSION', surface: surface.reloadProbe, herdr: surface.pane.reloadProbe, protocol: cap.version, directory: surface.directory };
    } finally { await surface.close(); }
  } });
`;
test('source edits + real loader reload refresh entry, surface, herdr and protocol together', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'btw-source-reload-'));
  try {
    const copy = path.join(dir, 'package'); await fs.mkdir(copy);
    for (const name of ['extensions', 'native']) await fs.cp(path.join(root, name), path.join(copy, name), { recursive: true });
    await fs.copyFile(path.join(root, 'package.json'), path.join(copy, 'package.json'));
    await fs.symlink(path.join(root, 'node_modules'), path.join(copy, 'node_modules'), 'dir');
    const entry = path.join(copy, 'extensions/btw.ts');
    const originals = Object.fromEntries(await Promise.all(['extensions/btw.ts', 'native/surface.mjs', 'native/herdr.mjs', 'native/protocol.mjs'].map(async name => [name, await fs.readFile(path.join(copy, name), 'utf8')])));
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: path.join(dir, 'agent'), settingsManager: SettingsManager.inMemory(), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [entry] });
    const listeners = process.listenerCount('exit');
    for (let version = 1; version <= 4; version++) {
      const injected = probe.replaceAll('ENTRY_VERSION', String(version)).replaceAll('ROOT', copy);
      await fs.writeFile(entry, originals['extensions/btw.ts'].replace('const nativeSurfaces = new Set<NativeSurface>();', 'const nativeSurfaces = new Set<NativeSurface>();' + injected));
      await fs.writeFile(path.join(copy, 'native/surface.mjs'), originals['native/surface.mjs'] + `\nNativeSurface.prototype.reloadProbe = ${version};\n`);
      await fs.writeFile(path.join(copy, 'native/herdr.mjs'), originals['native/herdr.mjs'] + `\nOwnedPane.prototype.reloadProbe = ${version};\n`);
      await fs.writeFile(path.join(copy, 'native/protocol.mjs'), originals['native/protocol.mjs'].replace('export const VERSION = 1;', `export const VERSION = ${version};`));
      await loader.reload();
      const loaded = loader.getExtensions(); assert.deepEqual(loaded.errors, []);
      const ctx = {};
      await loaded.extensions[0].commands.get('reload-native-probe').handler('', ctx);
      const { directory, ...actual } = ctx.result;
      assert.deepEqual(actual, { entry: String(version), surface: version, herdr: version, protocol: version }, 'all native dependencies must update on reload');
      await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
    }
    assert.equal(process.listenerCount('exit'), listeners, 'closed generations must not retain exit listeners');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
