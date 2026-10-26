/**
 * The seam between the host (everything the app does) and the machine it runs on. The desktop
 * implements it with Electron; the agent and the server implement it with plain Node. This file
 * is types only, so importing it never pulls in `electron`.
 */

/** What a platform can do; a host switches features off when the platform lacks one. */
export type Capability =
  | 'files'
  | 'keychain'
  | 'ssh'
  | 'pty'
  | 'kerberos'
  | 'dialogs'
  | 'send:private'
  | 'send:public'
  | 'secret-sources'
  | 'team-secrets'
  | 'updates'
  | 'app-lock';

/** Whoever asked: a renderer window on the desktop, a connection elsewhere. */
export interface Caller {
  readonly id: number;
  /** Pushes `payload` on `channel`; a no-op once the caller is closed. */
  send(channel: string, payload: unknown): void;
  isClosed(): boolean;
  /** Runs `listener` once when the caller closes; returns a function that unsubscribes. */
  onClosed(listener: () => void): () => void;
}

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
    openFile(owner: Caller | undefined, opts: OpenDialogOptions): Promise<{ canceled: boolean; filePaths: string[] }>;
    saveFile(owner: Caller | undefined, opts: SaveDialogOptions): Promise<{ canceled: boolean; filePath?: string }>;
    message(owner: Caller | undefined, opts: MessageBoxOptions): Promise<{ response: number; checkboxChecked: boolean }>;
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
  readonly power?: { onResume(listener: () => void): () => void };
  readonly capabilities: ReadonlySet<Capability>;
}
