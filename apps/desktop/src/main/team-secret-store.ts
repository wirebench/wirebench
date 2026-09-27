/**
 * The store the renderer's `secrets.*` channels and the secret scan write through (plan decision 18):
 * the value lands in the keychain-backed store first, exactly as before, and is then handed to team
 * secrets, which seal it into the vault when this machine may. A vault failure is logged — never the
 * value — and never fails the save.
 *
 * Main's own writers (sign-in tokens, OAuth refresh tokens, a cURL import) keep the raw store: they
 * are this machine's, not the team's.
 */
import { teamSecretsError, type GetSecret, type SecretKey } from '@wirebench/engine';
import { isMachineOnlyLabel } from './secrets.js';
import type { SecretStore } from './secrets.js';
import type { TeamSecretsService } from './team-secrets-service.js';

const TOKEN_LABEL = /^wirebench-secret:([^:]+):(.+)$/;

/** Which secret a store entry is, for the vault: a token's label names its project and name. */
export function secretOfLabel(ref: string, label: string | undefined): SecretKey {
  const match = label === undefined ? null : TOKEN_LABEL.exec(label);
  return match === null ? { ref } : { token: { projectId: match[1]!, name: match[2]! } };
}

function displayLabel(secret: SecretKey, label: string | undefined, ref: string): string {
  return 'token' in secret ? secret.token.name : (label ?? ref);
}

type RawStore = Pick<SecretStore, 'set' | 'replace' | 'exists' | 'delete' | 'findByLabel' | 'list' | 'isMachineOnly'>;

export class TeamSecretStore implements RawStore {
  constructor(
    private readonly raw: RawStore,
    private readonly team: Pick<TeamSecretsService, 'recordValue' | 'forget'>,
    private readonly log: (message: string) => void = console.warn,
  ) {}

  async set(value: string, opts?: { label?: string }): Promise<string> {
    const ref = await this.raw.set(value, opts);
    await this.record(ref, opts?.label, value);
    return ref;
  }

  async replace(ref: string, value: string): Promise<string> {
    const stored = await this.raw.replace(ref, value);
    await this.record(ref, await this.labelOf(ref), value);
    return stored;
  }

  exists(ref: string): Promise<boolean> {
    return this.raw.exists(ref);
  }

  async delete(ref: string): Promise<boolean> {
    const label = await this.labelOf(ref);
    const deleted = await this.raw.delete(ref);
    if (deleted) {
      const secret = secretOfLabel(ref, label);
      await this.team.forget(secret, displayLabel(secret, label, ref)).catch((error: unknown) => {
        this.log(`[team-secrets] could not remove a deleted secret from the vault: ${describe(error)}`);
      });
    }
    return deleted;
  }

  findByLabel(label: string): Promise<string | undefined> {
    return this.raw.findByLabel(label);
  }

  list(): ReturnType<SecretStore['list']> {
    return this.raw.list();
  }

  /**
   * Delegates straight to the raw store: the `secrets.*` IPC guards (refuse replace/delete, omit
   * from list) run in front of this wrapper and need this check untouched by team secrets.
   */
  isMachineOnly(ref: string): Promise<boolean> {
    return this.raw.isMachineOnly(ref);
  }

  private async labelOf(ref: string): Promise<string | undefined> {
    return (await this.raw.list()).find((entry) => entry.ref === ref)?.label;
  }

  private async record(ref: string, label: string | undefined, value: string): Promise<void> {
    // Defense in depth: the raw store already refuses to create or relabel an entry with a
    // machine-only label, but a value team secrets itself never seals is never even offered.
    if (isMachineOnlyLabel(label)) {
      return;
    }
    const secret = secretOfLabel(ref, label);
    await this.team.recordValue(secret, displayLabel(secret, label, ref), value).catch((error: unknown) => {
      this.log(`[team-secrets] could not write a secret to the vault: ${describe(error)}`);
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The send getter with team secrets (§3.2): a value this machine is waiting for refuses the send with
 * `team-secrets-pending` instead of the plain "not on this machine".
 */
export function teamSecretGetter(
  inner: GetSecret,
  service: Pick<TeamSecretsService, 'waitingFor'>,
  projectId: string | undefined,
): GetSecret {
  return async (ref) => {
    const value = await inner(ref);
    if (value === undefined && service.waitingFor(ref, projectId)) {
      throw teamSecretsError('team-secrets-pending');
    }
    return value;
  };
}
