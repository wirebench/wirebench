/**
 * "Get Data…" — the Form view's property picker. Lists every property in scope
 * (project, active environment, global) and inserts the matching `${#…#name}`
 * expansion into the field it was opened from, rather than making the user
 * remember the syntax.
 *
 * It only ever produces a reference: values are resolved at send time by the
 * engine's property expansion (Task 19), so a secret is never copied into the
 * envelope here.
 */

import { useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { Button } from '../../../components/button.js';
import { useGlobalsStore } from '../../../state/globals.js';
import { useProjectStore } from '../../../state/project.js';
import { useWorkspaceStore } from '../../../state/workspace.js';

/** Where a property comes from, which decides the scope token in its reference. */
type Scope = 'Env' | 'Project' | 'Workspace' | 'Global';

interface Entry {
  readonly scope: Scope;
  readonly name: string;
  readonly value: string;
  /** The expansion to insert, e.g. `${#Project#endpoint}`. */
  readonly reference: string;
}

export interface GetDataDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Called with the chosen `${#…#name}` reference. */
  readonly onInsert: (reference: string) => void;
  /** The field the dialog was opened from, named in the title so the user knows where it lands. */
  readonly fieldLabel: string;
  /** Whose project's properties are in scope; the interface the form's request belongs to. */
  readonly interfaceId: string;
}

/**
 * The flat, scope-ordered list of everything this request can expand: its own project's
 * properties, the workspace's active environment, the workspace itself, and the user's globals
 * — the engine's `Env -> Project -> Workspace -> Global` chain, in that order.
 */
function useEntries(interfaceId: string): readonly Entry[] {
  const projectProperties = useProjectStore((state) => {
    const projectId = state.projectOf[interfaceId];
    return projectId === undefined ? undefined : state.projects[projectId]?.properties;
  });
  const workspace = useWorkspaceStore((state) => state.workspace);
  const globalProperties = useGlobalsStore((state) => state.properties);

  return useMemo(() => {
    const active = workspace?.environments.find((environment) => environment.id === workspace.activeEnvironmentId);
    const out: Entry[] = [];
    for (const [name, value] of Object.entries(active?.properties ?? {})) {
      out.push({ scope: 'Env', name, value, reference: `\${#Env#${name}}` });
    }
    for (const [name, value] of Object.entries(projectProperties ?? {})) {
      out.push({ scope: 'Project', name, value, reference: `\${#Project#${name}}` });
    }
    for (const [name, value] of Object.entries(workspace?.properties ?? {})) {
      out.push({ scope: 'Workspace', name, value, reference: `\${#Workspace#${name}}` });
    }
    for (const [name, value] of Object.entries(globalProperties)) {
      out.push({ scope: 'Global', name, value, reference: `\${#Global#${name}}` });
    }
    return out;
  }, [projectProperties, workspace, globalProperties]);
}

/** Lists the properties in scope and inserts the chosen one's `${#…}` reference. */
export function GetDataDialog({ open, onOpenChange, onInsert, fieldLabel, interfaceId }: GetDataDialogProps) {
  const entries = useEntries(interfaceId);
  const [filter, setFilter] = useState('');
  const needle = filter.trim().toLowerCase();
  const visible = needle === '' ? entries : entries.filter((entry) => entry.name.toLowerCase().includes(needle));

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 flex max-h-[32rem] w-[28rem] -translate-x-1/2 -translate-y-1/2 flex-col rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-md font-medium text-fg-default">Get Data — {fieldLabel}</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="text-fg-subtle hover:text-fg-default">
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          <input
            type="search"
            aria-label="Filter properties"
            placeholder="Filter…"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            className="mt-3 rounded-sm border border-hairline bg-surface-base px-2 py-1 text-sm text-fg-default"
          />

          {visible.length === 0 ? (
            <p className="mt-4 text-sm text-fg-subtle">
              No properties in scope. Add them in the Details panel, then reopen this dialog.
            </p>
          ) : (
            <ul className="mt-3 min-h-0 flex-1 overflow-auto" aria-label="Properties in scope">
              {visible.map((entry) => (
                <li key={`${entry.scope}:${entry.name}`}>
                  <button
                    type="button"
                    className="flex w-full items-baseline gap-2 rounded-sm px-1 py-1 text-left text-sm hover:bg-surface-hover"
                    onClick={() => {
                      onInsert(entry.reference);
                      onOpenChange(false);
                    }}
                  >
                    <span className="w-14 shrink-0 text-xs text-fg-faint">{entry.scope}</span>
                    <span className="min-w-0 flex-1 truncate text-fg-default">{entry.name}</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-fg-subtle">{entry.value}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-3 flex justify-end">
            <Dialog.Close asChild>
              <Button>Cancel</Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
