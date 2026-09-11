import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { IconButton } from '../../components/icon-button.js';
import { PropertyTable } from '../properties/property-table.js';
import { selectEnvironment, useProjectStore } from '../../state/project.js';
import type { EnvironmentPatchWire, InterfaceWire, PropertyMapWire } from '../../../shared/wire-types.js';

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
 * One **project** environment's editor: its name, one endpoint override per interface of that
 * project, and its properties. Only a linked project has environments of its own; the
 * workspace's environments are edited in the grid (`environment-grid.tsx`).
 *
 * Both maps are sent back whole — `update-environment` REPLACES them — so every edit here
 * rebuilds the map from the mirror and hands main the complete result.
 */
export function EnvironmentEditor({ environmentId }: EnvironmentEditorProps) {
  const environment = useProjectStore((state) => selectEnvironment(state, environmentId));
  const interfaces = useProjectStore((state) => state.interfaces);
  const projectId = useProjectStore((state) => state.projectOf[environmentId]);
  const order = useProjectStore((state) => state.order);
  const projectName = useProjectStore((state) =>
    projectId === undefined ? undefined : state.projects[projectId]?.name,
  );
  const updateProjectEnvironment = useProjectStore((state) => state.updateEnvironment);
  const updateEnvironment = useCallback(
    async (id: string, patch: EnvironmentPatchWire): Promise<void> => {
      if (projectId !== undefined) {
        await updateProjectEnvironment(projectId, id, patch);
      }
    },
    [projectId, updateProjectEnvironment],
  );

  const [name, setName] = useState(environment?.name ?? '');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const savedName = environment?.name;

  // Tracks a name edit that has been typed but not yet committed (debounce still pending), so
  // it can be flushed instead of lost if the tab is closed or switched before the timer fires.
  const pendingNameRef = useRef<{ environmentId: string; trimmed: string; baseline: string } | undefined>(undefined);

  useEffect(() => {
    setName(savedName ?? '');
  }, [savedName]);

  useEffect(
    () => () => {
      if (timer.current !== undefined) {
        clearTimeout(timer.current);
      }
      const pendingName = pendingNameRef.current;
      if (pendingName !== undefined && pendingName.trimmed !== pendingName.baseline) {
        void updateEnvironment(pendingName.environmentId, { name: pendingName.trimmed });
      }
      pendingNameRef.current = undefined;
    },
    [environmentId, updateEnvironment],
  );

  if (environment === undefined) {
    return <p className="p-4 text-sm text-fg-subtle">This environment no longer exists.</p>;
  }

  const onNameChange = (next: string): void => {
    setName(next);
    if (timer.current !== undefined) {
      clearTimeout(timer.current);
    }
    const trimmed = next.trim();
    pendingNameRef.current = { environmentId, trimmed, baseline: environment.name };
    timer.current = setTimeout(() => {
      pendingNameRef.current = undefined;
      if (trimmed.length > 0 && trimmed !== environment.name) {
        void updateEnvironment(environmentId, { name: trimmed });
      }
    }, NAME_DEBOUNCE_MS);
  };

  // Reads the latest environment from the store rather than the value captured at render time:
  // two commits fired back-to-back (before either IPC round trip resolves) must each build their
  // map from what the other just wrote, or the second overwrites the first.
  const latestEnvironment = (): NonNullable<typeof environment> =>
    selectEnvironment(useProjectStore.getState(), environmentId) ?? environment;

  const replaceEndpoints = (slug: string, url: string): void => {
    const current = latestEnvironment();
    const next: Record<string, string> = { ...current.endpoints };
    const trimmed = url.trim();
    if (trimmed.length === 0) {
      delete next[slug];
    } else {
      next[slug] = trimmed;
    }
    if (JSON.stringify(next) === JSON.stringify(current.endpoints)) {
      return;
    }
    void updateEnvironment(environmentId, { endpoints: next });
  };

  const replaceProperties = (properties: PropertyMapWire): void => {
    void updateEnvironment(environmentId, { properties });
  };

  // Only the owning project's interfaces: a project environment keys its overrides by interface
  // slug alone, and knows nothing about the other projects in the workspace.
  const summaries = order
    .filter((group) => group.projectId === projectId)
    .flatMap((group) => group.interfaceIds)
    .map((id) => interfaces[id])
    .filter((iface): iface is InterfaceWire => iface !== undefined);

  return (
    <section
      data-testid="environment-editor"
      aria-label={`Environment ${environment.name}`}
      className="flex h-full min-h-0 flex-col gap-4 overflow-auto p-4"
    >
      <p className="text-xs text-fg-subtle">Project environments ({projectName ?? 'this project'} — linked project)</p>

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
              {summaries.map((iface) => {
                return (
                  <EndpointRow
                    key={iface.id}
                    iface={iface}
                    override={environment.endpoints[iface.slug]}
                    onCommit={(url) => {
                      replaceEndpoints(iface.slug, url);
                    }}
                  />
                );
              })}
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
            replaceProperties({ ...latestEnvironment().properties, [propertyName]: value });
          }}
          onRemove={(propertyName) => {
            const next = { ...latestEnvironment().properties };
            delete next[propertyName];
            replaceProperties(next);
          }}
          onRename={(from, to) => {
            const next: Record<string, string> = {};
            for (const [key, value] of Object.entries(latestEnvironment().properties)) {
              next[key === from ? to : key] = value;
            }
            replaceProperties(next);
          }}
        />
      </div>
    </section>
  );
}
