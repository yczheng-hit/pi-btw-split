import net from 'node:net';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createDecoder } from './protocol.mjs';

export const PLUGIN_ID = 'local.pi-btw-light';
export const AGENT = 'btw-light';

// Explicit IDs only. No CLI processes in the rendering/input path.
export function herdrApi(socketPath = process.env.HERDR_SOCKET_PATH) {
  return (method, params = {}) => new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const id = randomUUID(); let settled = false;
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error(`Herdr ${method} timed out; inspect before retrying`)), 4000);
    socket.on('error', error => finish(error));
    socket.on('close', () => { if (!settled) finish(new Error('Herdr disconnected')); });
    socket.on('connect', () => socket.write(JSON.stringify({ id, method, params }) + '\n'));
    socket.on('data', createDecoder(message => {
      if (message.id !== id) return;
      finish(message.error ? new Error(`Herdr ${method}: ${message.error.message ?? JSON.stringify(message.error)}`) : null, message.result);
    }, error => finish(error), 4 * 1024 * 1024));
  });
}

export function findSiblingSplit(root, main, btw, prefix = []) {
  if (root?.type !== 'split') return null;
  if (root.direction === 'right' && root.first?.type === 'pane' && root.first.pane_id === main && root.second?.type === 'pane' && root.second.pane_id === btw) return prefix;
  return findSiblingSplit(root.first, main, btw, [...prefix, false]) ?? findSiblingSplit(root.second, main, btw, [...prefix, true]);
}

export class OwnedPane {
  constructor({ api = herdrApi(), pluginRoot, parentPaneId, sessionFile, nonce, focus = true }) {
    Object.assign(this, { api, pluginRoot, parentPaneId, sessionFile, nonce });
    this.focusOnOpen = focus;
    this.source = `pi-btw:light:${nonce}`; this.seq = 0; this.claimed = false;
  }
  async parent(panes) {
    panes ??= (await this.api('pane.list', {})).panes;
    let pane = this.parentTerminal ? panes.find(p => p.terminal_id === this.parentTerminal) : panes.find(p => p.pane_id === this.parentPaneId);
    if (!pane && !this.parentTerminal) {
      // Herdr retains inherited public-ID aliases across workspace moves.
      const reference = (await this.api('pane.current', { caller_pane_id: this.parentPaneId })).pane;
      pane = panes.find(p => p.terminal_id === reference?.terminal_id);
    }
    if (!pane || pane.agent !== 'pi') throw new Error('Main Pi pane/session identity changed: parent pane is missing or no longer Pi');
    if (!pane.agent_session?.value) throw new Error(`Herdr has not reported this Pi session for pane ${pane.pane_id}; when Pi is idle, run /reload then /btw in this Pi. If it persists, check herdr integration status on this machine`);
    if (pane.agent_session.value !== this.sessionFile) throw new Error('Main Pi pane/session identity changed: session mismatch; run /session in this Pi and compare with herdr pane get on this machine');
    this.parentTerminal = pane.terminal_id; this.parentPaneId = pane.pane_id; return pane;
  }
  async current() {
    if (!this.terminal) return null;
    const panes = (await this.api('pane.list', {})).panes;
    const pane = panes.find(p => p.terminal_id === this.terminal);
    if (!pane || pane.terminal_id === this.parentTerminal || (pane.agent && pane.agent !== AGENT) || (this.claimed && pane.tokens?.btw_owner !== this.nonce)) return null;
    this.paneId = pane.pane_id; return pane;
  }
  async open(env, cwd) {
    if (this.terminal) { if (await this.current()) return this.focus(); throw new Error('BTW pane no longer owned'); }
    const plugins = (await this.api('plugin.list', {})).plugins;
    const plugin = plugins.find(p => p.plugin_id === PLUGIN_ID);
    const registeredRoot = plugin?.enabled ? await realpath(plugin.plugin_root).catch(() => path.resolve(plugin.plugin_root)) : null;
    const requestedRoot = await realpath(this.pluginRoot).catch(() => path.resolve(this.pluginRoot));
    if (!plugin || !plugin.enabled || registeredRoot !== requestedRoot) throw new Error(`Register the owned BTW plugin first: herdr plugin link ${this.pluginRoot}`);
    const main = await this.parent();
    const result = await this.api('plugin.pane.open', { plugin_id: PLUGIN_ID, entrypoint: 'btw', placement: 'split', direction: 'right', target_pane_id: main.pane_id, focus: this.focusOnOpen, cwd, env });
    const owned = result.plugin_pane;
    if (owned?.plugin_id !== PLUGIN_ID || owned.entrypoint !== 'btw' || !owned.pane?.terminal_id || owned.pane.terminal_id === main.terminal_id) throw new Error('Unexpected Herdr BTW launch identity');
    this.terminal = owned.pane.terminal_id; this.paneId = owned.pane.pane_id;
    await this.api('pane.report_metadata', { pane_id: this.paneId, source: this.source, display_agent: 'BTW', title: 'BTW', tokens: { btw_owner: this.nonce }, seq: ++this.seq });
    this.claimed = true;
    await this.report('idle');
    // Never change an ancestor split containing another pane.
    try {
      const exported = await this.api('layout.export', { pane_id: main.pane_id });
      const layout = exported.layout ?? exported;
      const split = findSiblingSplit(layout.root, main.pane_id, this.paneId);
      if (split !== null && await this.current()) await this.api('layout.set_split_ratio', { tab_id: layout.tab_id, path: split, ratio: 0.6 });
    } catch { /* ratio is cosmetic; leave Herdr's default if unavailable */ }
    return owned.pane;
  }
  async report(state) {
    const pane = await this.current(); if (!pane) return false;
    await this.api('pane.report_agent', { pane_id: pane.pane_id, source: this.source, agent: AGENT, state, seq: ++this.seq }); return true;
  }
  async focus(main = false) {
    const panes = (await this.api('pane.list', {})).panes;
    if (main) { const parent = await this.parent(panes); return this.api('agent.focus', { target: parent.pane_id }); }
    const pane = await this.current(); if (!pane) throw new Error('BTW pane no longer owned');
    return this.api('plugin.pane.focus', { pane_id: pane.pane_id });
  }
  async toggleFocus() { const pane = await this.current(); if (!pane) return; return this.focus(pane.focused); }
  async zoom() { const pane = await this.current(); if (pane) return this.api('pane.zoom', { pane_id: pane.pane_id, mode: 'toggle' }); }
  async close() {
    const pane = await this.current(); if (!pane) return;
    await this.api('pane.release_agent', { pane_id: pane.pane_id, source: this.source, agent: AGENT, seq: ++this.seq }).catch(() => {});
    // Reconcile again after release: moves and replacements must not hit stale IDs.
    const current = await this.current();
    if (current) await this.api('plugin.pane.close', { pane_id: current.pane_id });
  }
}
