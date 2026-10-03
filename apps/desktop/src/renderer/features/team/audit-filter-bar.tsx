import { Button } from '../../components/button.js';
import {
  ACTION_GROUPS,
  ACTION_GROUP_LABELS,
  RANGE_LABELS,
  RANGE_PRESETS,
  type ActionGroup,
  type RangePreset,
} from '../../state/audit-format.js';
import { useAuditStore } from '../../state/audit.js';
import { SELECT_CLASS } from './roles.js';

/** The Audit tab's filters (audit-log spec §3.6): range, kind and, when the server has any, workspace. */
export function AuditFilterBar({
  url,
  workspaces,
}: {
  readonly url: string;
  readonly workspaces: readonly { id: string; name: string }[];
}) {
  const filter = useAuditStore((s) => s.filter);
  const exporting = useAuditStore((s) => s.exporting);
  const store = useAuditStore.getState;
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-xs text-fg-subtle">
        Range
        <select
          data-testid="audit-range"
          className={SELECT_CLASS}
          value={filter.range}
          onChange={(event) => void store().setFilter(url, { range: event.target.value as RangePreset })}
        >
          {RANGE_PRESETS.map((preset) => (
            <option key={preset} value={preset}>
              {RANGE_LABELS[preset]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-fg-subtle">
        Kind
        <select
          data-testid="audit-group"
          className={SELECT_CLASS}
          value={filter.group}
          onChange={(event) => void store().setFilter(url, { group: event.target.value as ActionGroup | 'all' })}
        >
          <option value="all">All kinds</option>
          {ACTION_GROUPS.map((group) => (
            <option key={group} value={group}>
              {ACTION_GROUP_LABELS[group]}
            </option>
          ))}
        </select>
      </label>
      {workspaces.length > 0 && (
        <label className="flex flex-col gap-1 text-xs text-fg-subtle">
          Workspace
          <select
            data-testid="audit-workspace"
            className={SELECT_CLASS}
            value={filter.workspaceId ?? ''}
            onChange={(event) =>
              void store().setFilter(url, { workspaceId: event.target.value === '' ? undefined : event.target.value })
            }
          >
            <option value="">Any workspace</option>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="ml-auto flex gap-2">
        <Button variant="ghost" data-testid="audit-refresh" onClick={() => void store().load(url)}>
          Refresh
        </Button>
        <Button
          variant="primary"
          data-testid="audit-export"
          disabled={exporting}
          onClick={() => void store().exportToFile(url)}
        >
          Export…
        </Button>
      </div>
    </div>
  );
}
