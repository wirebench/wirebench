import { Plus } from 'lucide-react';
import type { ForwardEntryWire, GroupEntryWire } from '../../../../shared/ssh-wire.js';
import { defaultBind, ForwardForm, type ForwardFullEntry } from './forward-form.js';
import { listenAddress, typeWord } from './forward-format.js';

/** A rule the enclosing groups give this level: the nearest full definition, and the group that switched it off. */
export interface InheritedForward {
  readonly rule: ForwardFullEntry;
  /** The name of the group that defines it. */
  readonly from: string;
  /** The name of the group whose off form (or `enabled: false`) switched it off, if any. */
  readonly offBy?: string;
}

const isFull = (entry: ForwardEntryWire): entry is ForwardFullEntry => 'type' in entry;

/**
 * The rules `chain` (outermost group first) hands down, merged by id as the resolver does: a nearer full rule
 * replaces a farther one whole, an off form marks it off. First-definition order.
 */
export function inheritedForwards(chain: readonly GroupEntryWire[]): InheritedForward[] {
  const byId = new Map<string, InheritedForward>();
  for (const group of chain) {
    for (const entry of group.forwards ?? []) {
      if (isFull(entry)) {
        byId.set(entry.id, {
          rule: entry,
          from: group.name,
          ...(entry.enabled === false ? { offBy: group.name } : {}),
        });
      } else {
        const found = byId.get(entry.id);
        if (found !== undefined) byId.set(entry.id, { ...found, offBy: group.name });
      }
    }
  }
  return [...byId.values()];
}

/** `forward`, or `forward-2`, `forward-3`, … — the first no rule on this level or above uses. */
export function freeRuleId(taken: ReadonlySet<string>): string {
  let id = 'forward';
  for (let n = 2; taken.has(id); n++) id = `forward-${String(n)}`;
  return id;
}

const SWITCH_CLASS =
  'inline-flex h-4 w-7 shrink-0 items-center rounded-full border border-hairline-strong px-0.5 transition-colors focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none';

function Switch({
  label,
  on,
  onClick,
}: {
  readonly label: string;
  readonly on: boolean;
  readonly onClick: () => void;
}) {
  return (
    <span className="flex items-center gap-1 text-xs text-fg-subtle">
      {label.split(' ')[0]}
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={onClick}
        className={`${SWITCH_CLASS} ${on ? 'justify-end bg-accent' : 'justify-start bg-surface-base'}`}
      >
        <span className="size-2.5 rounded-full bg-fg-default" />
      </button>
    </span>
  );
}

function summary(rule: ForwardFullEntry): string {
  const bind = listenAddress(rule.bind ?? defaultBind(rule.type), rule.port);
  return `${typeWord(rule.type)} ${bind} → ${rule.type === 'dynamic' ? 'SOCKS' : (rule.target ?? '')}`;
}

export interface ForwardsSectionProps {
  /** This level's own `forwards`. */
  readonly own: readonly ForwardEntryWire[];
  readonly inherited: readonly InheritedForward[];
  readonly onChange: (own: ForwardEntryWire[]) => void;
}

/**
 * The host and group form's Port forwarding section. A rule from a group above shows greyed with its source
 * and two switches: Override copies it here, editable; Off writes the off form `{ id, enabled: false }`.
 * This level's own rules are editable and removable.
 */
export function ForwardsSection({ own, inherited, onChange }: ForwardsSectionProps) {
  const ownById = new Map(own.map((entry) => [entry.id, entry]));
  const inheritedIds = new Set(inherited.map((each) => each.rule.id));
  const replace = (index: number, entry: ForwardEntryWire): void => {
    onChange(own.map((each, i) => (i === index ? entry : each)));
  };
  const removeAt = (index: number): void => {
    onChange(own.filter((_, i) => i !== index));
  };
  const removeId = (id: string): void => {
    onChange(own.filter((each) => each.id !== id));
  };

  return (
    <section aria-label="Port forwarding" className="flex flex-col gap-2">
      <h3 className="text-xs font-medium tracking-wider text-fg-subtle uppercase">Port forwarding</h3>
      {inherited.map((each) => {
        const mine = ownById.get(each.rule.id);
        const index = own.findIndex((entry) => entry.id === each.rule.id);
        if (mine !== undefined && isFull(mine)) {
          return (
            <div key={`inherited:${each.rule.id}`} className="flex flex-col gap-1">
              <div className="flex justify-end">
                <Switch
                  label={`Override ${each.rule.id}`}
                  on
                  onClick={() => {
                    removeId(each.rule.id);
                  }}
                />
              </div>
              <ForwardForm
                entry={mine}
                note={`overrides ${each.from}`}
                onChange={(entry) => {
                  replace(index, entry);
                }}
              />
            </div>
          );
        }
        const offHere = mine !== undefined;
        return (
          <div
            key={`inherited:${each.rule.id}`}
            data-testid="inherited-forward"
            className="flex items-center gap-2 rounded-md border border-hairline px-2 py-1.5 text-xs text-fg-subtle"
          >
            <span className="font-medium">{each.rule.id}</span>
            <span className="min-w-0 truncate font-mono">{summary(each.rule)}</span>
            <span className="truncate">
              {offHere ? 'off here' : each.offBy === undefined ? `from ${each.from}` : `off in ${each.offBy}`}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-3">
              <Switch
                label={`Override ${each.rule.id}`}
                on={false}
                onClick={() => {
                  const { enabled: dropped, ...rule } = each.rule;
                  void dropped;
                  onChange([...own.filter((entry) => entry.id !== each.rule.id), rule]);
                }}
              />
              <Switch
                label={`Off ${each.rule.id}`}
                on={offHere}
                onClick={() => {
                  onChange(
                    offHere ? own.filter((entry) => entry !== mine) : [...own, { id: each.rule.id, enabled: false }],
                  );
                }}
              />
            </span>
          </div>
        );
      })}
      {own.map((entry, index) => {
        if (inheritedIds.has(entry.id)) return null; // drawn above, with its source
        if (!isFull(entry)) {
          // An off form with nothing above to switch off: main refuses it; offer to take it away.
          return (
            <div
              key={`off:${String(index)}`}
              className="flex items-center gap-2 rounded-md border border-hairline px-2 py-1.5 text-xs text-fg-subtle"
            >
              <span className="flex-1">{`${entry.id} is switched off here, but no group above defines it`}</span>
              <button
                type="button"
                onClick={() => {
                  removeAt(index);
                }}
                className="rounded px-1.5 hover:bg-surface-hover hover:text-fg-default"
              >
                Remove
              </button>
            </div>
          );
        }
        return (
          <ForwardForm
            key={`own:${String(index)}`}
            entry={entry}
            onChange={(next) => {
              replace(index, next);
            }}
            onRemove={() => {
              removeAt(index);
            }}
          />
        );
      })}
      <div>
        <button
          type="button"
          onClick={() => {
            const taken = new Set([...own.map((entry) => entry.id), ...inheritedIds]);
            onChange([...own, { id: freeRuleId(taken), type: 'local', port: Number.NaN }]);
          }}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-fg-subtle hover:bg-surface-hover hover:text-fg-default"
        >
          <Plus size={12} aria-hidden="true" /> Add rule
        </button>
      </div>
    </section>
  );
}
