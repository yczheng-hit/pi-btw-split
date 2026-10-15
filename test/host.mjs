import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function packageRoot(require, name) {
  // Read metadata directly: some Pi packages expose only ESM import conditions,
  // so require.resolve(name) cannot locate them even though they are installed.
  for (const base of require.resolve.paths(name) ?? []) {
    const directory = path.join(base, name);
    try {
      if (JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8')).name === name) return directory;
    } catch {}
  }
  throw new Error(`Could not locate ${name}; run npm ci or set PI_HOST_DIR.`);
}

// Resolve from the selected host so both nested global installs and npm's hoisted
// local dev dependencies work, without mixing Pi versions in compatibility tests.
export const hostDir = process.env.PI_HOST_DIR
  ? path.resolve(process.env.PI_HOST_DIR)
  : packageRoot(createRequire(import.meta.url), '@earendil-works/pi-coding-agent');
const hostRequire = createRequire(path.join(hostDir, 'package.json'));
export function hostDependencyPath(name, ...parts) {
  return path.join(packageRoot(hostRequire, name), ...parts);
}
export const herdrExtension = process.env.PI_HERDR_EXTENSION ?? path.join(
  process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), '.pi', 'agent'),
  'extensions', 'herdr-agent-state.ts',
);
