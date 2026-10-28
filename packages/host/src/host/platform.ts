/**
 * The seam between the host (everything the app does) and the machine it runs on. The desktop
 * implements it with Electron; the agent and the server implement it with plain Node. This file
 * is types plus the capability list, so importing it never pulls in `electron`.
 */
import type { EgressPolicy } from '@wirebench/engine';

/**
 * Every capability there is, and what a platform can do. The list lives in `@wirebench/wire` so the
 * renderer, which cannot import the host, reads the same one (`hasCapability`).
 */
export { ALL_CAPABILITIES, type Capability } from '@wirebench/wire/capabilities';
import type { Capability } from '@wirebench/wire/capabilities';

/** Whoever asked: a renderer window on the desktop, a connection elsewhere. */
export interface Caller {
  readonly id: number;
  /** Pushes `payload` on `channel`; a no-op once the caller is closed. */
  send(channel: string, payload: unknown): void;
  isClosed(): boolean;
  /**
   * Runs `listener` each time the caller starts over while staying open: a renderer that reloads or
   * crashes, and so knows nothing of what it was given before. A caller that cannot do that (a
   * connection) never calls it; for it a drop is a close. Returns a function that unsubscribes.
   *
   * `options.on` says when a navigation counts. `'start'` (the default) is as soon as a main-frame
   * navigation to another document begins, even one that is then cancelled; right for state that is
   * safe to drop early. `'commit'` is only once such a navigation has committed, so a cancelled one
   * (a link click or a dropped file the window refuses) does not reset; right for state that must
   * outlive an attempt. Both also fire when the renderer process crashes.
   */
  onReset(listener: () => void, options?: { readonly on?: 'start' | 'commit' }): () => void;
  /**
   * Runs `listener` once when the caller closes; returns a function that unsubscribes. On a caller that
   * is already closed the listener still runs exactly once, in a microtask, and unsubscribing before
   * that microtask prevents the call. A listener that throws does not stop the others.
   */
  onClosed(listener: () => void): () => void;
}

/**
 * Who a native dialog opens over: a `Caller`'s window, `'focused'` for whichever window the user is
 * in (unparented when none), or `undefined` for no parent at all.
 */
export type DialogOwner = Caller | 'focused' | undefined;

export interface DialogFilter {
  readonly name: string;
  readonly extensions: readonly string[];
}

/** The fields callers pass to the native open dialog. */
export interface OpenDialogOptions {
  readonly title?: string;
  readonly defaultPath?: string;
  readonly filters?: readonly DialogFilter[];
  readonly properties?: readonly ('openFile' | 'openDirectory' | 'multiSelections' | 'createDirectory')[];
}

/** The fields callers pass to the native save dialog. */
export interface SaveDialogOptions {
  readonly title?: string;
  readonly defaultPath?: string;
  readonly filters?: readonly DialogFilter[];
}

/** The fields callers pass to the native message box. */
export interface MessageBoxOptions {
  readonly type?: 'none' | 'info' | 'error' | 'question' | 'warning';
  readonly title?: string;
  readonly message: string;
  readonly detail?: string;
  readonly buttons?: readonly string[];
  readonly defaultId?: number;
  readonly cancelId?: number;
  readonly noLink?: boolean;
  readonly checkboxLabel?: string;
  readonly checkboxChecked?: boolean;
}

export interface HostPlatform {
  readonly paths: {
    userData(): string;
    temp(): string;
    logs(): string;
    /**
     * The one directory this host may touch on a caller's behalf (the server's checkout parent).
     * When set, every path a caller names is resolved inside it, symbolic links included, and one
     * that leaves it is refused with `host-path-outside-workspace`. The desktop names none.
     */
    root?(): string;
  };
  readonly secrets: { available(): boolean; encrypt(plain: string): Buffer; decrypt(sealed: Buffer): string };
  readonly dialogs?: {
    openFile(owner: DialogOwner, opts: OpenDialogOptions): Promise<{ canceled: boolean; filePaths: string[] }>;
    saveFile(owner: DialogOwner, opts: SaveDialogOptions): Promise<{ canceled: boolean; filePath?: string }>;
    message(owner: DialogOwner, opts: MessageBoxOptions): Promise<{ response: number; checkboxChecked: boolean }>;
  };
  readonly shell?: {
    openExternal(url: string): Promise<void>;
    openPath(path: string): Promise<string>;
    reveal(path: string): void;
    trash(path: string): Promise<void>;
  };
  readonly app: {
    /** The version to show the user (status bar, About panel, update prompt); a platform derives it however it must. */
    version(): string;
    /** The version of the runtime the host runs in (Electron's, on the desktop); shown by `app.version`. */
    runtimeVersion(): string;
    packaged(): boolean;
    quit(): void;
    osTheme(): 'dark' | 'light';
    onOsThemeChanged(listener: () => void): () => void;
  };
  /** Electron's PAC string for `target`; `'DIRECT'` when there is no proxy. */
  readonly proxy: { resolve(target: string): Promise<string> };
  readonly power?: {
    onResume(listener: () => void): () => void;
    /** Runs `listener` when the screen locks or the machine suspends; returns a function that unsubscribes. */
    onLock(listener: () => void): () => void;
    /** Seconds since the last input anywhere on the machine. */
    idleSeconds(): number;
  };
  /**
   * The egress rule every connection the host opens on a caller's behalf is held to (hosted edition
   * spec §17.5): sends, token calls, definition fetches, certificate probes and WebSocket
   * connections. Absent (the desktop), connections go wherever they are pointed.
   */
  readonly network?: { readonly egress: EgressPolicy };
  /**
   * `false` on a host that is not the user's machine (the server): `${#System#…}` values resolve
   * to nothing and no environment variable is read as an override (`WIREBENCH_AREAS`,
   * `WIREBENCH_FEATURES`, `WIREBENCH_E2E_*`, the policy-file lookup). Absent, the machine's own.
   */
  readonly machineValues?: false;
  /**
   * What the platform can do. A host leaves out what needs a missing one: without `ssh` or `pty`
   * the SSH area or the local terminal is off, without `files` only server workspaces open, and
   * `fs`, `git` and secret-source channels are not registered.
   */
  readonly capabilities: ReadonlySet<Capability>;
}
