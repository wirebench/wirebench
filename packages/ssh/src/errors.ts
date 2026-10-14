export type SshErrorCode =
  | 'ssh-duplicate-id'
  | 'ssh-literal-secret'
  | 'ssh-jump-cycle'
  | 'ssh-jump-unknown'
  | 'ssh-identity-unknown'
  | 'ssh-host-unknown'
  | 'ssh-host-incomplete'
  | 'ssh-hosts-invalid'
  | 'ssh-host-key-new'
  | 'ssh-host-key-changed'
  | 'ssh-auth-failed'
  | 'ssh-connect-failed'
  | 'mosh-server-missing'
  | 'mosh-bootstrap-failed'
  | 'ssh-session-unknown'
  | 'ssh-config-empty'
  | 'ssh-import-stale'
  | 'ssh-import-unreadable'
  | 'ssh-forward-duplicate-id'
  | 'ssh-forward-invalid'
  | 'ssh-forward-unknown'
  | 'ssh-forward-port-in-use'
  | 'ssh-forward-bind-failed'
  | 'ssh-forward-refused'
  | 'ssh-forward-gave-up'
  | 'sftp-unavailable'
  | 'sftp-not-found'
  | 'sftp-permission-denied'
  | 'sftp-exists'
  | 'sftp-failed'
  | 'ssh-key-invalid'
  | 'ssh-key-locked'
  | 'ssh-install-failed'
  | 'ssh-cert-invalid'
  | 'ssh-cert-expired'
  | 'ssh-cert-mismatch'
  | 'snippets-invalid'
  | 'snippet-duplicate-id'
  | 'snippet-variable-invalid'
  | 'snippet-secret-invalid'
  | 'snippet-variable-missing'
  | 'snippet-value-invalid';

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
