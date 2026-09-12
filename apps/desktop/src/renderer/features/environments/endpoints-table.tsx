import { useEffect, useId, useState } from 'react';
import { selectEnvironment, useProjectStore } from '../../state/project.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import type { InterfaceWire, ProjectWire, WorkspaceEnvironmentWire } from '../../../shared/wire-types.js';
import { queueEndpointOverride } from './environment-queue.js';
import type { EffectiveEndpointSource } from '../../state/endpoint-override.js';
import { effectiveEndpointSource } from '../../state/endpoint-override.js';

const INPUT_CLASS =
  'h-row w-full min-w-0 rounded-md border border-hairline-strong bg-surface-raised px-2 text-sm text-fg-default focus:outline-none focus:ring-1 focus:ring-accent';

/** What each source reads as, and what its tooltip spells out. */
const SOURCE_LABEL: Record<EffectiveEndpointSource, { readonly short: string; readonly title: string }> = {
  project: { short: 'project', title: "The linked project's own environment overrides this interface — it wins." },
  workspace: { short: 'workspace', title: "This environment's override is what the request is sent to." },
  interface: { short: 'interface', title: 'No override: the request uses the interface address.' },
  none: { short: 'not set', title: 'No override and no interface address — the request has nowhere to go.' },
};

/** One row: an interface, the key its override is stored under, and (for a workspace
 * environment) which layer currently wins. */
interface Row {
  readonly iface: InterfaceWire;
  readonly projectName: string;
  readonly key: string;
  readonly override: string | undefined;
  /** Present only when this row belongs to a workspace environment — a project environment has
   * nothing else contending for the same interface, so there is no precedence to show. */
  readonly source?: EffectiveEndpointSource;
}

interface EndpointRowProps {
  readonly row: Row;
  readonly onCommit: (key: string, url: string) => void;
}

/** One interface's override URL: a free-text field backed by the interface's declared addresses. */
function EndpointRow({ row, onCommit }: EndpointRowProps) {
  const listId = useId();
  const [draft, setDraft] = useState(row.override ?? '');

  useEffect(() => {
    setDraft(row.override ?? '');
  }, [row.override]);

  // The project is the group header now, not part of the row; the field's accessible name keeps
  // both, so an interface of the same name in two projects stays distinguishable out of context.
  const label = `Endpoint override for ${row.projectName} › ${row.iface.name}`;

  return (
    <tr
      data-testid="env-endpoint-row"
      data-endpoint-key={row.key}
      {...(row.source !== undefined ? { 'data-source': row.source } : {})}
    >
      <th scope="row" className="py-0.5 pr-2 pl-3 text-left text-sm font-normal text-fg-default">
        {row.iface.name}
      </th>
      <td className="py-0.5 pr-2">
        <input
          aria-label={label}
          data-testid="environment-endpoint"
          list={listId}
          placeholder="No override — use the interface's endpoint"
          className={`${INPUT_CLASS} font-mono`}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onBlur={() => {
            onCommit(row.key, draft);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              onCommit(row.key, draft);
            }
            if (event.key === 'Escape') {
              setDraft(row.override ?? '');
            }
          }}
        />
        <datalist id={listId}>
          {row.iface.endpoints.map((endpoint) => (
            <option key={endpoint.id} value={endpoint.url} />
          ))}
        </datalist>
      </td>
      {row.source !== undefined && (
        <td className="w-24 py-0.5 pl-2">
          <span
            data-testid="workspace-env-source"
            title={SOURCE_LABEL[row.source].title}
            className="text-xs text-fg-subtle"
          >
            {SOURCE_LABEL[row.source].short}
          </span>
        </td>
      )}
    </tr>
  );
}

/** Every interface of every open project, in the workspace's project order, for a workspace
 * environment: `key` is `<projectSlug>/<interfaceSlug>`, the map a workspace environment stores
 * its overrides under. */
function workspaceRows(
  environment: WorkspaceEnvironmentWire,
  order: readonly { readonly projectId: string; readonly interfaceIds: readonly string[] }[],
  interfaces: Readonly<Record<string, InterfaceWire>>,
  projects: Readonly<Record<string, ProjectWire>>,
  workspaceProjectOrder: readonly { readonly id: string; readonly slug: string }[],
): readonly Row[] {
  const rows: Row[] = [];
  for (const project of workspaceProjectOrder) {
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
      const key = `${project.slug}/${iface.slug}`;
      const override = environment.endpoints[key];
      const projectOverride = mirrored?.environments.find((candidate) => candidate.slug === environment.slug)
        ?.endpoints[iface.slug];
      const interfaceDefault = (
        iface.endpoints.find((endpoint) => endpoint.id === iface.defaultEndpointId) ?? iface.endpoints[0]
      )?.url;
      rows.push({
        iface,
        projectName: mirrored?.name ?? project.slug,
        key,
        override,
        source: effectiveEndpointSource({
          ...(projectOverride !== undefined ? { projectOverride } : {}),
          ...(override !== undefined ? { workspaceOverride: override } : {}),
          ...(interfaceDefault !== undefined ? { interfaceDefault } : {}),
        }),
      });
    }
  }
  return rows;
}

