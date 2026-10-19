/**
 * SSH keys in the keychain (#409): Generate key…, and Install public key on host… (from a key's row or a
 * host's menu), which then offers to switch the host's sign-in to the key. Main makes, stores and opens the
 * key; what reaches this file is its public half and the names of the secrets holding the rest.
 */
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { create } from 'zustand';
import { Button } from '../../components/button.js';
import type {
  SshCertificateWire,
  SshDeviceKeyStatus,
  SshKeyAlgorithmWire,
  SshKeyWire,
} from '../../../shared/ssh-keys-wire.js';
import type { ResolvedHostWire } from '../../../shared/ssh-wire.js';
import { ipc } from '../../state/ipc-client.js';
import { findHost, upsertHost, useHostsStore } from './hosts-store.js';
import { attachSshCertificate, generateSshKey } from './secret-writes.js';

const INPUT_CLASS =
  'w-full rounded-md border border-hairline-strong bg-surface-base px-2 py-1 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent';
const CONTENT_CLASS =
  'fixed top-1/2 left-1/2 flex w-[30rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-md bg-surface-raised p-4 shadow-lg';
const LABEL_CLASS = 'flex flex-col gap-1 text-xs text-fg-subtle';

/** The sizes each type offers, default first: the same list main checks against. */
const KEY_BITS: Readonly<Record<SshKeyAlgorithmWire, readonly number[]>> = {
  ed25519: [],
  ecdsa: [256, 384, 521],
  rsa: [4096, 3072, 2048],
  'ed25519-sk': [],
  'ecdsa-sk': [],
  device: [],
};
const ALGORITHMS: readonly { id: SshKeyAlgorithmWire; label: string }[] = [
  { id: 'ed25519', label: 'Ed25519' },
  { id: 'ecdsa', label: 'ECDSA' },
  { id: 'rsa', label: 'RSA' },
  { id: 'ed25519-sk', label: 'Security key (Ed25519)' },
  { id: 'ecdsa-sk', label: 'Security key (ECDSA)' },
];
const isSecurityKey = (algorithm: SshKeyAlgorithmWire): boolean =>
  algorithm === 'ed25519-sk' || algorithm === 'ecdsa-sk';

/** What a device key (#428) is called on each platform, and what it asks for at each sign-in. */
export const DEVICE_KEY_WORDS: Readonly<
  Record<NonNullable<SshDeviceKeyStatus['platform']>, { readonly name: string; readonly prompt: string }>
> = {
  'macos-secure-enclave': { name: 'This Mac’s Secure Enclave', prompt: 'Touch ID or your password' },
  'windows-hello': { name: 'Windows Hello', prompt: 'Windows Hello' },
};

