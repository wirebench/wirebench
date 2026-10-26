/**
 * The seam between the host (everything the app does) and the machine it runs on. The desktop
 * implements it with Electron; the agent and the server implement it with plain Node. This file
 * is types only, so importing it never pulls in `electron`.
 */

/** Every capability there is, in one place; a platform declares the subset it has. */
export const ALL_CAPABILITIES = [
  'files',
  'keychain',
  'ssh',
  'pty',
  'kerberos',
  'dialogs',
  'send:private',
  'send:public',
  'secret-sources',
  'team-secrets',
  'updates',
  'app-lock',
] as const;

/** What a platform can do; a host switches features off when the platform lacks one. */
export type Capability = (typeof ALL_CAPABILITIES)[number];

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
  readonly paths: { userData(): string; temp(): string; logs(): string };
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
    version(): string;
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
  readonly capabilities: ReadonlySet<Capability>;
}
