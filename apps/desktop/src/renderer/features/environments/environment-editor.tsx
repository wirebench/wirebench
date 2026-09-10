import { useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { IconButton } from '../../components/icon-button.js';
import { PropertyTable } from '../properties/property-table.js';
import { useProjectStore } from '../../state/project.js';
import type { InterfaceWire, PropertyMapWire } from '../../../shared/wire-types.js';

/** How long the name field waits after the last keystroke before it saves. */
export const NAME_DEBOUNCE_MS = 300;

const INPUT_CLASS =
  'h-row w-full min-w-0 rounded-md border border-hairline-strong bg-surface-raised px-2 text-sm text-fg-default focus:outline-none focus:ring-1 focus:ring-accent';

interface EndpointRowProps {
  readonly iface: InterfaceWire;
  readonly override: string | undefined;
  readonly onCommit: (url: string) => void;
}

/** One interface's override URL: a free-text field backed by the interface's declared addresses. */
function EndpointRow({ iface, override, onCommit }: EndpointRowProps) {
  const listId = useId();
  const [draft, setDraft] = useState(override ?? '');

  useEffect(() => {
    setDraft(override ?? '');
  }, [override]);

  return (
    <tr>
      <td className="w-1/3 py-0.5 pr-2 text-sm text-fg-default">{iface.name}</td>
      <td className="py-0.5 pr-2">
        <input
          aria-label={`Endpoint override for ${iface.name}`}
          data-testid="environment-endpoint"
          list={listId}
          placeholder="No override — use the request's endpoint"
          className={`${INPUT_CLASS} font-mono`}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onBlur={() => {
            onCommit(draft);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              onCommit(draft);
            }
            if (event.key === 'Escape') {
              setDraft(override ?? '');
            }
          }}
        />
        <datalist id={listId}>
          {iface.endpoints.map((endpoint) => (
            <option key={endpoint.id} value={endpoint.url} />
          ))}
        </datalist>
      </td>
      <td className="w-8 py-0.5">
        <IconButton
          label={`Clear override for ${iface.name}`}
          onClick={() => {
            setDraft('');
            onCommit('');
          }}
        >
          <X size={13} aria-hidden="true" />
        </IconButton>
      </td>
    </tr>
  );
}

export interface EnvironmentEditorProps {
  readonly environmentId: string;
}

/**
 * The environment tab: its name, one endpoint override per interface, and its properties.
 * Both maps are sent back whole — `update-environment` REPLACES them — so every edit here
 * rebuilds the map from the mirror and hands main the complete result.
 */
export function EnvironmentEditor({ environmentId }: EnvironmentEditorProps) {
  const environment = useProjectStore((state) =>
    state.environments.find((candidate) => candidate.id === environmentId),
  );
  const interfaces = useProjectStore((state) => state.interfaces);
  const order = useProjectStore((state) => state.order);
  const updateEnvironment = useProjectStore((state) => state.updateEnvironment);

  const [name, setName] = useState(environment?.name ?? '');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const savedName = environment?.name;

  useEffect(() => {
    setName(savedName ?? '');
  }, [savedName]);

  useEffect(
    () => () => {
      if (timer.current !== undefined) {
        clearTimeout(timer.current);
      }
    },
    [],
  );

  if (environment === undefined) {
    return <p className="p-4 text-sm text-fg-subtle">This environment no longer exists.</p>;
  }

  const onNameChange = (next: string): void => {
    setName(next);
    if (timer.current !== undefined) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(() => {
      const trimmed = next.trim();
      if (trimmed.length > 0 && trimmed !== environment.name) {
        void updateEnvironment(environmentId, { name: trimmed });
      }
    }, NAME_DEBOUNCE_MS);
  };

  const replaceEndpoints = (slug: string, url: string): void => {
    const next: Record<string, string> = { ...environment.endpoints };
    const trimmed = url.trim();
    if (trimmed.length === 0) {
      delete next[slug];
    } else {
      next[slug] = trimmed;
    }
    if (JSON.stringify(next) === JSON.stringify(environment.endpoints)) {
      return;
    }
    void updateEnvironment(environmentId, { endpoints: next });
  };

  const replaceProperties = (properties: PropertyMapWire): void => {
    void updateEnvironment(environmentId, { properties });
  };

  const summaries = order.map((id) => interfaces[id]).filter((iface): iface is InterfaceWire => iface !== undefined);

  return (
    <section
      data-testid="environment-editor"
      aria-label={`Environment ${environment.name}`}
      className="flex h-full min-h-0 flex-col gap-4 overflow-auto p-4"
    >
      <label className="flex max-w-md flex-col gap-1">
        <span className="text-xs font-medium tracking-wider text-fg-subtle uppercase">Name</span>
        <input
          aria-label="Environment name"
          className={INPUT_CLASS}
          value={name}
          onChange={(event) => {
            onNameChange(event.target.value);
          }}
        />
      </label>

      <div className="flex flex-col gap-1">
        <h3 className="text-xs font-medium tracking-wider text-fg-subtle uppercase">Endpoints</h3>
        {summaries.length === 0 ? (
          <p className="text-sm text-fg-subtle">Import a WSDL to override its endpoint here.</p>
        ) : (
          <table aria-label="Endpoint overrides" className="w-full table-fixed border-collapse">
            <thead>
              <tr className="text-left text-xs tracking-wider text-fg-subtle uppercase">
                <th className="pb-1 font-medium">Interface</th>
                <th className="pb-1 font-medium">Override URL</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {summaries.map((iface) => (
                <EndpointRow
                  key={iface.id}
                  iface={iface}
                  override={environment.endpoints[iface.slug]}
                  onCommit={(url) => {
                    replaceEndpoints(iface.slug, url);
                  }}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <h3 className="text-xs font-medium tracking-wider text-fg-subtle uppercase">Properties</h3>
        <PropertyTable
          label="Environment properties"
          properties={environment.properties}
          onSet={(propertyName, value) => {
            replaceProperties({ ...environment.properties, [propertyName]: value });
          }}
          onRemove={(propertyName) => {
            const next = { ...environment.properties };
            delete next[propertyName];
            replaceProperties(next);
          }}
          onRename={(from, to) => {
            const next: Record<string, string> = {};
            for (const [key, value] of Object.entries(environment.properties)) {
              next[key === from ? to : key] = value;
            }
            replaceProperties(next);
          }}
        />
      </div>
    </section>
  );
}
