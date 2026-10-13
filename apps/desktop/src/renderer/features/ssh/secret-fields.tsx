import { useCallback, useEffect, useState } from 'react';
import { ipc } from '../../state/ipc-client.js';
import type { SshSecretNameWire } from '../../../shared/ssh-wire.js';
import { INPUT_CLASS } from './inherited-field.js';

/** The secret names a host can reference; `reload` after storing a value. A failed read leaves the list as it was. */
export function useSecretNames(): { names: readonly SshSecretNameWire[]; reload: () => Promise<void> } {
  const [names, setNames] = useState<readonly SshSecretNameWire[]>([]);
  const reload = useCallback(async (): Promise<void> => {
    const result = await ipc().ssh.secretNames(undefined);
    if (result.ok) setNames(result.value.names);
  }, []);
  useEffect(() => {
    // A failed read leaves the picker as it was; nothing waits on it.
    reload().catch(() => undefined);
  }, [reload]);
  return { names, reload };
}

/** A secret picked by name (never a value); a name not stored on this machine still shows, marked. */
export function SecretSelect(props: {
  readonly label: string;
  readonly value: string;
  readonly names: readonly SshSecretNameWire[];
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
        {value !== '' && !names.some((n) => n.name === value) && <option value={value}>{`${value} (not set)`}</option>}
        {names.map((n) => (
          <option key={n.name} value={n.name}>
            {n.local || n.external ? n.name : `${n.name} (not set on this machine)`}
          </option>
        ))}
      </select>
    </label>
  );
}
