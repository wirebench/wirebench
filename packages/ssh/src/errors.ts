export type SshErrorCode =
  | 'ssh-duplicate-id'
  | 'ssh-literal-secret'
  | 'ssh-jump-cycle'
  | 'ssh-jump-unknown'
  | 'ssh-host-unknown'
  | 'ssh-host-incomplete'
  | 'ssh-hosts-invalid'
  | 'ssh-host-key-new'
  | 'ssh-host-key-changed'
  | 'ssh-auth-failed'
  | 'ssh-connect-failed'
  | 'ssh-session-unknown'
  | 'ssh-config-empty'
  | 'ssh-import-stale';

/** Mirrors the engine's WirebenchError shape (code, message, details) without importing it. */
export class SshModelError extends Error {
  readonly code: SshErrorCode;
  readonly details: Readonly<Record<string, unknown>>;
  constructor(code: SshErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'SshModelError';
    this.code = code;
    this.details = details;
  }
}
