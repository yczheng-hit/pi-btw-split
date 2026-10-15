import { HStack, isViewportTUI, type Component, type OverlayOptions, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";

export type BtwLayoutMode = "window" | "full";
export const MIN_SPLIT_COLUMNS = 120;
export const MIN_SPLIT_ROWS = 14;

export function getBtwGeometry(columns: number, rows: number, split: boolean, mode: BtwLayoutMode) {
  const width = Math.max(1, Math.floor(columns));
  const height = Math.max(1, Math.floor(rows));
  if (split && mode !== "full" && width >= MIN_SPLIT_COLUMNS && height >= MIN_SPLIT_ROWS) {
    const sideWidth = Math.floor(width * 0.4);
    return { split: true, leftWidth: width - sideWidth, width: sideWidth, height, row: 0, col: width - sideWidth };
  }
  const inset = mode === "full" ? 0 : Math.min(2, Math.floor((width - 1) / 2));
  const panelWidth = mode === "full" ? width : Math.min(width - inset * 2, Math.max(Math.min(72, width - inset * 2), Math.floor(width * 0.78)));
  const top = height > 10 ? 1 : 0;
  const panelHeight = Math.min(height - top, Math.max(10, Math.min(32, Math.floor(height * 0.78))));
  return { split: false, leftWidth: width, width: panelWidth, height: panelHeight, row: top, col: Math.floor((width - panelWidth) / 2) };
}

// Pi exposes setLayoutRoot(), but not a getter. Keep this single internal seam
// defensive and never restore over a layout installed by another owner.
function readLayoutRoot(tui: TUI): Component | undefined {
  const root: unknown = Reflect.get(tui, "layoutRoot");
  if (root && typeof root === "object" && "render" in root && typeof root.render === "function" && "invalidate" in root && typeof root.invalidate === "function") {
    return root as Component;
  }
  return undefined;
}

// Sticky-last-prompt asks the primary transcript to measure at terminal width.
// Clamp that public measurement to its actual allocation while the split is on.
function findPrimary(component: Component, seen = new Set<Component>()): (Component & { primary: boolean; getContentWidth(width: number): number }) | undefined {
  if (seen.has(component)) return undefined;
  seen.add(component);
  const candidate = component as Component & { primary?: boolean; getContentWidth?: (width: number) => number; children?: Component[] };
  if (candidate.primary === true && typeof candidate.getContentWidth === "function") return candidate as Component & { primary: boolean; getContentWidth(width: number): number };
  for (const child of candidate.children ?? []) {
    const found = findPrimary(child, seen);
    if (found) return found;
  }
  return undefined;
}

class ReservedSidebar extends HStack {
  constructor(private readonly main: Component, private readonly geometry: () => ReturnType<typeof getBtwGeometry>, private readonly onWheel: (delta: number) => void) {
    super([
      { component: main, basis: 0, grow: 0, shrink: 0, visible: () => this.updateEntries() },
      { component: blank, basis: 0, grow: 0, shrink: 0, visible: () => this.geometry().split },
    ]);
  }
  // Stack visibility is evaluated before allocation on every frame. Reuse its
  // protected entries rather than depending on Pi's unexported layout symbol.
  private updateEntries(): boolean {
    const geometry = this.geometry();
    this.entries[0].basis = geometry.leftWidth;
    this.entries[1].basis = geometry.width;
    return true;
  }
  override handleMouse(event: TuiMouseEvent): ReturnType<HStack["handleMouse"]> {
    if (this.geometry().split && event.type === "wheel" && event.x < this.geometry().leftWidth) {
      this.onWheel(event.wheelDelta ?? 0);
      return { handled: true, target: { component: this, originX: event.screenX - event.x,
        originY: event.screenY - event.y, width: event.width, height: event.height } };
    }
    return undefined;
  }
  override render(width: number): string[] {
    // Regular-mode/export callers must continue to see the original document.
    return this.main.render(width);
  }
}
const blank: Component = { render: () => [], invalidate: () => {} };

export function createBtwSplitLayout(tui: TUI, mode: () => BtwLayoutMode) {
  const original = tui.mode === "fullscreen" && isViewportTUI(tui) ? readLayoutRoot(tui) : undefined;
  let disposed = false;
  let root: ReservedSidebar | undefined;
  const geometry = () => getBtwGeometry(tui.terminal.columns, tui.terminal.rows,
    !disposed && !!root && readLayoutRoot(tui) === root && tui.mode === "fullscreen", mode());
  if (original && isViewportTUI(tui)) {
    root = new ReservedSidebar(original, geometry, (delta) => {
      const scrollBy = Reflect.get(tui, "scrollBy");
      if (typeof scrollBy === "function") scrollBy.call(tui, delta);
    });
    tui.setLayoutRoot(root);
  }
  const primary = original ? findPrimary(original) : undefined;
  const originalMeasure = primary?.getContentWidth;
  const hadOwnMeasure = primary ? Object.hasOwn(primary, "getContentWidth") : false;
  const measure = (width: number) => originalMeasure!.call(primary,
    geometry().split ? Math.min(width, geometry().leftWidth) : width);
  if (primary && originalMeasure) primary.getContentWidth = measure;
  let sidebar: Component | undefined;
  const overlayEntries = () => Reflect.get(tui, "overlayStack") as Array<{ component: Component; hidden?: boolean; options?: OverlayOptions }> | undefined;
  const isPin = (entry: { component: Component; options?: OverlayOptions }) =>
    entry.component?.constructor?.name === "PinBar" && entry.options?.nonCapturing === true;
  const pinWidths = new Map<OverlayOptions, { original: OverlayOptions["width"]; applied: OverlayOptions["width"] }>();
  const originalHasOverlay = tui.hasOverlay;
  const ownership = Symbol("btw-sidebar-overlay-owner");
  const hasOverlay = (probe?: symbol): boolean | symbol => {
    if (probe === ownership) return ownership;
    const stack = overlayEntries();
    if (!geometry().split || !sidebar || !Array.isArray(stack)) return originalHasOverlay.call(tui);
    for (const entry of stack) {
      if (entry.hidden || entry.options?.visible?.(tui.terminal.columns, tui.terminal.rows) === false) continue;
      if (entry.component !== sidebar && !isPin(entry)) return originalHasOverlay.call(tui);
    }
    return false; // only the reserved sidebar and sticky pin: main selection stays live
  };
  const options: OverlayOptions = { nonCapturing: true, minWidth: 1 };
  const updateOptions = () => {
    const current = geometry();
    Object.assign(options, { width: current.width, maxHeight: current.height, row: current.row, col: current.col, margin: 0 });
    for (const entry of overlayEntries() ?? []) {
      if (!isPin(entry) || !entry.options) continue;
      let saved = pinWidths.get(entry.options);
      if (!saved) { saved = { original: entry.options.width, applied: entry.options.width }; pinWidths.set(entry.options, saved); }
      if (entry.options.width !== saved.applied) continue; // another owner changed it
      saved.applied = current.split ? current.leftWidth : saved.original;
      entry.options.width = saved.applied;
    }
    return true;
  };
  // Pi calls visibility before resolving overlay dimensions on every render and
  // input/focus check. Mutate the retained options object, not renderer state.
  options.visible = updateOptions;
  updateOptions();
  return {
    options,
    geometry,
    supported: !!original,
    bindOverlay(component: Component) {
      sidebar = component;
      if (original) Reflect.set(tui, "hasOverlay", hasOverlay);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // TUI's proxy wraps method reads, so use an explicit token probe rather
      // than function identity; never undo another extension's replacement.
      const currentHasOverlay = Reflect.get(tui, "hasOverlay") as ((probe?: symbol) => unknown) | undefined;
      if (typeof currentHasOverlay === "function" && currentHasOverlay.call(tui, ownership) === ownership) {
        Reflect.set(tui, "hasOverlay", originalHasOverlay);
      }
      for (const [pinOptions, saved] of pinWidths) {
        if (pinOptions.width === saved.applied) pinOptions.width = saved.original;
      }
      pinWidths.clear();
      if (primary && primary.getContentWidth === measure) {
        if (hadOwnMeasure) primary.getContentWidth = originalMeasure!;
        else Reflect.deleteProperty(primary, "getContentWidth");
      }
      if (root && readLayoutRoot(tui) === root && isViewportTUI(tui)) tui.setLayoutRoot(original);
      root = undefined;
    },
  };
}
