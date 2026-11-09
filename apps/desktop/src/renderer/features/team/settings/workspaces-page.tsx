/**
 * Team settings › Workspaces: the team's workspaces as rows, each opening its overview (where its settings, access
 * and Delete live), and *New workspace…*, which any member may use.
 */
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '../../../components/button.js';
import { teamWorkspaces, useTeamStore } from '../../../state/team.js';
import { NewWorkspaceForm } from '../workspaces-tab.js';
import { WorkspaceList } from './workspace-list.js';

export function WorkspacesPage() {
  const store = useTeamStore();
  const workspaces = teamWorkspaces(store);
  const [creating, setCreating] = useState(false);

  return (
    <div data-testid="workspaces-tab" className="flex flex-col gap-3">
      {creating ? (
        <NewWorkspaceForm
          onDone={() => {
            setCreating(false);
          }}
        />
      ) : (
        <div className="flex justify-end">
          <Button
            variant="primary"
            data-testid="workspace-new"
            onClick={() => {
              setCreating(true);
            }}
          >
            <Plus size={14} aria-hidden="true" />
            New workspace…
          </Button>
        </div>
      )}
      {workspaces.length === 0 ? (
        <p className="py-6 text-center text-sm text-fg-subtle">No workspaces you can open in this team yet.</p>
      ) : (
        <WorkspaceList workspaces={workspaces} />
      )}
    </div>
  );
}
