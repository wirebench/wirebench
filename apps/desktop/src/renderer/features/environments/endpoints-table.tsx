import { useEffect, useId, useState } from 'react';
import { selectEnvironment, useProjectStore } from '../../state/project.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import type { InterfaceWire, ProjectWire, WorkspaceEnvironmentWire } from '../../../shared/wire-types.js';
import { queueEndpointOverride } from './environment-queue.js';
import type { EffectiveEndpointSource } from '../../state/endpoint-override.js';
import { effectiveEndpointSource } from '../../state/endpoint-override.js';

// Mirrors the variables table's INPUT_CLASS so both tables read as one system: transparent
// border and background by default (a row reads as data, not a form field), only the border's
// colour changes on hover, and focus keeps the accent ring as the only indicator.
const INPUT_CLASS =
  'h-row w-full min-w-0 rounded-md border border-transparent bg-transparent px-2 text-sm text-fg-default hover:border-hairline-strong focus:border-transparent focus:outline-none focus:ring-1 focus:ring-accent';

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
      className="border-b border-hairline hover:bg-surface-hover"
    >
      {/* Blank spacer cell — lines this row's Interface column up under the variables table's
          Variable column, both starting after the same-width leading column. */}
      <td className="px-2 py-1" />
      <th scope="row" className="px-2 py-1 text-left text-sm font-normal text-fg-default">
        {row.iface.name}
      </th>
      <td className="px-2 py-1">
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
        <td className="px-2 py-1">
          <span
            data-testid="workspace-env-source"
            title={SOURCE_LABEL[row.source].title}
            className="text-xs text-fg-subtle"
          >
            {SOURCE_LABEL[row.source].short}
          </span>
        </td>
      )}
      {/* Blank trailing spacer — matches the variables table's delete-action column so both
          tables' right edges line up. */}
      <td className="px-2 py-1" />
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
  // Leading and trailing blank spacer columns, matching the variables table's On and
  // delete-action columns, so the two tables' Interface/Value and Source/Resolves columns —
  // and their outer edges — line up.
  const columns = hasSource ? 5 : 4;
  return (
    <div className="overflow-hidden rounded-md border border-hairline">
      <table
        aria-label="Endpoint overrides"
        data-testid="env-endpoints-table"
        className="w-full table-fixed border-collapse text-sm"
      >
        <colgroup>
          <col className="w-11" />
          <col className="w-[22%]" />
          <col />
          {hasSource && <col className="w-[26%]" />}
          <col className="w-9" />
        </colgroup>
        <thead>
          <tr className="border-b border-hairline text-left text-xs tracking-wider text-fg-subtle uppercase">
            <th className="px-2 py-1.5" />
            <th className="px-2 py-1.5 font-medium">Interface</th>
            <th className="px-2 py-1.5 font-medium">Override URL</th>
            {hasSource && <th className="px-2 py-1.5 font-medium">Source</th>}
            <th className="px-2 py-1.5" />
          </tr>
        </thead>
        {/* Spec §2.2: one group per project, the project name as the group's header, rather than
            repeating it on every row. `rows` already arrives in the workspace's project order, so
            consecutive runs of the same project are exactly the groups. */}
        {groupByProject(rows).map((group) => (
          <tbody key={group.projectName}>
            <tr className="bg-surface-raised">
              <th
                scope="colgroup"
                colSpan={columns}
                data-testid="env-endpoints-group"
                className="border-b border-hairline px-2 py-1 text-left text-xs font-medium tracking-wider text-fg-subtle uppercase"
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
    </div>
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
