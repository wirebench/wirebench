import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { create } from 'zustand';
import { Button } from '../../components/button.js';
import { showToast } from '../../components/toast.js';
import type { ProjectApiMovePlan } from '../../../shared/wire-types.js';
import { useProjectStore } from '../../state/project.js';
import { useWorkspaceStore } from '../../state/workspace.js';

/** Which API **Move to project…** is moving, and where a drag aimed it; `apiId` undefined while shut. */
export const useMoveApiStore = create<{
  readonly apiId: string | undefined;
  readonly targetProjectId: string | undefined;
  readonly beforeApiId: string | undefined;
  readonly open: (apiId: string, targetProjectId?: string, beforeApiId?: string) => void;
  readonly close: () => void;
}>((set) => ({
  apiId: undefined,
  targetProjectId: undefined,
  beforeApiId: undefined,
  open: (apiId, targetProjectId, beforeApiId) => set({ apiId, targetProjectId, beforeApiId }),
  close: () => set({ apiId: undefined, targetProjectId: undefined, beforeApiId: undefined }),
}));

/** Whether a plan has anything to tell before the move: something copied, or something left behind. */
export function planHasNotes(plan: ProjectApiMovePlan): boolean {
  return (
    plan.copiedVariables.length +
      plan.copiedSecrets.length +
      plan.unresolvedVariables.length +
      plan.unresolvedSecrets.length +
      plan.keystores.length +
      plan.sequences.length >
    0
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not move it';
}

/**
 * Moves the API and offers Undo, which moves it back to where it stood. A failure leaves both
 * projects as they were (main puts them back) and says why.
 */
export async function runApiMove(apiId: string, targetProjectId: string, beforeApiId?: string): Promise<void> {
  const store = useProjectStore.getState();
  const targetName = store.projects[targetProjectId]?.name ?? 'the other project';
  try {
    const from = await store.moveApiToProject(apiId, targetProjectId, beforeApiId);
    showToast(`Moved to “${targetName}”`, {
      label: 'Undo',
      onClick: () => {
        void useProjectStore
          .getState()
          .moveApiToProject(apiId, from.projectId, from.beforeApiId)
          .catch((error: unknown) => showToast(errorMessage(error)));
      },
    });
  } catch (error) {
    showToast(errorMessage(error));
  }
}

/**
 * A drop of an API row on another project: straight through when there is nothing to tell, else the
 * dialog opens on that project so the user sees what is copied and what stays behind first.
 */
export async function dropApiOnProject(apiId: string, targetProjectId: string, beforeApiId?: string): Promise<void> {
  let plan: ProjectApiMovePlan;
  try {
    plan = await useProjectStore.getState().planApiMove(apiId, targetProjectId);
  } catch (error) {
    showToast(errorMessage(error));
    return;
  }
  if (planHasNotes(plan)) {
    useMoveApiStore.getState().open(apiId, targetProjectId, beforeApiId);
    return;
  }
  await runApiMove(apiId, targetProjectId, beforeApiId);
}

function NoteList({
  title,
  items,
  testId,
}: {
  readonly title: string;
  readonly items: readonly string[];
  readonly testId: string;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mt-3" data-testid={testId}>
      <div className="text-xs text-fg-subtle">{title}</div>
      <ul className="mt-0.5 list-disc pl-5 text-sm text-fg-default">
        {items.map((item) => (
          <li key={item} className="truncate">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * **Move to project…** on an API row of any kind (#701): picks another project of the workspace
 * (a linked one too; one whose folder is missing cannot take it) and lists, before anything moves,
 * the project-level things the API uses that the target lacks — what is copied over and what is
 * left behind. The same move a drag onto the project's row makes.
 */
export function MoveApiDialog() {
  const apiId = useMoveApiStore((state) => state.apiId);
  const presetTarget = useMoveApiStore((state) => state.targetProjectId);
  const beforeApiId = useMoveApiStore((state) => state.beforeApiId);
  const close = useMoveApiStore((state) => state.close);
  const ownProjectId = useProjectStore((state) => (apiId === undefined ? undefined : state.projectOf[apiId]));
  const projects = useProjectStore((state) => state.projects);
  const entries = useWorkspaceStore((state) => state.workspace?.projects);
  const targets = (entries ?? []).filter((entry) => entry.id !== ownProjectId && entry.status === 'ready');

  const [targetId, setTargetId] = useState<string | undefined>(undefined);
  const [plan, setPlan] = useState<ProjectApiMovePlan | undefined>(undefined);
  const [planError, setPlanError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (apiId !== undefined) setTargetId(presetTarget ?? targets[0]?.id);
  }, [apiId, presetTarget]);

  useEffect(() => {
    setPlan(undefined);
    setPlanError(undefined);
    if (apiId === undefined || targetId === undefined) return;
    let current = true;
    useProjectStore
      .getState()
      .planApiMove(apiId, targetId)
      .then(
        (next) => {
          if (current) setPlan(next);
        },
        (error: unknown) => {
          if (current) setPlanError(errorMessage(error));
        },
      );
    return () => {
      current = false;
    };
  }, [apiId, targetId]);

  const move = (): void => {
    if (apiId === undefined || targetId === undefined) return;
    // A drop's place only holds for the project it was dropped on.
    const before = targetId === presetTarget ? beforeApiId : undefined;
    close();
    void runApiMove(apiId, targetId, before);
  };

  const label = plan === undefined ? 'the API' : `“${plan.apiName}”`;

  return (
    <Dialog.Root
      open={apiId !== undefined}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="move-api-dialog"
          className="fixed top-1/2 left-1/2 max-h-[80vh] w-[28rem] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <Dialog.Title className="text-md font-medium text-fg-default">Move {label} to project</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-fg-subtle">
            Its folders, requests, scripts and mocks move with it and keep their ids, so open tabs and History still
            find them. Both projects are saved.
          </Dialog.Description>

          <label className="mt-3 block text-sm text-fg-subtle" htmlFor="move-api-target">
            Target project
          </label>
          {targets.length === 0 ? (
            <p className="mt-1 text-sm text-fg-subtle">No other open project to move it to.</p>
          ) : (
            <select
              id="move-api-target"
              data-testid="move-api-target"
              value={targetId}
              onChange={(event) => setTargetId(event.target.value)}
              className="mt-1 w-full rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent"
            >
              {targets.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {`${projects[entry.id]?.name ?? entry.name}${entry.source === 'linked' ? ' (linked)' : ''}`}
                </option>
              ))}
            </select>
          )}

          {planError !== undefined && <p className="mt-3 text-sm text-status-danger">{planError}</p>}
          {plan !== undefined && (
            <div data-testid="move-api-plan">
              <NoteList
                title="Project variables copied to the target"
                items={plan.copiedVariables.map((name) => `\${${name}}`)}
                testId="move-api-copied-variables"
              />
              <NoteList
                title="Secrets copied to the target (this machine's values)"
                items={plan.copiedSecrets.map((name) => `\${secret:${name}}`)}
                testId="move-api-copied-secrets"
              />
              <NoteList
                title="Set only in this project's environments; not copied"
                items={plan.unresolvedVariables.map((name) => `\${${name}}`)}
                testId="move-api-unresolved-variables"
              />
              <NoteList
                title="Secrets with no value on this machine; not copied"
                items={plan.unresolvedSecrets.map((name) => `\${secret:${name}}`)}
                testId="move-api-unresolved-secrets"
              />
              <NoteList
                title="Keystores stay in this project; pick one in the target after the move"
                items={plan.keystores}
                testId="move-api-keystores"
              />
              <NoteList
                title="Sequences here that run its requests will no longer find them"
                items={plan.sequences}
                testId="move-api-sequences"
              />
            </div>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button>Cancel</Button>
            </Dialog.Close>
            <Button
              data-testid="move-api-submit"
              variant="primary"
              disabled={targetId === undefined || plan === undefined}
              onClick={move}
            >
              Move
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
