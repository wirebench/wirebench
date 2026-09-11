import { useEffect, useId, useState } from 'react';
import { PropertyTable } from '../properties/property-table.js';
import { useProjectStore } from '../../state/project.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import type {
  InterfaceWire,
  ProjectWire,
  WorkspaceEnvironmentWire,
  WorkspaceWire,
} from '../../../shared/wire-types.js';
import { queueEndpointOverride, queueEnvironmentPatch } from './environment-queue.js';

const INPUT_CLASS =
  'h-row w-full min-w-0 rounded-md border border-hairline-strong bg-surface-raised px-2 text-sm text-fg-default focus:outline-none focus:ring-1 focus:ring-accent';

/** Where the URL a request would actually be sent to comes from, for one interface + environment. */
export type EffectiveEndpointSource = 'project' | 'workspace' | 'interface' | 'none';

/** What each source reads as in the grid, and what its tooltip spells out. */
const SOURCE_LABEL: Record<EffectiveEndpointSource, { readonly short: string; readonly title: string }> = {
  project: { short: 'project', title: "The linked project's own environment overrides this interface — it wins." },
  workspace: { short: 'workspace', title: "This environment's override is what the request is sent to." },
  interface: { short: 'interface', title: 'No override: the request uses the interface address.' },
  none: { short: 'not set', title: 'No override and no interface address — the request has nowhere to go.' },
};

/**
 * Which layer wins for one interface under one environment. Mirrors the engine's
 * `resolveWorkspaceEndpoint` precedence on the renderer's mirror: a linked project's own
 * environment (matched to this one by slug) beats the workspace environment's override, which
 * beats the interface's declared address.
 */
export function effectiveEndpointSource(input: {
  readonly projectOverride?: string;
  readonly workspaceOverride?: string;
  readonly interfaceDefault?: string;
}): EffectiveEndpointSource {
  if (input.projectOverride !== undefined) {
    return 'project';
  }
  if (input.workspaceOverride !== undefined) {
    return 'workspace';
  }
  return input.interfaceDefault !== undefined ? 'interface' : 'none';
}

/** One row of the grid: an interface, and how to address it in an environment's endpoint map. */
interface GridRow {
  readonly iface: InterfaceWire;
  readonly projectId: string;
  readonly projectName: string;
  /** `<projectSlug>/<interfaceSlug>` — the key a workspace environment stores the override under. */
  readonly key: string;
  /** The project's own environments, for the precedence label. Empty for an internal project. */
  readonly projectEnvironments: ProjectWire['environments'];
}

/**
 * Every interface of every open project, in the workspace's project order. An interface whose
 * project the workspace does not list (it is still opening, or has just left) has no key and so
 * no row.
 */
function gridRows(
  workspace: WorkspaceWire,
  order: readonly { readonly projectId: string; readonly interfaceIds: readonly string[] }[],
  interfaces: Readonly<Record<string, InterfaceWire>>,
  projects: Readonly<Record<string, ProjectWire>>,
): readonly GridRow[] {
  const rows: GridRow[] = [];
  for (const project of workspace.projects) {
    const group = order.find((candidate) => candidate.projectId === project.id);
    if (group === undefined) {
      continue;
    }
    const mirrored = projects[project.id];
    for (const interfaceId of group.interfaceIds) {
      const iface = interfaces[interfaceId];
      if (iface === undefined) {
        continue;
      }
      rows.push({
        iface,
        projectId: project.id,
        projectName: mirrored?.name ?? project.name,
        key: `${project.slug}/${iface.slug}`,
        projectEnvironments: mirrored?.environments ?? [],
      });
    }
  }
  return rows;
}

interface CellProps {
  readonly row: GridRow;
  readonly environment: WorkspaceEnvironmentWire;
}

/**
 * One interface's override in one environment: a free-text field backed by the interface's
 * declared addresses, plus the layer that actually wins for this pair.
 */
function EnvironmentCell({ row, environment }: CellProps) {
  const listId = useId();
  const override = environment.endpoints[row.key];
  const [draft, setDraft] = useState(override ?? '');

  useEffect(() => {
    setDraft(override ?? '');
  }, [override]);

  const label = `Endpoint override for ${row.projectName} › ${row.iface.name} in ${environment.name}`;
  const projectOverride = row.projectEnvironments.find((candidate) => candidate.slug === environment.slug)?.endpoints[
    row.iface.slug
  ];
  const interfaceDefault = (
    row.iface.endpoints.find((endpoint) => endpoint.id === row.iface.defaultEndpointId) ?? row.iface.endpoints[0]
  )?.url;
  const source = effectiveEndpointSource({
    ...(projectOverride !== undefined ? { projectOverride } : {}),
    ...(override !== undefined ? { workspaceOverride: override } : {}),
    ...(interfaceDefault !== undefined ? { interfaceDefault } : {}),
  });
  const commit = (value: string): void => {
    void queueEndpointOverride(environment.id, row.key, value);
  };

  return (
    <td
      data-testid="workspace-env-cell"
      data-environment-id={environment.id}
      data-endpoint-key={row.key}
      data-source={source}
      className="py-0.5 pr-2 align-top"
    >
      <input
        aria-label={label}
        data-testid="environment-endpoint"
        list={listId}
        placeholder="No override"
        className={`${INPUT_CLASS} font-mono`}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onBlur={() => {
          commit(draft);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commit(draft);
          }
          if (event.key === 'Escape') {
            setDraft(override ?? '');
          }
        }}
      />
      <datalist id={listId}>
        {row.iface.endpoints.map((endpoint) => (
          <option key={endpoint.id} value={endpoint.url} />
        ))}
      </datalist>
      <span data-testid="workspace-env-source" title={SOURCE_LABEL[source].title} className="text-xs text-fg-subtle">
        {SOURCE_LABEL[source].short}
      </span>
    </td>
  );
}