/** Whether this machine can make device keys; undefined until main has answered. */
export function useDeviceKeyStatus(): SshDeviceKeyStatus | undefined {
  const [status, setStatus] = useState<SshDeviceKeyStatus>();
  useEffect(() => {
    let live = true;
    void ipc()
      .ssh.deviceKeyStatus(undefined)
      .then((result) => {
        if (live) setStatus(result.ok ? result.value : { supported: false, reason: result.error.message });
      });
    return () => {
      live = false;
    };
  }, []);
  return status;
}
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * `ssh-ed25519` → `ed25519`, `ecdsa-sha2-nistp256` → `ecdsa 256`, `ssh-rsa` → `rsa`, and the security keys
 * (#420) `sk-ssh-ed25519@openssh.com` → `ed25519-sk`, `sk-ecdsa-sha2-nistp256@openssh.com` → `ecdsa-sk`.
 */
export function keyTypeLabel(keyType: string | undefined): string {
  if (keyType === undefined) return '';
  if (keyType === 'sk-ssh-ed25519@openssh.com') return 'ed25519-sk';
  if (keyType === 'sk-ecdsa-sha2-nistp256@openssh.com') return 'ecdsa-sk';
  const ecdsa = /^ecdsa-sha2-nistp(\d+)$/.exec(keyType);
  if (ecdsa) return `ecdsa ${ecdsa[1] ?? ''}`;
  return keyType.replace(/^ssh-/, '');
}

/** The keychain's keys, by secret name; asked again whenever `reloadKey` changes. */
export function useSshKeys(reloadKey: unknown): ReadonlyMap<string, SshKeyWire> {
  const [keys, setKeys] = useState<ReadonlyMap<string, SshKeyWire>>(new Map());
  useEffect(() => {
    let live = true;
    void ipc()
      .ssh.keys(undefined)
      .then((result) => {
        if (live && result.ok) setKeys(new Map(result.value.keys.map((key) => [key.name, key])));
      });
    return () => {
      live = false;
    };
  }, [reloadKey]);
  return keys;
}

/** What the install dialog opens on: a key from the keychain, a host from its menu, or both. */
interface InstallTarget {
  readonly secret?: string;
  readonly hostId?: string;
}
interface KeyInstallState {
  readonly target: InstallTarget | null;
  open: (target: InstallTarget) => void;
  close: () => void;
}
export const useKeyInstall = create<KeyInstallState>((set) => ({
  target: null,
  open: (target) => {
    set({ target });
  },
  close: () => {
    set({ target: null });
  },
}));

/** A key's certificate in one line: principals, validity window and key ID; a badge when it will not sign in. */
export function CertificateSummary({ certificate }: { readonly certificate: SshCertificateWire }) {
  const principals = certificate.principals.length === 0 ? 'any principal' : certificate.principals.join(', ');
  const problem = !certificate.matchesKey
    ? 'for another key'
    : certificate.validity === 'expired'
      ? 'expired'
      : certificate.validity === 'not-yet-valid'
        ? 'not valid yet'
        : undefined;
  return (
    <span
      data-testid={`certificate-${certificate.secret}`}
      title={`Signed by ${certificate.caFingerprint}, serial ${certificate.serial}`}
      className="flex min-w-0 items-center gap-1 text-xs text-fg-subtle"
    >
      <span className="truncate">{`Certificate ${certificate.keyId} · ${principals} · ${certificate.window}`}</span>
      {problem !== undefined && (
        <span className="shrink-0 rounded-full border border-status-danger px-1.5 text-status-danger">{problem}</span>
      )}
    </span>
  );
}

/** Pastes an OpenSSH user certificate (`<key>-cert.pub`) onto a keychain key; main checks it and stores `<key>_cert`. */
export function AttachCertificateDialog({
  secret,
  onClose,
  onAttached,
}: {
  readonly secret: string;
  readonly onClose: () => void;
  readonly onAttached: (key: SshKeyWire) => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const attach = async (): Promise<void> => {
    setBusy(true);
    const result = await attachSshCertificate({ secret, certificate: text });
    setBusy(false);
    if (result.ok) onAttached(result.value);
    else setError(result.error.message);
  };
  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content data-testid="attach-certificate-dialog" className={CONTENT_CLASS}>
          <Dialog.Title className="text-md font-medium text-fg-default">{`Attach certificate to ${secret}`}</Dialog.Title>
          <Dialog.Description className="text-sm text-fg-subtle">
            {`Paste the OpenSSH user certificate your CA issued for this key (the -cert.pub file). It is stored as ${secret}_cert and offered before the key when a host signs in with it.`}
          </Dialog.Description>
          <label className={LABEL_CLASS}>
            Certificate
            <textarea
              rows={4}
              autoFocus
              spellCheck={false}
              className={`${INPUT_CLASS} font-mono`}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setError(undefined);
              }}
            />
          </label>
          {error !== undefined && (
            <p role="alert" className="text-sm text-status-danger">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={busy || text.trim() === ''}
              onClick={() => {
                void attach();
              }}
            >
              Attach
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The name a new key of `algorithm` starts with: OpenSSH's file name for it (`id_ed25519`), or the first
 * `id_ed25519_2`, `_3`… that no secret in `taken` has.
 */
export function defaultKeyName(
  algorithm: SshKeyAlgorithmWire,
  taken: readonly string[] = [],
  deviceKeyType?: string,
): string {
  // A device key is named for the type it makes: id_ecdsa_device (Secure Enclave), id_rsa_device (Windows Hello).
  const base =
    algorithm === 'device'
      ? `id_${deviceKeyType === 'ssh-rsa' ? 'rsa' : 'ecdsa'}_device`
      : `id_${algorithm.replace('-', '_')}`;
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}_${String(n)}`)) n += 1;
  return `${base}_${String(n)}`;
}

export function GenerateKeyDialog({
  open,
  onClose,
  onGenerated,
  taken = [],
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onGenerated: (key: SshKeyWire) => void;
  /** The secrets already stored, so the name it starts with is a free one. */
  readonly taken?: readonly string[];
}) {
  // Mounted per opening, so a reopened dialog starts afresh, its name picked against the secrets stored then.
  if (!open) return null;
  return <GenerateKeyBody open={open} taken={taken} onClose={onClose} onGenerated={onGenerated} />;
}

function GenerateKeyBody({
  open,
  onClose,
  onGenerated,
  taken,
}: {
  readonly open: boolean;
  readonly taken: readonly string[];
  readonly onClose: () => void;
  readonly onGenerated: (key: SshKeyWire) => void;
}) {
  // Starts filled in (and selected) with a real name, so Generate works at once and typing replaces it.
  const [name, setName] = useState(() => defaultKeyName('ed25519', taken));
  const [algorithm, setAlgorithm] = useState<SshKeyAlgorithmWire>('ed25519');
  const [bits, setBits] = useState<number>();
  const [comment, setComment] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [repeat, setRepeat] = useState('');
  const [pin, setPin] = useState('');
  const [verifyRequired, setVerifyRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const deviceStatus = useDeviceKeyStatus();
  const deviceWords = deviceStatus?.platform === undefined ? undefined : DEVICE_KEY_WORDS[deviceStatus.platform];
  const nameFor = (id: SshKeyAlgorithmWire): string => defaultKeyName(id, taken, deviceStatus?.keyType);

  const sizes = KEY_BITS[algorithm];
  const chosenBits = bits ?? sizes[0];
  const trimmed = name.trim();
  const nameOk = NAME_PATTERN.test(trimmed);
  // Why Generate is off, said beside it rather than left to guess.
  const nameProblem =
    trimmed === '' ? 'Name is required' : nameOk ? undefined : 'Use letters, digits and _, not starting with a digit';
  const device = algorithm === 'device';
  const mismatch = !device && passphrase !== repeat;
  const securityKey = isSecurityKey(algorithm);
  // A key that asks for the PIN at every sign-in is made with it.
  const pinMissing = securityKey && verifyRequired && pin === '';

  const generate = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    const result = await generateSshKey({
      name: trimmed,
      algorithm,
      ...(chosenBits === undefined ? {} : { bits: chosenBits }),
      ...(comment.trim() === '' ? {} : { comment: comment.trim() }),
      ...(passphrase === '' || device ? {} : { passphrase }),
      ...(securityKey && pin !== '' ? { pin } : {}),
      ...(securityKey && verifyRequired ? { verifyRequired: true } : {}),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    onGenerated(result.value);
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content data-testid="generate-key-dialog" className={CONTENT_CLASS}>
          <Dialog.Title className="text-md font-medium text-fg-default">Generate SSH key</Dialog.Title>
          <Dialog.Description className="text-sm text-fg-subtle">
            The private key is stored in the keychain as a secret of this workspace and is never shown. Its public key
            can be copied or installed on a host.
          </Dialog.Description>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (nameOk && !mismatch && !pinMissing && !busy) void generate();
            }}
          >
            <label className={LABEL_CLASS}>
              Secret name
              <input
                className={`${INPUT_CLASS} font-mono`}
                value={name}
                autoFocus
                aria-invalid={nameProblem !== undefined}
                onFocus={(e) => {
                  e.currentTarget.select();
                }}
                onChange={(e) => {
                  setName(e.target.value);
                }}
              />
            </label>
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1 text-xs text-fg-subtle">Type</legend>
              <div className="flex flex-wrap items-center gap-4">
                {ALGORITHMS.map((a) => (
                  <label key={a.id} className="flex items-center gap-1.5 text-sm text-fg-default">
                    <input
                      type="radio"
                      name="key-type"
                      checked={algorithm === a.id}
                      onChange={() => {
                        // A name still as it started follows the type (id_ed25519 → id_rsa); one typed stays.
                        if (name === nameFor(algorithm)) setName(nameFor(a.id));
                        setAlgorithm(a.id);
                        setBits(undefined);
                      }}
                    />
                    {a.label}
                  </label>
                ))}
                <label
                  className={`flex items-center gap-1.5 text-sm ${deviceStatus?.supported === true ? 'text-fg-default' : 'text-fg-subtle'}`}
                  title={deviceStatus?.supported === false ? deviceStatus.reason : undefined}
                >
                  <input
                    type="radio"
                    name="key-type"
                    data-testid="generate-key-device"
                    checked={device}
                    disabled={deviceStatus?.supported !== true}
                    onChange={() => {
                      if (name === nameFor(algorithm)) setName(nameFor('device'));
                      setAlgorithm('device');
                      setBits(undefined);
                    }}
                  />
                  {deviceWords === undefined ? 'Device key' : `Device key (${deviceWords.name})`}
                </label>
                {sizes.length > 0 && (
                  <label className="ml-auto flex items-center gap-1.5 text-sm text-fg-default">
                    Size
                    <select
                      aria-label="Key size"
                      className="rounded-md border border-hairline-strong bg-surface-base px-1 py-0.5 text-sm"
                      value={chosenBits}
                      onChange={(e) => {
                        setBits(Number(e.target.value));
                      }}
                    >
                      {sizes.map((size) => (
                        <option key={size} value={size}>
                          {algorithm === 'ecdsa' ? `P-${String(size)}` : `${String(size)} bits`}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            </fieldset>
            {deviceStatus?.supported === false && (
              <p className="text-xs text-fg-subtle" data-testid="generate-key-device-unavailable">
                Device keys need macOS with a Secure Enclave or Windows Hello.
                {/* Main adds a reason only when it says more, such as "This Mac has no Secure Enclave". */}
                {deviceStatus.reason !== undefined && ` ${deviceStatus.reason.replace(/\.?$/, '.')}`}
              </p>
            )}
            {device && deviceWords !== undefined && (
              <div className="flex flex-col gap-2" data-testid="generate-key-device-notes">
                <p className="text-xs text-fg-subtle">
                  Made and kept by {deviceWords.name}: the keychain stores only a handle that this device alone can use,
                  and each sign-in asks for {deviceWords.prompt}. Its type is {keyTypeLabel(deviceStatus?.keyType)}.
                </p>
                <p role="note" className="text-xs text-status-warning">
                  This key cannot be copied off this device or recovered. Keep a second way into the same hosts, such as
                  another key or a security key.
                </p>
              </div>
            )}
            {securityKey && (
              <div className="flex flex-col gap-2" data-testid="generate-key-security">
                <p className="text-xs text-fg-subtle">
                  Made on the security key plugged in, which keeps the private half: the keychain stores only its
                  handle, and signing in needs the key plugged in and a touch.
                </p>
                <label className={LABEL_CLASS}>
                  Security key PIN (if it has one)
                  <input
                    type="password"
                    autoComplete="off"
                    maxLength={63}
                    className={INPUT_CLASS}
                    value={pin}
                    onChange={(e) => {
                      setPin(e.target.value);
                    }}
                  />
                </label>
                <label className="flex items-center gap-1.5 text-sm text-fg-default">
                  <input
                    type="checkbox"
                    checked={verifyRequired}
                    onChange={(e) => {
                      setVerifyRequired(e.target.checked);
                    }}
                  />
                  Ask for the PIN at every sign-in
                </label>
                <p className="text-xs text-fg-subtle">The PIN is used to make the key and is never stored.</p>
              </div>
            )}
            <label className={LABEL_CLASS}>
              Comment
              <input
                className={INPUT_CLASS}
                value={comment}
                placeholder="user@this-machine"
                onChange={(e) => {
                  setComment(e.target.value);
                }}
              />
            </label>
            {!device && (
              <div className="flex gap-2">
                <label className={`${LABEL_CLASS} flex-1`}>
                  Passphrase (optional)
                  <input
                    type="password"
                    autoComplete="new-password"
                    className={INPUT_CLASS}
                    value={passphrase}
                    onChange={(e) => {
                      setPassphrase(e.target.value);
                    }}
                  />
                </label>
                <label className={`${LABEL_CLASS} flex-1`}>
                  Repeat passphrase
                  <input
                    type="password"
                    autoComplete="new-password"
                    className={INPUT_CLASS}
                    value={repeat}
                    onChange={(e) => {
                      setRepeat(e.target.value);
                    }}
                  />
                </label>
              </div>
            )}
            {!device && (
              <p className="text-xs text-fg-subtle">
                {passphrase === ''
                  ? 'Without a passphrase the key is stored unencrypted in the keychain.'
                  : `The passphrase is stored as ${trimmed || 'NAME'}_passphrase, so hosts can sign in with the key unattended.`}
              </p>
            )}
            {mismatch && repeat !== '' && <p className="text-sm text-status-danger">The passphrases differ.</p>}
            {busy && securityKey && (
              <p role="status" className="text-sm text-status-warning">
                Touch your security key when it blinks.
              </p>
            )}
            {busy && device && deviceStatus?.platform === 'windows-hello' && (
              <p role="status" className="text-sm text-status-warning">
                Confirm with Windows Hello.
              </p>
            )}
            {error !== undefined && (
              <p role="alert" className="text-sm text-status-danger">
                {error}
              </p>
            )}
            <div className="flex items-center justify-end gap-2">
              {nameProblem !== undefined && (
                <p data-testid="generate-key-name-problem" className="mr-auto text-sm text-status-danger">
                  {nameProblem}
                </p>
              )}
              <Button onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={!nameOk || mismatch || pinMissing || busy}>
                {busy ? 'Generating…' : 'Generate'}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** How the host signs in now, in a few words. */
function signInOf(host: ResolvedHostWire | undefined): string {
  const auth = host?.ssh.auth.value;
  if (auth === undefined) return 'no sign-in set';
  if (auth.kind === 'agent') return 'the SSH agent';
  return `${auth.kind === 'key' ? 'key' : 'password'} ${auth.secret}`;
}

interface TrustStep {
  readonly kind: 'trust';
  readonly host: string;
  readonly keyType: string;
  readonly fingerprint: string;
}
type InstallStep =
  | { readonly kind: 'pick' }
  | { readonly kind: 'installing' }
  | TrustStep
  | { readonly kind: 'done'; readonly result: 'added' | 'present' }
  | { readonly kind: 'switched' };

/** Installs a key's public half on a host, then offers to switch the host's sign-in to it. One per SSH home. */
export function InstallKeyDialog() {
  const target = useKeyInstall((s) => s.target);
  const close = useKeyInstall((s) => s.close);
  // Keyed on the target, so every opening starts from its own picks.
  return target === null ? null : (
    <InstallKeyBody key={`${target.secret ?? ''}\n${target.hostId ?? ''}`} target={target} onClose={close} />
  );
}

function InstallKeyBody({ target, onClose }: { readonly target: InstallTarget; readonly onClose: () => void }) {
  const resolved = useHostsStore((s) => s.resolved);
  const keys = useSshKeys(target);
  const usable = [...keys.values()].filter((key) => !key.locked);
  const [secret, setSecret] = useState(target.secret ?? '');
  const [hostId, setHostId] = useState(target.hostId ?? '');
  const [step, setStep] = useState<InstallStep>({ kind: 'pick' });
  const [error, setError] = useState<string>();
  const chosenSecret = secret || (usable[0]?.name ?? '');
  const chosenHostId = hostId || (resolved[0]?.id ?? '');
  const host = resolved.find((h) => h.id === chosenHostId);
  const key = keys.get(chosenSecret);

  const install = async (): Promise<void> => {
    setStep({ kind: 'installing' });
    setError(undefined);
    const result = await ipc().ssh.installKey({ secret: chosenSecret, hostId: chosenHostId });
    if (result.ok) {
      setStep({ kind: 'done', result: result.value.result });
      return;
    }
    const { code, message, details } = result.error;
    if (code === 'ssh-host-key-new' && details) {
      setStep({
        kind: 'trust',
        host: String(details['host']),
        keyType: String(details['keyType']),
        fingerprint: String(details['fingerprint']),
      });
      return;
    }
    setStep({ kind: 'pick' });
    setError(message);
  };

  const trustAndInstall = async (prompt: TrustStep): Promise<void> => {
    const trusted = await ipc().ssh.trustHostKey({
      host: prompt.host,
      keyType: prompt.keyType,
      fingerprint: prompt.fingerprint,
      replace: false,
    });
    if (!trusted.ok) {
      setStep({ kind: 'pick' });
      setError(trusted.error.message);
      return;
    }
    await install();
  };

  /** The host's own `auth` becomes the key; a group's sign-in it inherited stays on the group. */
  const switchSignIn = async (): Promise<void> => {
    const { file, save } = useHostsStore.getState();
    const entry = findHost(file, chosenHostId);
    if (entry === undefined) return;
    const auth = {
      kind: 'key' as const,
      secret: chosenSecret,
      ...(key?.certificate === undefined ? {} : { certificateSecret: key.certificate.secret }),
      ...(key?.passphraseSecret === undefined ? {} : { passphraseSecret: key.passphraseSecret }),
    };
    if (await save(upsertHost(file, { ...entry, ssh: { ...entry.ssh, auth } }))) setStep({ kind: 'switched' });
    else setError('The host could not be saved; see the Problems tab.');
  };

  const current = host?.ssh.auth.value;
  const alreadyKey = current?.kind === 'key' && current.secret === chosenSecret;
  const hostName = host?.name ?? chosenHostId;
  const picking = step.kind === 'pick' || step.kind === 'installing';

  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next && step.kind !== 'installing') onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content data-testid="install-key-dialog" className={CONTENT_CLASS}>
          <Dialog.Title className="text-md font-medium text-fg-default">Install public key on host</Dialog.Title>
          <Dialog.Description className="text-sm text-fg-subtle">
            Signs in as the host does now and adds the key to ~/.ssh/authorized_keys, creating ~/.ssh when it is
            missing. A key already there is left alone.
          </Dialog.Description>
          <label className={LABEL_CLASS}>
            Key
            <select
              className={INPUT_CLASS}
              value={chosenSecret}
              disabled={step.kind !== 'pick'}
              onChange={(e) => {
                setSecret(e.target.value);
              }}
            >
              {usable.length === 0 && <option value="">No keys in the keychain</option>}
              {usable.map((k) => (
                <option key={k.name} value={k.name}>
                  {`${k.name} (${keyTypeLabel(k.keyType)})`}
                </option>
              ))}
            </select>
          </label>
          <label className={LABEL_CLASS}>
            Host
            <select
              className={INPUT_CLASS}
              value={chosenHostId}
              disabled={step.kind !== 'pick'}
              onChange={(e) => {
                setHostId(e.target.value);
              }}
            >
              {resolved.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </label>
          <p className="-mt-2 text-xs text-fg-subtle">Signs in with {signInOf(host)}</p>
          {step.kind === 'trust' && (
            <div role="alert" className="rounded-md border border-status-warning p-2 text-sm text-fg-default">
              {step.host} presented a {step.keyType} host key this machine has not trusted yet:
              <div className="mt-1 font-mono text-xs break-all">{step.fingerprint}</div>
            </div>
          )}
          {(step.kind === 'done' || step.kind === 'switched') && (
            <p role="status" data-testid="install-key-result" className="text-sm text-fg-default">
              {step.kind === 'switched'
                ? `${hostName} now signs in with ${chosenSecret}.`
                : step.result === 'added'
                  ? `Added to ~/.ssh/authorized_keys on ${hostName}.`
                  : `${hostName} already has this key.`}
            </p>
          )}
          {step.kind === 'done' && !alreadyKey && (
            <p className="text-sm text-fg-default">
              Switch {hostName} to sign in with {chosenSecret}?
            </p>
          )}
          {error !== undefined && (
            <p role="alert" className="text-sm text-status-danger">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            {picking ? (
              <>
                <Button onClick={onClose} disabled={step.kind === 'installing'}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  disabled={step.kind === 'installing' || chosenSecret === '' || chosenHostId === ''}
                  onClick={() => {
                    void install();
                  }}
                >
                  {step.kind === 'installing' ? 'Installing…' : 'Install'}
                </Button>
              </>
            ) : step.kind === 'trust' ? (
              <>
                <Button onClick={onClose}>Cancel</Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    void trustAndInstall(step);
                  }}
                >
                  Trust and install
                </Button>
              </>
            ) : step.kind === 'done' && !alreadyKey ? (
              <>
                <Button onClick={onClose}>Not now</Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    void switchSignIn();
                  }}
                >
                  Switch
                </Button>
              </>
            ) : (
              <Button variant="primary" onClick={onClose}>
                Done
              </Button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
