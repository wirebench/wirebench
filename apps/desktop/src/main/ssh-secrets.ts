import { WirebenchError } from '@wirebench/engine';
import { SSH_SECRET_NAME_PATTERN } from '../shared/ssh-defaults.js';
import type { SshSecretNameWire } from '../shared/ssh-wire.js';
import { workspaceSecretLabel } from './secret-resolver.js';
import type { SecretStore } from './secrets.js';

export interface SshSecretsDeps {
  readonly store: Pick<SecretStore, 'set' | 'replace' | 'findByLabel' | 'list'>;
  /** The open workspace's id; `undefined` when none is open. */
  readonly workspaceId: () => string | undefined;
  /** Names a secret source maps in the open workspace (no values). */
  readonly mappedNames: () => readonly string[];
}

/**
 * The SSH area's workspace-scoped secrets (A5): which names a host can reference and where each resolves
 * from, and a write-only way to store a local value. A value is never returned or logged.
 */
export class SshSecretsService {
  constructor(private readonly deps: SshSecretsDeps) {}

  async names(): Promise<SshSecretNameWire[]> {
    const external = new Set(this.deps.mappedNames());
    const local = new Set<string>();
    const workspaceId = this.deps.workspaceId();
    if (workspaceId !== undefined) {
      const prefix = workspaceSecretLabel(workspaceId, '');
      for (const entry of await this.deps.store.list()) {
        if (entry.label?.startsWith(prefix)) local.add(entry.label.slice(prefix.length));
      }
    }
    return [...new Set([...external, ...local])]
      .sort()
      .map((name) => ({ name, local: local.has(name), external: external.has(name) }));
  }

  async set(name: string, value: string): Promise<void> {
    // The bad name is not echoed: a password typed into the name field would travel back in the message.
    if (!SSH_SECRET_NAME_PATTERN.test(name)) {
      throw new WirebenchError('ssh-literal-secret', 'a secret name must match [A-Za-z_][A-Za-z0-9_]*');
    }
    const workspaceId = this.deps.workspaceId();
    if (workspaceId === undefined) throw new WirebenchError('workspace-not-open', 'Open a workspace first');
    const label = workspaceSecretLabel(workspaceId, name);
    const existing = await this.deps.store.findByLabel(label);
    if (existing === undefined) await this.deps.store.set(value, { label });
    else await this.deps.store.replace(existing, value);
  }
}