export interface EnvironmentGridProps {
  /** The environment the tab was opened on — the column whose properties start out shown. */
  readonly environmentId: string;
}

/**
 * The workspace Environments view: one row per interface of every open project, one column per
 * environment, and the selected environment's `${#Env#…}` properties below.
 *
 * Every cell edit replaces the whole `endpoints` map, so edits are queued per environment
 * (see `environment-queue.ts`) rather than each reading the map as it was at render time.
 */
export function EnvironmentGrid({ environmentId }: EnvironmentGridProps) {
  const workspace = useWorkspaceStore((state) => state.workspace);
  const interfaces = useProjectStore((state) => state.interfaces);
  const projects = useProjectStore((state) => state.projects);
  const order = useProjectStore((state) => state.order);

  const [selectedId, setSelectedId] = useState(environmentId);
  useEffect(() => {
    setSelectedId(environmentId);
  }, [environmentId]);

  const environments = [...(workspace?.environments ?? [])].sort((left, right) => left.order - right.order);
  const selected = environments.find((candidate) => candidate.id === selectedId) ?? environments[0];

  if (workspace === null || environments.length === 0) {
    return (
      <section data-testid="workspace-env-grid" aria-label="Workspace environments" className="p-4">
        <p className="text-sm text-fg-subtle">
          No environments yet. Add one in the Explorer&apos;s Environments section.
        </p>
      </section>
    );
  }

  const rows = gridRows(workspace, order, interfaces, projects);

  return (
    <section
      data-testid="workspace-env-grid"
      aria-label="Workspace environments"
      className="flex h-full min-h-0 flex-col gap-4 overflow-auto p-4"
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-xs font-medium tracking-wider text-fg-subtle uppercase">Endpoints</h3>
        {rows.length === 0 ? (
          <p className="text-sm text-fg-subtle">Import a WSDL to override its endpoint here.</p>
        ) : (
          <table aria-label="Endpoint overrides" className="w-full border-collapse">
            <thead>
              <tr className="text-left text-xs tracking-wider text-fg-subtle uppercase">
                <th className="pb-1 font-medium">Interface</th>
                {environments.map((environment) => (
                  <th key={environment.id} className="pb-1 font-medium">
                    {environment.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.iface.id}>
                  <th scope="row" className="py-0.5 pr-2 text-left text-sm font-normal text-fg-default">
                    {row.projectName} › {row.iface.name}
                  </th>
                  {environments.map((environment) => (
                    <EnvironmentCell key={environment.id} row={row} environment={environment} />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selected !== undefined && (
        <div className="flex flex-col gap-1">
          <h3 className="text-xs font-medium tracking-wider text-fg-subtle uppercase">Properties</h3>
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Environment to edit">
            {environments.map((environment) => (
              <button
                key={environment.id}
                type="button"
                aria-pressed={environment.id === selected.id}
                onClick={() => {
                  setSelectedId(environment.id);
                }}
                className={`rounded px-2 py-1 text-sm ${
                  environment.id === selected.id
                    ? 'bg-accent-muted text-fg-default'
                    : 'text-fg-subtle hover:bg-surface-raised'
                }`}
              >
                {environment.name}
              </button>
            ))}
          </div>
          <p className="text-xs text-fg-subtle">
            Reference these as <code>{'${#Env#name}'}</code>.
          </p>
          <PropertyTable
            label={`Properties of ${selected.name}`}
            properties={selected.properties}
            onSet={(name, value) => {
              void queueEnvironmentPatch(selected.id, (environment) => ({
                properties: { ...environment.properties, [name]: value },
              }));
            }}
            onRemove={(name) => {
              void queueEnvironmentPatch(selected.id, (environment) => {
                const next = { ...environment.properties };
                delete next[name];
                return { properties: next };
              });
            }}
            onRename={(from, to) => {
              void queueEnvironmentPatch(selected.id, (environment) => {
                const next: Record<string, string> = {};
                for (const [name, value] of Object.entries(environment.properties)) {
                  next[name === from ? to : name] = value;
                }
                return { properties: next };
              });
            }}
          />
        </div>
      )}
    </section>
  );
}
