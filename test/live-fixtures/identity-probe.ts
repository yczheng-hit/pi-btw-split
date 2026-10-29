// Test-only: session metadata, never transcript or credentials.
import { appendFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
export default function (pi: ExtensionAPI) {
  pi.on('session_start', (_event, ctx) => {
    if (process.env.BTW_IDENTITY_LOG) appendFileSync(process.env.BTW_IDENTITY_LOG,
      JSON.stringify({ mode: ctx.mode, sessionFile: ctx.sessionManager.getSessionFile(), pane: process.env.HERDR_PANE_ID }) + '\n');
  });
}
