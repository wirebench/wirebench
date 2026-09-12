import { PropertyTable } from './property-table.js';
import { useWorkspaceStore } from '../../state/workspace.js';

/**
 * The open workspace's `${#Workspace#…}` properties — the scope between a project's own and the
 * user's globals. Edited one key at a time through `workspace.mutate`, so two quick edits cannot
 * overwrite one another the way a whole-map replace could.
 */
export function WorkspaceProperties() {
  const properties = useWorkspaceStore((state) => state.workspace?.properties);
  const mutate = useWorkspaceStore((state) => state.mutate);

  if (properties === undefined) {
    return <p className="text-sm text-fg-subtle">Open a workspace to edit its properties.</p>;
  }

  return (
    <>
      <h3 className="mb-2 text-xs font-medium tracking-wider text-fg-subtle uppercase">Workspace properties</h3>
      <p className="mb-2 text-xs text-fg-subtle">
        Reference these as <code>{'${#Workspace#name}'}</code>.
      </p>
      <PropertyTable
        label="Workspace properties"
        properties={properties}
        onSet={(name, value) => {
          void mutate({ kind: 'set-workspace-property', name, value });
        }}
        onRemove={(name) => {
          void mutate({ kind: 'remove-workspace-property', name });
        }}
      />
    </>
  );
}
