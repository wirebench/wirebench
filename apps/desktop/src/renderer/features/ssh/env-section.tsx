import { Plus, X } from 'lucide-react';
import type { EnvVarWire, GroupEntryWire } from '../../../shared/ssh-wire.js';
import { INPUT_CLASS } from './inherited-field.js';
import { SecretSelect, useSecretNames } from './secret-fields.js';

/** A shell variable name, as hosts.yaml takes it. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A variable the enclosing groups give this level: the nearest group's value, and that group's name. */
export interface InheritedEnvVar {
  readonly variable: EnvVarWire;
  readonly from: string;
}

/** The variables `chain` (outermost group first) hands down, merged by name: nearest wins, first-definition order. */
export function inheritedEnv(chain: readonly GroupEntryWire[]): InheritedEnvVar[] {
  const byName = new Map<string, InheritedEnvVar>();
  for (const group of chain) {
    for (const variable of group.env ?? []) byName.set(variable.name, { variable, from: group.name });
  }
  return [...byName.values()];
}

/** Why this level's list cannot be saved, or undefined. Values are never quoted: one may be a pasted secret. */
export function envProblem(own: readonly EnvVarWire[]): string | undefined {
  const seen = new Set<string>();
  for (const variable of own) {
    if (variable.name === '') return 'Each variable needs a name';
    if (!NAME.test(variable.name)) {
      return `${variable.name} is not a variable name (letters, digits and _, not starting with a digit)`;
    }
    if (seen.has(variable.name)) return `${variable.name} is listed twice`;
    seen.add(variable.name);
    if ('secret' in variable) {
      if (variable.secret === '') return `${variable.name}: choose a secret`;
    } else if (variable.value.includes('${secret:')) {
      return `${variable.name}: to send a secret, choose Secret rather than typing \${secret:…}`;
    }
  }
  return undefined;
}

const shown = (variable: EnvVarWire): string => ('secret' in variable ? `secret ${variable.secret}` : variable.value);

const ROW_BUTTON =
  'rounded px-1.5 py-0.5 text-xs text-fg-subtle hover:bg-surface-hover hover:text-fg-default focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none';

export interface EnvSectionProps {
  /** This level's own `env`. */
  readonly own: readonly EnvVarWire[];
  readonly inherited: readonly InheritedEnvVar[];
  readonly onChange: (own: EnvVarWire[]) => void;
}

/**
 * The host and group form's Environment variables section. A variable from a group above shows greyed with
 * its source; Override copies it here, where a nearer value wins for that name. This level's own variables
 * are text or a secret's name, editable and removable.
 */
export function EnvSection({ own, inherited, onChange }: EnvSectionProps) {
  const { names } = useSecretNames();
  const ownNames = new Set(own.map((variable) => variable.name));
  const problem = envProblem(own);
  const replace = (index: number, variable: EnvVarWire): void => {
    onChange(own.map((each, i) => (i === index ? variable : each)));
  };

  return (
    <section aria-label="Environment variables" className="flex flex-col gap-2">
      <h3 className="text-xs font-medium tracking-wider text-fg-subtle uppercase">Environment variables</h3>
      {inherited.map((each) => {
        const overridden = ownNames.has(each.variable.name);
        return (
          <div
            key={`inherited:${each.variable.name}`}
            data-testid="inherited-env"
            className="flex items-center gap-2 rounded-md border border-hairline px-2 py-1.5 text-xs text-fg-subtle"
          >
            <span className="min-w-0 truncate font-mono">{`${each.variable.name}=${shown(each.variable)}`}</span>
            <span className="truncate">{overridden ? 'overridden here' : `from ${each.from}`}</span>
            {!overridden && (
              <button
                type="button"
                aria-label={`Override ${each.variable.name}`}
                onClick={() => {
                  onChange([...own, { ...each.variable }]);
                }}
                className={`ml-auto shrink-0 ${ROW_BUTTON}`}
              >
                Override
              </button>
            )}
          </div>
        );
      })}
      {own.map((variable, index) => {
        const label = variable.name === '' ? 'new variable' : variable.name;
        return (
          <div key={`own:${String(index)}`} className="flex items-end gap-2">
            <label className="flex w-36 shrink-0 flex-col gap-1 text-xs">
              <span className="text-fg-subtle">Name</span>
              <input
                aria-label="Variable name"
                className={`${INPUT_CLASS} font-mono`}
                value={variable.name}
                spellCheck={false}
                onChange={(e) => {
                  replace(index, { ...variable, name: e.target.value });
                }}
              />
            </label>
            <label className="flex shrink-0 flex-col gap-1 text-xs">
              <span className="text-fg-subtle">Kind</span>
              <select
                aria-label={`Kind of ${label}`}
                className={INPUT_CLASS}
                value={'secret' in variable ? 'secret' : 'text'}
                onChange={(e) => {
                  replace(
                    index,
                    e.target.value === 'secret'
                      ? { name: variable.name, secret: '' }
                      : { name: variable.name, value: '' },
                  );
                }}
              >
                <option value="text">Text</option>
                <option value="secret">Secret</option>
              </select>
            </label>
            {'secret' in variable ? (
              <SecretSelect
                label={`Secret for ${label}`}
                value={variable.secret}
                names={names}
                onChange={(secret) => {
                  replace(index, { name: variable.name, secret });
                }}
              />
            ) : (
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
                <span className="text-fg-subtle">Value</span>
                <input
                  aria-label={`Value of ${label}`}
                  className={`${INPUT_CLASS} font-mono`}
                  value={variable.value}
                  spellCheck={false}
                  onChange={(e) => {
                    replace(index, { name: variable.name, value: e.target.value });
                  }}
                />
              </label>
            )}
            <button
              type="button"
              aria-label={`Remove ${label}`}
              onClick={() => {
                onChange(own.filter((_, i) => i !== index));
              }}
              className={`mb-1 ${ROW_BUTTON}`}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </div>
        );
      })}
      {problem !== undefined && (
        <p role="alert" className="text-xs text-status-danger">
          {problem}
        </p>
      )}
      <div>
        <button
          type="button"
          onClick={() => {
            onChange([...own, { name: '', value: '' }]);
          }}
          className={`inline-flex items-center gap-1 ${ROW_BUTTON}`}
        >
          <Plus size={12} aria-hidden="true" /> Add variable
        </button>
      </div>
      {(own.length > 0 || inherited.length > 0) && (
        <p className="text-xs text-fg-subtle">
          Sent when a terminal opens; the server keeps only the names its AcceptEnv allows.
        </p>
      )}
    </section>
  );
}
