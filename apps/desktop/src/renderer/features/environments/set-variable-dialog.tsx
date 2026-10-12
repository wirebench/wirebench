/**
 * **Set as Variable…** (#340): turns text selected in a request or a response into a variable, in
 * the scope the user picks — the active environment, the project, the workspace or Globals — through
 * the same writes the Environments page and the project tab make.
 *
 * The caller is handed the reference to put where the selection was: `${name}` when the shorthand
 * reaches the new variable, the explicit `${#Scope#name}` when a nearer scope would shadow it.
 */
import { useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { Button } from '../../components/button.js';
import { referenceText, type RequestVariables, type VariableScope } from '../../editor/variable-assist.js';
import { useGlobalsStore } from '../../state/globals.js';
import { useProjectStore } from '../../state/project.js';
import { activeEnvironmentFor } from '../../state/environment-scope.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import { queueEnvironmentPatch } from './environment-queue.js';

/** One scope the dialog can write to. */
export interface VariableScopeOption {
  readonly scope: Exclude<VariableScope, 'System'>;
  /** What the select shows: `Environment (dev)`, `Project (Shop)`, `Workspace`, `Globals`. */
  readonly label: string;
  /** The variables already there, to warn before one is replaced. */
  readonly existing: Readonly<Record<string, string>>;
  readonly write: (name: string, value: string) => Promise<void>;
}

/**
 * The scopes a variable of `projectId`'s request can be created in, nearest first. Inside a
 * workspace the active environment is the workspace's; outside one, the project's own.
 */
export function useVariableScopeOptions(projectId: string | undefined): readonly VariableScopeOption[] {
  const workspace = useWorkspaceStore((state) => state.workspace);
  const project = useProjectStore((state) => (projectId === undefined ? undefined : state.projects[projectId]));
  const globals = useGlobalsStore((state) => state.properties);

  return useMemo(() => {
    const options: VariableScopeOption[] = [];
    // The request's own project's active environment (#468).
    const workspaceEnvironment = activeEnvironmentFor(workspace, projectId);
    const projectEnvironment =
      workspace === undefined || workspace === null
        ? project?.environments.find((environment) => environment.id === project.activeEnvironmentId)
        : undefined;
    if (workspaceEnvironment !== undefined) {
      const environmentId = workspaceEnvironment.id;
      options.push({
        scope: 'Env',
        label: `Environment (${workspaceEnvironment.name})`,
        existing: workspaceEnvironment.properties,
        write: (name, value) =>
          queueEnvironmentPatch(environmentId, (current) => ({ properties: { ...current.properties, [name]: value } })),
      });
    } else if (projectEnvironment !== undefined && projectId !== undefined) {
      const environmentId = projectEnvironment.id;
      options.push({
        scope: 'Env',
        label: `Environment (${projectEnvironment.name})`,
        existing: projectEnvironment.properties,
        write: (name, value) =>
          useProjectStore.getState().updateEnvironment(projectId, environmentId, {
            properties: { ...projectEnvironment.properties, [name]: value },
          }),
      });
    }
    if (project !== undefined && projectId !== undefined) {
      options.push({
        scope: 'Project',
        label: `Project (${project.name})`,
        existing: project.properties,
        write: (name, value) => useProjectStore.getState().setProjectProperty(projectId, name, value),
      });
    }
    if (workspace !== undefined && workspace !== null) {
      options.push({
        scope: 'Workspace',
        label: 'Workspace',
        existing: workspace.properties,
        write: async (name, value) => {
          await useWorkspaceStore.getState().mutate({ kind: 'set-workspace-property', name, value });
        },
      });
    }
    options.push({
      scope: 'Global',
      label: 'Globals',
      existing: globals,
      write: (name, value) => useGlobalsStore.getState().set(name, value),
    });
    return options;
  }, [workspace, project, projectId, globals]);
}

/** A name a reference can carry: no whitespace, and none of the characters the syntax uses. */
const NAME = /^[^\s{}#$:]+$/;

export interface SetVariableDialogProps {
  /** The selected text: the new variable's value. `undefined` keeps the dialog closed. */
  readonly selected: string | undefined;
  readonly projectId: string | undefined;
  /** The request's variables, to choose the reference's form. */
  readonly variables: RequestVariables | undefined;
  readonly onClose: () => void;
  /** Called once the variable is written, with the reference to put where the selection was. */
  readonly onCreated: (reference: string) => void;
}

export function SetVariableDialog({ selected, projectId, variables, onClose, onCreated }: SetVariableDialogProps) {
  const options = useVariableScopeOptions(projectId);
  const [name, setName] = useState('');
  const [scopeIndex, setScopeIndex] = useState(0);
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const option = options[Math.min(scopeIndex, options.length - 1)];
  const trimmed = name.trim();
  const exists = option !== undefined && Object.hasOwn(option.existing, trimmed);
  const problem =
    trimmed === ''
      ? undefined
      : !NAME.test(trimmed)
        ? 'A name cannot hold spaces or any of { } # $ :'
        : exists && !replace
          ? `${option.label} already has "${trimmed}".`
          : undefined;
  const ready = option !== undefined && trimmed !== '' && problem === undefined && !busy;

  const close = (): void => {
    setName('');
    setReplace(false);
    setBusy(false);
    onClose();
  };

  const create = async (): Promise<void> => {
    if (!ready || selected === undefined) return;
    setBusy(true);
    await option.write(trimmed, selected);
    // The new variable sits in its own scope; whether the shorthand reaches it depends on the nearer ones.
    onCreated(referenceText(trimmed, option.scope, variables ?? { entries: [], secretNames: [] }));
    close();
  };

  return (
    <Dialog.Root
      open={selected !== undefined}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 flex w-[28rem] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-md font-medium text-fg-default">Set as Variable</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="text-fg-subtle hover:text-fg-default">
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <label className="flex flex-col gap-1 text-sm text-fg-subtle">
              Name
              <input
                autoFocus
                aria-label="Variable name"
                spellCheck={false}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                }}
                className="h-row rounded-md border border-hairline bg-surface-base px-2 font-mono text-sm text-fg-default focus:ring-1 focus:ring-accent focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-fg-subtle">
              Scope
              <select
                aria-label="Variable scope"
                value={scopeIndex}
                onChange={(event) => {
                  setScopeIndex(Number(event.target.value));
                }}
                className="h-row rounded-md border border-hairline bg-surface-base px-2 text-sm text-fg-default"
              >
                {options.map((candidate, index) => (
                  <option key={candidate.scope} value={index}>
                    {candidate.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex flex-col gap-1 text-sm text-fg-subtle">
              Value
              <pre
                data-testid="set-variable-value"
                className="max-h-32 overflow-auto rounded-md border border-hairline bg-surface-sunken px-2 py-1 font-mono text-sm break-all whitespace-pre-wrap text-fg-default"
              >
                {selected}
              </pre>
            </div>
            {exists && (
              <label className="flex items-center gap-2 text-sm text-fg-default">
                <input
                  type="checkbox"
                  checked={replace}
                  onChange={(event) => {
                    setReplace(event.target.checked);
                  }}
                />
                Replace the existing value
              </label>
            )}
            {problem !== undefined && (
              <p role="alert" className="text-sm text-status-danger">
                {problem}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button>Cancel</Button>
              </Dialog.Close>
              <Button type="submit" variant="primary" disabled={!ready}>
                Create
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
