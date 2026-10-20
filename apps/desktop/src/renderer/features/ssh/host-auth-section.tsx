import { useId, useState } from 'react';
import { Button } from '../../components/button.js';
import type { SshAuthWire } from '../../../shared/ssh-wire.js';
import { INPUT_CLASS, sourceName, type Provenance } from './inherited-field.js';
import { SecretSelect, useSecretNames } from './secret-fields.js';
import { storeSshSecret } from './secret-writes.js';

type Kind = 'inherit' | 'password' | 'key' | 'agent';

const KINDS: readonly { id: Kind; label: string }[] = [
  { id: 'inherit', label: 'Inherit' },
  { id: 'password', label: 'Password' },
  { id: 'key', label: 'Key' },
  { id: 'agent', label: 'Agent' },
];

function describe(auth: SshAuthWire | undefined): string {
  return auth === undefined ? 'none' : auth.kind === 'agent' ? 'agent' : `${auth.kind} ${auth.secret}`;
}

/**
 * The auth block of the host / group form: inherit it (offered only when a group supplies one, or nothing is
 * chosen yet), or pick password / key / agent. A password is typed inline and the form stores it as a secret
 * on Save; a stored secret can be chosen instead. A key is picked by secret name.
 */
export function HostAuthSection(props: {
  readonly value: SshAuthWire | undefined;
  readonly inherited: Provenance<SshAuthWire>;
  readonly onChange: (next: SshAuthWire | undefined) => void;
  /** The password typed inline; never shown back once saved. */
  readonly password?: string;
  readonly onPasswordChange?: (password: string) => void;
  /** Names the no-value choice in place of Inherit, with nothing inherited shown: an identity's own form (#416). */
  readonly noneLabel?: string;
  /** A Telnet host (#425) signs in with a password only: key and agent are not offered unless already chosen. */
  readonly passwordOnly?: boolean;
  /** A password left empty is asked for when the host connects (S60): the field is optional and says so. */
  readonly emptyAsked?: boolean;
}) {
  const {
    value,
    inherited,
    onChange,
    password = '',
    onPasswordChange,
    noneLabel,
    passwordOnly = false,
    emptyAsked = false,
  } = props;
  const radioName = useId();
  const { names, reload: loadNames } = useSecretNames();
  const [setting, setSetting] = useState<{ name: string; value: string; error?: string } | undefined>(undefined);
  // A password is typed by default; picking a stored secret instead is the less common path.
  const [savedSecret, setSavedSecret] = useState(false);

  // Write-only: the value goes to main and is never read back; the file only ever gets the name.
  const storeValue = async (): Promise<void> => {
    if (setting === undefined) return;
    const result = await storeSshSecret({ name: setting.name, value: setting.value });
    if (!result.ok) {
      setSetting({ ...setting, value: '', error: result.error.message });
      return;
    }
    await loadNames();
    if (value !== undefined && value.kind !== 'agent') onChange({ ...value, secret: setting.name });
    setSetting(undefined);
  };

  const kind: Kind = value?.kind ?? 'inherit';
  const kinds = KINDS.filter(
    (k) => k.id !== 'inherit' || inherited.value !== undefined || value === undefined || noneLabel !== undefined,
  )
    .filter((k) => !passwordOnly || k.id === 'inherit' || k.id === 'password' || k.id === kind)
    .map((k) => (k.id === 'inherit' && noneLabel !== undefined ? { ...k, label: noneLabel } : k));
  const pick = (next: Kind): void => {
    if (next === 'inherit') onChange(undefined);
    else if (next === 'agent') onChange({ kind: 'agent' });
    else onChange({ kind: next, secret: '' });
  };
  const source =
    typeof inherited.from === 'object'
      ? `from ${sourceName(inherited.from)}`
      : inherited.from === 'default'
        ? 'default'
        : inherited.from === 'preferences'
          ? 'from Preferences'
          : '';

  return (
    <fieldset className="flex min-w-0 flex-col gap-2 text-xs">
      <legend className="text-fg-subtle">Authentication</legend>
      {/* Four choices (Inherit with them) go two by two: in the panel they left Agent alone on a second row (S12). */}
      <div
        role="radiogroup"
        aria-label="Authentication"
        className={kinds.length > 3 ? 'grid grid-cols-2 gap-x-3 gap-y-1' : 'flex flex-wrap gap-3'}
      >
        {kinds.map((k) => (
          <label key={k.id} className="flex items-center gap-1 text-sm text-fg-default">
            <input
              type="radio"
              name={radioName}
              checked={kind === k.id}
              onChange={() => {
                pick(k.id);
              }}
            />
            {k.label}
          </label>
        ))}
      </div>
      {value === undefined && noneLabel === undefined && (
        <p className="text-fg-subtle">
          {/* "Inherited from identity Tester: password tester_password", not two sets of brackets (S12). */}
          {source.startsWith('from ')
            ? `Inherited ${source}: ${describe(inherited.value)}`
            : `Inherited: ${describe(inherited.value)}${source === '' ? '' : ` (${source})`}`}
        </p>
      )}
      {value?.kind === 'password' && !savedSecret && (
        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-fg-subtle">Password</span>
            <input
              type="password"
              autoComplete="new-password"
              aria-required={value.secret === '' && !emptyAsked}
              className={INPUT_CLASS}
              value={password}
              placeholder={value.secret === '' ? undefined : '•••• stored · type to replace'}
              onChange={(e) => {
                onPasswordChange?.(e.target.value);
              }}
            />
          </label>
          {/* The hint takes its own line; the stored-secret choice sits under it, never in a narrow column beside it. */}
          <div className="flex flex-col items-start gap-1 text-fg-subtle">
            <span>
              {value.secret !== ''
                ? `Stored as the secret ${value.secret}.`
                : emptyAsked && password === ''
                  ? 'Left empty, it is asked for when you connect.'
                  : 'Kept on this machine as a secret, never in the hosts file.'}
            </span>
            <button
              type="button"
              className="-mx-1 rounded px-1 hover:text-fg-default focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
              onClick={() => {
                onPasswordChange?.('');
                setSavedSecret(true);
              }}
            >
              Choose a stored secret
            </button>
          </div>
        </div>
      )}
      {value?.kind === 'password' && savedSecret && (
        <div className="flex flex-wrap items-end gap-2">
          <SecretSelect
            label="Password secret"
            value={value.secret}
            names={names}
            onChange={(secret) => {
              onChange({ ...value, secret });
            }}
          />
          <Button
            onClick={() => {
              setSavedSecret(false);
            }}
          >
            Type a password
          </Button>
        </div>
      )}
      {value?.kind === 'key' && (
        <div className="flex flex-wrap items-end gap-2">
          <SecretSelect
            label="Private key secret"
            value={value.secret}
            names={names}
            onChange={(secret) => {
              // A keychain key's certificate goes with it (`<key>_cert`, #421).
              const { certificateSecret, ...rest } = value;
              void certificateSecret;
              const cert = `${secret}_cert`;
              onChange(
                names.some((n) => n.name === cert) ? { ...rest, secret, certificateSecret: cert } : { ...rest, secret },
              );
            }}
          />
          <SecretSelect
            label="Certificate secret"
            value={value.certificateSecret ?? ''}
            names={names}
            optional
            onChange={(name) => {
              const { certificateSecret, ...rest } = value;
              void certificateSecret;
              onChange(name === '' ? rest : { ...rest, certificateSecret: name });
            }}
          />
          <SecretSelect
            label="Passphrase secret"
            value={value.passphraseSecret ?? ''}
            names={names}
            optional
            onChange={(name) => {
              const { passphraseSecret, ...rest } = value;
              void passphraseSecret;
              onChange(name === '' ? rest : { ...rest, passphraseSecret: name });
            }}
          />
          <Button
            onClick={() => {
              setSetting({ name: '', value: '' });
            }}
          >
            Set value…
          </Button>
        </div>
      )}
      {setting !== undefined && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-32 flex-1 flex-col gap-1 text-xs">
            <span className="text-fg-subtle">Secret name</span>
            <input
              className={INPUT_CLASS}
              value={setting.name}
              onChange={(e) => {
                setSetting({ ...setting, name: e.target.value });
              }}
            />
          </label>
          <label className="flex min-w-32 flex-1 flex-col gap-1 text-xs">
            <span className="text-fg-subtle">Secret value</span>
            <input
              type="password"
              autoComplete="off"
              className={INPUT_CLASS}
              value={setting.value}
              onChange={(e) => {
                setSetting({ ...setting, value: e.target.value });
              }}
            />
          </label>
          <Button
            variant="primary"
            disabled={setting.name === '' || setting.value === ''}
            onClick={() => {
              void storeValue();
            }}
          >
            Store
          </Button>
          <Button
            onClick={() => {
              setSetting(undefined);
            }}
          >
            Cancel
          </Button>
        </div>
      )}
      {setting?.error !== undefined && (
        <p role="alert" className="text-sm text-status-danger">
          {setting.error}
        </p>
      )}
    </fieldset>
  );
}