export interface EndpointsTableProps {
  /** The environment this table edits — a workspace environment or a linked project's own. */
  readonly environmentId: string;
}

/**
 * One environment's endpoint overrides: one row per interface, grouped under the owning
 * project's name as a group header (spec §2.2), each backed by the interface's declared
 * addresses. A workspace environment shows every open project's
 * interfaces (keyed `<projectSlug>/<interfaceSlug>`) plus which layer currently wins for it; a
 * linked project's own environment shows only that project's interfaces (keyed by slug alone),
 * with nothing else to show precedence against.
 */
export function EndpointsTable({ environmentId }: EndpointsTableProps) {
  const workspace = useWorkspaceStore((state) => state.workspace);
  const interfaces = useProjectStore((state) => state.interfaces);
  const projects = useProjectStore((state) => state.projects);
  const order = useProjectStore((state) => state.order);
  const projectEnvironment = useProjectStore((state) => selectEnvironment(state, environmentId));
  const ownerProjectId = useProjectStore((state) => state.projectOf[environmentId]);

  const workspaceEnvironment = workspace?.environments.find((candidate) => candidate.id === environmentId);

  if (workspaceEnvironment !== undefined) {
    const rows = workspaceRows(
      workspaceEnvironment,
      order,
      interfaces,
      projects,
      workspace?.projects.map((project) => ({ id: project.id, slug: project.slug })) ?? [],
    );
    return (
      <EndpointsTableView
        rows={rows}
        onCommit={(key, url) => {
          void queueEndpointOverride(environmentId, key, url);
        }}
      />
    );
  }

  if (projectEnvironment !== undefined && ownerProjectId !== undefined) {
    const ifaceIds = order.filter((group) => group.projectId === ownerProjectId).flatMap((group) => group.interfaceIds);
    const rows: Row[] = ifaceIds
      .map((id) => interfaces[id])
      .filter((iface): iface is InterfaceWire => iface !== undefined)
      .map((iface) => ({
        iface,
        projectName: projects[ownerProjectId]?.name ?? 'this project',
        key: iface.slug,
        override: projectEnvironment.endpoints[iface.slug],
      }));
    const updateEnvironment = useProjectStore.getState().updateEnvironment;
    return (
      <EndpointsTableView
        rows={rows}
        onCommit={(key, url) => {
          const current = selectEnvironment(useProjectStore.getState(), environmentId);
          if (current === undefined) {
            return;
          }
          const next: Record<string, string> = { ...current.endpoints };
          const trimmed = url.trim();
          if (trimmed.length === 0) {
            delete next[key];
          } else {
            next[key] = trimmed;
          }
          if (JSON.stringify(next) === JSON.stringify(current.endpoints)) {
            return;
          }
          void updateEnvironment(ownerProjectId, environmentId, { endpoints: next });
        }}
      />
    );
  }

  return null;
}

function EndpointsTableView({
  rows,
  onCommit,
}: {
  readonly rows: readonly Row[];
  readonly onCommit: (key: string, url: string) => void;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-fg-subtle">Import a WSDL to override its endpoint here.</p>;
  }
  const hasSource = rows.some((row) => row.source !== undefined);
  const columns = hasSource ? 3 : 2;
  return (
    <table aria-label="Endpoint overrides" data-testid="env-endpoints-table" className="w-full border-collapse">
      <thead>
        <tr className="text-left text-xs tracking-wider text-fg-subtle uppercase">
          <th className="pb-1 font-medium">Interface</th>
          <th className="pb-1 font-medium">Override URL</th>
          {hasSource && <th className="pb-1 font-medium">Source</th>}
        </tr>
      </thead>
      {/* Spec §2.2: one group per project, the project name as the group's header, rather than
          repeating it on every row. `rows` already arrives in the workspace's project order, so
          consecutive runs of the same project are exactly the groups. */}
      {groupByProject(rows).map((group) => (
        <tbody key={group.projectName}>
          <tr>
            <th
              scope="colgroup"
              colSpan={columns}
              data-testid="env-endpoints-group"
              className="pt-2 pb-0.5 text-left text-xs font-medium tracking-wider text-fg-subtle uppercase"
            >
              {group.projectName}
            </th>
          </tr>
          {group.rows.map((row) => (
            <EndpointRow key={row.iface.id} row={row} onCommit={onCommit} />
          ))}
        </tbody>
      ))}
    </table>
  );
}

/** Consecutive rows of the same project, in the order they arrive. */
function groupByProject(rows: readonly Row[]): readonly { readonly projectName: string; readonly rows: Row[] }[] {
  const groups: { projectName: string; rows: Row[] }[] = [];
  for (const row of rows) {
    const last = groups.at(-1);
    if (last !== undefined && last.projectName === row.projectName) {
      last.rows.push(row);
    } else {
      groups.push({ projectName: row.projectName, rows: [row] });
    }
  }
  return groups;
}
