import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type * as Backend from "../native/surface.mjs";

/**
 * Pi reload invalidates its TS factory, not Node's native ESM URL cache. Keep the
 * SDK-free host graph (surface -> herdr -> protocol) in a fresh synchronous Jiti
 * scope per extension factory. Do not native-import only the outer module with a
 * query: its static children would remain stale. The terminal frontend is a new
 * Node process and continues using the same, unmodified .mjs sources.
 *
 * This scope contains only our native modules and Node builtins, never Pi SDKs;
 * the host's module mapping and class/registry identity are left untouched.
 */
export function loadNativeBackend(): typeof Backend {
  const require = createRequire(import.meta.url);
  const { createJiti } = require("jiti") as typeof import("jiti");
  const load = createJiti(import.meta.url, {
    moduleCache: false,
    fsCache: false,
    tryNative: false,
  });
  return load(fileURLToPath(new URL("../native/surface.mjs", import.meta.url))) as typeof Backend;
}
