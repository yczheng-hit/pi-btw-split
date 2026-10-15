import type { Component, TUI } from '@earendil-works/pi-tui';
export interface NativeComponent extends Component {
  focused: boolean;
  setDraft?(value: string): void;
  getDraft?(): string;
  refresh?(): void;
  dispose?(): void;
}
export interface NativeOptions {
  api?: (method: string, params: Record<string, unknown>) => Promise<any>;
  pluginRoot: string;
  parentPaneId: string;
  sessionFile: string;
  hostDir: string;
  cwd: string;
  focus?: boolean;
  onTiming?: (timing: { startedAtMs?: number; firstWriteMs: number; inputReadyMs: number; frameWriteMs: number }) => void;
  createComponent: (tui: TUI, geometry: () => { height: number; split: boolean }) => NativeComponent | Promise<NativeComponent>;
  onClosed?: () => void;
  onError?: (error: Error) => void;
}
export class NativeSurface {
  constructor(options: NativeOptions);
  component?: NativeComponent;
  closed: boolean;
  ready: Promise<void>;
  done: Promise<void>;
  pane: {
    focus(main?: boolean): Promise<unknown>;
    toggleFocus(): Promise<unknown>;
    zoom(): Promise<unknown>;
  };
  open(): Promise<void>;
  close(): Promise<void>;
  setDraft(value: string): void;
  refresh(state?: 'idle' | 'working' | 'blocked'): void;
}
