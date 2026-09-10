import { useCallback, useEffect, useState } from 'react';
import { FileDown, FilePlus, FolderOpen } from 'lucide-react';
import { Button } from '../../components/button.js';
import type { RecentProject } from '../../../shared/wire-types.js';
import { useProjectStore } from '../../state/project.js';
import { projectActions } from './project-actions.js';

export interface WelcomeScreenProps {
  /** Opens the Import WSDL dialog; owned by the shell so the command palette shares it. */
  readonly onImportDefinition: () => void;
}

/** `2026-09-10T08:30:00Z` as a short local date — precise enough to tell two sessions apart. */
function formatOpenedAt(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

function RecentRow({ entry, onOpen }: { entry: RecentProject; onOpen: (dir: string) => void }) {
  return (
    <li>
      <button
        type="button"
        data-testid="recent-project"
        disabled={!entry.exists}
        title={entry.exists ? entry.dir : `${entry.dir} (folder not found)`}
        onClick={() => onOpen(entry.dir)}
        className="flex w-full items-baseline gap-2 rounded px-2 py-1 text-left hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="shrink-0 text-sm text-fg-default">{entry.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-subtle">{entry.dir}</span>
        <span className="shrink-0 text-xs text-fg-faint">{formatOpenedAt(entry.lastOpenedAt)}</span>
      </button>
    </li>
  );
}

/**
 * The Welcome tab: what the app shows before a project is open. New/Open both go through the
 * native folder picker; Recent is read from main's `userData` list, so it survives a restart
 * (which is the whole point of it).
 */
export function WelcomeScreen({ onImportDefinition }: WelcomeScreenProps) {
  const project = useProjectStore((state) => state.project);
  const recent = useProjectStore((state) => state.recent);
  const [entries, setEntries] = useState<readonly RecentProject[]>([]);

  useEffect(() => {
    let cancelled = false;
    void recent().then((list) => {
      if (!cancelled) {
        setEntries(list);
      }
    });
    return () => {
      cancelled = true;
    };
    // Re-read whenever the open project changes: creating or opening one moves it to the top.
  }, [recent, project?.dir]);

  const openRecent = useCallback((dir: string) => {
    void projectActions.openAt(dir);
  }, []);

  return (
    <div data-testid="welcome-screen" className="flex h-full flex-col items-center overflow-auto px-6 py-10">
      <div className="w-full max-w-xl">
        <h1 className="text-lg font-medium text-fg-default">Wirebench</h1>
        <p className="mt-1 text-sm text-fg-subtle">
          A SOAP workbench. A project is a folder on disk: interfaces, requests and environments live in plain files you
          can read, diff and commit.
        </p>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button data-testid="welcome-new-project" variant="primary" onClick={() => void projectActions.newProject()}>
            <FilePlus size={14} aria-hidden="true" />
            New project…
          </Button>
          <Button data-testid="welcome-open-project" onClick={() => void projectActions.openProject()}>
            <FolderOpen size={14} aria-hidden="true" />
            Open project…
          </Button>
          <Button data-testid="welcome-import" onClick={onImportDefinition}>
            <FileDown size={14} aria-hidden="true" />
            Import WSDL
          </Button>
        </div>

        <h2 className="mt-8 text-sm font-medium text-fg-muted">Recent</h2>
        {entries.length === 0 ? (
          <p className="mt-1 text-sm text-fg-subtle">No projects yet.</p>
        ) : (
          <ul className="mt-1 flex flex-col">
            {entries.map((entry) => (
              <RecentRow key={entry.dir} entry={entry} onOpen={openRecent} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
