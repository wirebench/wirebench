import { hostname, userInfo } from 'node:os';
import type { WebContents } from 'electron';
import { WirebenchError, secretPseudoRef } from '@wirebench/engine';
import type { GetSecret } from '@wirebench/engine';
import { describePrivateKey, generateKey, installPublicKey, looksLikePrivateKey } from '@wirebench/ssh';
import type { SshKeyInfo } from '@wirebench/ssh';
import type {
  SshGenerateKeyRequest,
  SshInstallKeyRequest,
  SshInstallKeyResponse,
  SshKeyWire,
} from '../shared/ssh-keys-wire.js';
import { asWirebenchError } from './hosts-service.js';
import type { SshConnector } from './ssh-connect.js';
import type { SshSecretsService } from './ssh-secrets.js';

export interface SshKeysDeps {
  readonly secrets: Pick<SshSecretsService, 'names' | 'set'>;
  readonly connector: Pick<SshConnector, 'prepareHops' | 'verifierFor' | 'refusalError'>;
  /** The window's secret getter: local, team and secret-source values alike. */
  readonly secretsFor: (sender: WebContents) => GetSecret;
  /** Tests inject fakes. */
  readonly generate?: typeof generateKey;
  readonly install?: typeof installPublicKey;
  /** `user@host`, as ssh-keygen comments a key it makes; tests pin it. */
  readonly defaultComment?: () => string;
}

/** Where a generated key's passphrase is stored: next to the key, by convention. */
export const passphraseSecretOf = (name: string): string => `${name}_passphrase`;

const systemComment = (): string => {
  try {
    return `${userInfo().username}@${hostname()}`;
  } catch {
    return hostname();
  }
};

/**
 * SSH keys in the workspace's keychain (#409): makes a key pair and stores its private half as a secret,
 * describes the keys among the secrets by their public half, and installs one on a host over the host's
 * current sign-in. A private key and a passphrase stay in main: what crosses IPC is the public half.
 */
export class SshKeysService {
  constructor(private readonly deps: SshKeysDeps) {}

  /**
   * @throws WirebenchError `ssh-secret-exists` when the name (or its `_passphrase`) is taken |
   *   `ssh-literal-secret` for a bad name | `ssh-key-invalid` | `workspace-not-open`
   */
  async generate(request: SshGenerateKeyRequest): Promise<SshKeyWire> {
    const passphrase = request.passphrase ?? '';
    const passphraseName = passphraseSecretOf(request.name);
    const taken = new Set((await this.deps.secrets.names()).map((n) => n.name));
    for (const name of passphrase === '' ? [request.name] : [request.name, passphraseName]) {
      if (taken.has(name)) {
        throw new WirebenchError('ssh-secret-exists', `A secret named ${name} already exists; choose another name`, {
          details: { name },
        });
      }
    }
    const comment = request.comment?.trim() || (this.deps.defaultComment ?? systemComment)();
    let key: Awaited<ReturnType<typeof generateKey>>;
    try {
      key = await (this.deps.generate ?? generateKey)({
        algorithm: request.algorithm,
        ...(request.bits === undefined ? {} : { bits: request.bits }),
        ...(passphrase === '' ? {} : { passphrase }),
        comment,
      });
    } catch (error) {
      throw asWirebenchError(error);
    }
    // The key first: a failure after it leaves a key without its passphrase, never the reverse.
    await this.deps.secrets.set(request.name, key.privateKey);
    if (passphrase !== '') await this.deps.secrets.set(passphraseName, passphrase);
    return this.wire(request.name, key, passphrase === '' ? undefined : passphraseName);
  }

  /** Every secret the window can read whose value is a private key; a key its `_passphrase` cannot open is `locked`. */
  async keys(sender: WebContents): Promise<SshKeyWire[]> {
    const getSecret = this.deps.secretsFor(sender);
    const keys: SshKeyWire[] = [];
    for (const { name } of await this.deps.secrets.names()) {
      let value: string | undefined;
      try {
        value = await getSecret(secretPseudoRef(name));
      } catch {
        continue; // a secret source that cannot answer now: not listed as a key
      }
      if (value === undefined || !looksLikePrivateKey(value)) continue;
      try {
        const { info, passphraseSecret } = await this.open(getSecret, name, value);
        keys.push(this.wire(name, info, passphraseSecret));
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (code === 'ssh-key-locked') keys.push({ name, locked: true });
      }
    }
    return keys;
  }

  /**
   * Appends the key's public half to the host user's `~/.ssh/authorized_keys`, signing in as the host does now.
   *
   * @throws WirebenchError the `ssh.connect` refusals (`ssh-host-key-new`, `ssh-auth-failed`, `secret-missing`, …) |
   *   `ssh-key-invalid` | `ssh-key-locked` | `ssh-install-failed`
   */
  async install(sender: WebContents, request: SshInstallKeyRequest): Promise<SshInstallKeyResponse> {
    const getSecret = this.deps.secretsFor(sender);
    const value = await getSecret(secretPseudoRef(request.secret));
    if (value === undefined) {
      throw new WirebenchError('secret-missing', `The secret "${request.secret}" is not on this machine`, {
        details: { name: request.secret },
      });
    }
    const { info } = await this.open(getSecret, request.secret, value);
    const { connector } = this.deps;
    const hops = await connector.prepareHops(sender, request.hostId);
    const verifyHostKey = await connector.verifierFor(sender);
    try {
      const result = await (this.deps.install ?? installPublicKey)({ hops, verifyHostKey, publicKey: info.publicKey });
      return { result };
    } catch (error) {
      throw connector.refusalError(sender, error);
    }
  }

  /** Opens the key with its `_passphrase` secret when there is one. */
  private async open(
    getSecret: GetSecret,
    name: string,
    value: string,
  ): Promise<{ info: SshKeyInfo; passphraseSecret?: string }> {
    const passphraseName = passphraseSecretOf(name);
    let passphrase: string | undefined;
    try {
      passphrase = await getSecret(secretPseudoRef(passphraseName));
    } catch {
      passphrase = undefined;
    }
    try {
      const info = describePrivateKey(value, passphrase);
      return passphrase === undefined ? { info } : { info, passphraseSecret: passphraseName };
    } catch (error) {
      throw asWirebenchError(error);
    }
  }

  private wire(name: string, info: SshKeyInfo, passphraseSecret: string | undefined): SshKeyWire {
    return {
      name,
      locked: false,
      keyType: info.keyType,
      fingerprint: info.fingerprint,
      publicKey: info.publicKey,
      ...(passphraseSecret === undefined ? {} : { passphraseSecret }),
    };
  }
}
