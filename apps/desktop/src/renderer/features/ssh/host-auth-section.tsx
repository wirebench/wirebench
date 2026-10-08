import { useEffect, useState } from 'react';
import { Button } from '../../components/button.js';
import { ipc } from '../../state/ipc-client.js';
import { openSecretSourcesDialog } from '../secret-sources/actions.js';
import type { SshAuthWire } from '../../../shared/ssh-wire.js';
import { INPUT_CLASS, type Provenance } from './inherited-field.js';

type Kind = 'inherit' | 'password' | 'key' | 'agent';

const KINDS: readonly { id: Kind; label: string }[] = [
  { id: 'inherit', label: 'Inherit' },
  { id: 'password', label: 'Password' },
  { id: 'key', label: 'Key' },
  { id: 'agent', label: 'Agent' },
];

function describe(auth: SshAuthWire | undefined): string {
  return auth === undefined ? 'none' : auth.kind === 'agent' ? 'agent' : `${auth.kind} (${auth.secret})`;
}

function SecretSelect(props: {
  readonly label: string;
  readonly value: string;
  readonly names: readonly string[];
  readonly optional?: boolean;
  readonly onChange: (name: string) => void;
}) {
  const { label, value, names, optional = false, onChange } = props;
  return (
    <label className="flex flex-1 flex-col gap-1 text-xs">
      <span className="text-fg-subtle">{label}</span>
      <select
        aria-label={label}
        className={INPUT_CLASS}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      >
        <option value="">{optional ? 'None' : 'Choose a secret…'}</option>
        {value !== '' && !names.includes(value) && <option value={value}>{value}</option>}
        {names.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The auth block of the host / group form: inherit it, or pick password / key / agent with secret names. */
export function HostAuthSection(props: {
  readonly value: SshAuthWire | undefined;
  readonly inherited: Provenance<SshAuthWire>;
  readonly onChange: (next: SshAuthWire | undefined) => void;
}) {
  const { value, inherited, onChange } = props;
  const [names, setNames] = useState<readonly string[]>([]);

  // The names a `${secret:NAME}` can take are the workspace's secret-source entries.
  useEffect(() => {
    let live = true;
    void ipc()
      .secretSources.get(undefined)
      .then((result) => {
        if (live && result.ok) setNames(result.value.entries.map((e) => e.name));
      });
    return () => {
      live = false;
    };
  }, []);

  const kind: Kind = value?.kind ?? 'inherit';
  const pick = (next: Kind): void => {
    if (next === 'inherit') onChange(undefined);
    else if (next === 'agent') onChange({ kind: 'agent' });
    else onChange({ kind: next, secret: '' });
  };
  const source =
    typeof inherited.from === 'object' ? `from ${inherited.from.group}` : inherited.from === 'default' ? 'default' : '';

  return (
    <fieldset className="flex flex-col gap-2 text-xs">
      <legend className="text-fg-subtle">Authentication</legend>
      <div role="radiogroup" aria-label="Authentication" className="flex flex-wrap gap-3">
        {KINDS.map((k) => (
          <label key={k.id} className="flex items-center gap-1 text-sm text-fg-default">
            <input
              type="radio"
              name="ssh-auth-kind"
              checked={kind === k.id}
              onChange={() => {
                pick(k.id);
              }}
            />
            {k.label}
          </label>
        ))}
      </div>
      {value === undefined && (
        <p className="text-fg-subtle">{`Inherited: ${describe(inherited.value)}${source === '' ? '' : ` (${source})`}`}</p>
      )}
      {value !== undefined && value.kind !== 'agent' && (
        <div className="flex items-end gap-2">
          <SecretSelect
            label={value.kind === 'password' ? 'Password secret' : 'Private key secret'}
            value={value.secret}
            names={names}
            onChange={(secret) => {
              onChange({ ...value, secret });
            }}
          />
          {value.kind === 'key' && (
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
          )}
          <Button
            onClick={() => {
              openSecretSourcesDialog();
            }}
          >
            New secret…
          </Button>
        </div>
      )}
    </fieldset>
  );
}
