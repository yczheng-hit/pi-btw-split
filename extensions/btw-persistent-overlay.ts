import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Component, KeybindingsManager, OverlayHandle, OverlayOptions, TUI } from '@earendil-works/pi-tui';

/** Bootstrap the public TUI reference briefly, then own a normal TUI overlay.
 * Do not keep ctx.ui.custom pending: that masks nested approval UI events.
 * The caller owns handle.hide() and component.dispose(), including on errors.
 */
export async function getBtwUiResources(
  ctx: ExtensionContext,
  pi: Pick<ExtensionAPI, 'events'>,
): Promise<{ tui: TUI; theme: ExtensionContext['ui']['theme']; keys: KeybindingsManager }> {
  pi.events.emit('btw:ui-bootstrap', { active: true });
  let resources: { tui: TUI; theme: ExtensionContext['ui']['theme']; keys: KeybindingsManager };
  try {
    resources = await ctx.ui.custom((tui, theme, keys, done) => {
      done({ tui, theme, keys });
      return { render: () => [], invalidate() {} };
    });
  } finally {
    pi.events.emit('btw:ui-bootstrap', { active: false });
  }
  return resources;
}

export async function showBtwOverlay(
  ctx: ExtensionContext,
  pi: Pick<ExtensionAPI, 'events'>,
  factory: (tui: TUI, theme: ExtensionContext['ui']['theme'], keys: KeybindingsManager) => Component | Promise<Component>,
  options: () => OverlayOptions,
): Promise<{ component: Component; handle: OverlayHandle }> {
  const resources = await getBtwUiResources(ctx, pi);
  const component = await factory(resources.tui, resources.theme, resources.keys);
  try {
    return { component, handle: resources.tui.showOverlay(component, options()) };
  } catch (error) {
    (component as Component & { dispose?(): void }).dispose?.();
    throw error;
  }
}
