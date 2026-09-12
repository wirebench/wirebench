import { useEffect, useRef, useState } from 'react';
import { EndpointsTable } from './endpoints-table.js';
import type { EnvironmentTarget } from './environment-actions.js';
import { queueEnvironmentPatch } from './environment-queue.js';
import { VariablesTable, type InheritedScope, type VariablesTableTarget } from './variables-table.js';
import { useGlobalsStore } from '../../state/globals.js';
import { selectEnvironment, useProjectStore } from '../../state/project.js';
import { useWorkspaceStore } from '../../state/workspace.js';

// Shared box model between the resting and editing states — same height, padding, border width,
// font — so nothing shifts by a pixel when the input mounts. Only the border's and background's
// colour differ between the two, matching the variables/endpoints tables' "chrome on demand".
const NAME_FIELD_BASE =
  'h-row max-w-md min-w-0 rounded-md border px-2 text-left text-lg font-medium text-fg-default focus:outline-none focus:ring-1 focus:ring-accent';
const NAME_VIEW_CLASS = `${NAME_FIELD_BASE} cursor-text border-transparent bg-transparent hover:bg-surface-raised`;
const NAME_INPUT_CLASS = `${NAME_FIELD_BASE} border-hairline-strong bg-surface-raised`;

/** A renameable environment's name: a plain heading until clicked (or Enter/F2 while focused),
 * then an input with the current name selected, so typing replaces it. Enter or blur commits the
 * trimmed name; Escape reverts and drops back to the resting state. An empty or whitespace-only
 * name reverts without saving. */
function EditableName({ name, onCommit }: { readonly name: string; readonly onCommit: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(name);
  }, [name]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.select();
    }
  }, [editing]);

  function startEditing() {
    setDraft(name);
    setEditing(true);
  }

  function commit() {
    const trimmed = draft.trim();
    if (trimmed.length > 0 && trimmed !== name) {
      onCommit(trimmed);
    }
    setDraft(name);
    setEditing(false);
  }

  function revert() {
    setDraft(name);
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        autoFocus
        aria-label="Environment name"
        data-testid="environment-name"
        className={NAME_INPUT_CLASS}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur();
          }
          if (event.key === 'Escape') {
            revert();
          }
        }}
      />
    );
  }

  return (
    <button
      type="button"
      data-testid="environment-name"
      className={NAME_VIEW_CLASS}
      onClick={startEditing}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === 'F2') {
          event.preventDefault();
          startEditing();
        }
      }}
    >
      {name}
    </button>
  );
}

/** The page's header: a name (editable for a real environment, fixed for Globals/Workspace),
 * an Active toggle (environments only), and a one-line reminder of where this scope sits in the
 * precedence order. */
function PageHeader({
  name,
  owningProjectName,
  editableName,
  active,
  hint,
}: {
  readonly name: string;
  /** For a linked project's own environment: the project that owns it, so two environments named
   * the same in different projects stay distinguishable. Absent for Globals, Workspace, and
   * workspace environments (which have no single owning project). */
  readonly owningProjectName?: string;
  readonly editableName?: { readonly onCommit: (name: string) => void };
  readonly active?: { readonly value: boolean; readonly onToggle: () => void };
  readonly hint: string;
}) {
  return (
    <header className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        {editableName !== undefined ? (
          <EditableName name={name} onCommit={editableName.onCommit} />
        ) : (
          <h2 className="text-lg font-medium text-fg-default">{name}</h2>
        )}
        {owningProjectName !== undefined && (
          <span data-testid="environment-owning-project" className="text-sm text-fg-subtle">
            {owningProjectName} — linked project
          </span>
        )}
        {active !== undefined && (
          <label className="flex items-center gap-1.5 text-sm text-fg-subtle">
            <input
              type="checkbox"
              aria-label={active.value ? `Deactivate ${name}` : `Activate ${name}`}
              data-testid="environment-active"
              checked={active.value}
              onChange={active.onToggle}
            />
            Active
          </label>
        )}
      </div>
      <p className="text-xs text-fg-subtle">{hint}</p>
    </header>
  );
}

function GlobalsPage() {
  const properties = useGlobalsStore((state) => state.properties);
  const disabled = useGlobalsStore((state) => state.disabled);
  const set = useGlobalsStore((state) => state.set);
  const remove = useGlobalsStore((state) => state.remove);
  const setEnabled = useGlobalsStore((state) => state.setEnabled);

  const target: VariablesTableTarget = {
    label: 'Globals variables',
    scopeLabel: 'Globals',
    properties,
    disabled,
    onSet: (name, value) => {
      void set(name, value);
    },
    onRemove: (name) => {
      void remove(name);
    },
    onSetEnabled: (name, enabled) => {
      void setEnabled(name, enabled);
    },
  };

  return (
    <section
      data-testid="environment-page"
      aria-label="Globals"
      className="flex h-full min-h-0 flex-col gap-4 overflow-auto p-4"
    >
      <PageHeader
        name="Globals"
        hint={`Available to every workspace and project, as ${'${#Global#name}'}; a workspace or environment value of the same name wins.`}
      />
      <VariablesTable target={target} />
    </section>
  );
}

function WorkspacePage() {
  const properties = useWorkspaceStore((state) => state.workspace?.properties ?? {});
  const disabled = useWorkspaceStore((state) => state.workspace?.disabled ?? []);
  const mutate = useWorkspaceStore((state) => state.mutate);
  const setWorkspacePropertyEnabled = useWorkspaceStore((state) => state.setWorkspacePropertyEnabled);
  const globalsProperties = useGlobalsStore((state) => state.properties);
  const globalsDisabled = useGlobalsStore((state) => state.disabled);

  const target: VariablesTableTarget = {
    label: 'Workspace variables',
    scopeLabel: 'Workspace',
    inherited: [{ label: 'Globals', properties: globalsProperties, disabled: globalsDisabled }],
    properties,
    disabled,
    onSet: (name, value) => {
      void mutate({ kind: 'set-workspace-property', name, value });
    },
    onRemove: (name) => {
      void mutate({ kind: 'remove-workspace-property', name });
    },
    onSetEnabled: (name, enabled) => {
      void setWorkspacePropertyEnabled(name, enabled);
    },
  };

  return (
    <section
      data-testid="environment-page"
      aria-label="Workspace"
      className="flex h-full min-h-0 flex-col gap-4 overflow-auto p-4"
    >
      <PageHeader
        name="Workspace"
        hint={`Available to every project in the workspace, as ${'${#Workspace#name}'}; an active environment's value of the same name wins.`}
      />
      <VariablesTable target={target} />
    </section>
  );
}

/** A real environment's page: a workspace environment, or a linked project's own. */
function EnvironmentScopePage({ environmentId }: { readonly environmentId: string }) {
  const workspace = useWorkspaceStore((state) => state.workspace);
  const workspaceEnvironment = workspace?.environments.find((candidate) => candidate.id === environmentId);
  const projectEnvironment = useProjectStore((state) => selectEnvironment(state, environmentId));
  const projectId = useProjectStore((state) => state.projectOf[environmentId]);
  const projectActiveId = useProjectStore((state) =>
    projectId === undefined ? undefined : state.projects[projectId]?.activeEnvironmentId,
  );
  const projectProperties = useProjectStore((state) =>
    projectId === undefined ? undefined : state.projects[projectId]?.properties,
  );
  const projectDisabled = useProjectStore((state) =>
    projectId === undefined ? undefined : state.projects[projectId]?.disabledProperties,
  );
  const setWorkspaceActive = useWorkspaceStore((state) => state.setActiveEnvironment);
  const setProjectActive = useProjectStore((state) => state.setActiveEnvironment);
  const globalsProperties = useGlobalsStore((state) => state.properties);
  const globalsDisabled = useGlobalsStore((state) => state.disabled);

  const environment = workspaceEnvironment ?? projectEnvironment;
  if (environment === undefined) {
    return <p className="p-4 text-sm text-fg-subtle">This environment no longer exists.</p>;
  }

  const isWorkspaceScoped = workspaceEnvironment !== undefined;
  const active = isWorkspaceScoped
    ? workspace?.activeEnvironmentId === environmentId
    : projectActiveId === environmentId;

  const owningProjectName = workspace?.projects.find((candidate) => candidate.id === projectId)?.name;

  // The engine resolves Env -> Project -> Workspace -> Global, so the chain below an environment
  // starts at the project. A linked project's own environment has exactly one project below it —
  // the project that owns it — so that scope goes in by name. A *workspace* environment is shared
  // across every project in the workspace and sits above whichever one happens to be open: there
  // is no single project scope to name, so the layer is left out rather than invented, and the
  // chain drops straight to the workspace. (`ProjectTab` states the project layer for itself.)
  const inherited: readonly InheritedScope[] = [
    ...(isWorkspaceScoped
      ? []
      : [
          {
            label: owningProjectName ?? 'This project',
            properties: projectProperties ?? {},
            disabled: projectDisabled ?? [],
          },
        ]),
    { label: 'Workspace', properties: workspace?.properties ?? {}, disabled: workspace?.disabled ?? [] },
    { label: 'Globals', properties: globalsProperties, disabled: globalsDisabled },
  ];

  const target: VariablesTableTarget = isWorkspaceScoped
    ? {
        label: `Variables of ${environment.name}`,
        scopeLabel: 'This environment',
        inherited,
        properties: environment.properties,
        disabled: environment.disabled,
        onSet: (name, value) => {
          void queueEnvironmentPatch(environmentId, (current) => ({
            properties: { ...current.properties, [name]: value },
          }));
        },
        onRemove: (name) => {
          void queueEnvironmentPatch(environmentId, (current) => {
            const next = { ...current.properties };
            delete next[name];
            return { properties: next };
          });
        },
        onRename: (from, to) => {
          void queueEnvironmentPatch(environmentId, (current) => {
            const next: Record<string, string> = {};
            for (const [key, value] of Object.entries(current.properties)) {
              next[key === from ? to : key] = value;
            }
            // `disabled` is keyed by name and pruned of names with no matching property on
            // save, so the renamed entry has to move with it or the variable silently
            // re-enables itself.
            const renamedDisabled = current.disabled.map((name) => (name === from ? to : name));
            return { properties: next, disabled: renamedDisabled };
          });
        },
        onSetEnabled: (name, enabled) => {
          void queueEnvironmentPatch(environmentId, (current) => {
            const disabledSet = new Set(current.disabled);
            if (enabled) {
              disabledSet.delete(name);
            } else {
              disabledSet.add(name);
            }
            return { disabled: [...disabledSet] };
          });
        },
      }
    : {
        label: `Variables of ${environment.name}`,
        scopeLabel: 'This environment',
        inherited,
        properties: environment.properties,
        // A linked project's own environment publishes `disabled` read-only on the wire — there
        // is deliberately no mutation for it (see `update-environment`'s patch shape), so
        // `onSetEnabled` stays undefined and the table shows the state without letting it change.
        disabled: environment.disabled,
        onSet: (name, value) => {
          if (projectId === undefined) {
            return;
          }
          void useProjectStore.getState().updateEnvironment(projectId, environmentId, {
            properties: { ...environment.properties, [name]: value },
          });
        },
        onRemove: (name) => {
          if (projectId === undefined) {
            return;
          }
          const next = { ...environment.properties };
          delete next[name];
          void useProjectStore.getState().updateEnvironment(projectId, environmentId, { properties: next });
        },
        onRename: (from, to) => {
          if (projectId === undefined) {
            return;
          }
          const next: Record<string, string> = {};
          for (const [key, value] of Object.entries(environment.properties)) {
            next[key === from ? to : key] = value;
          }
          void useProjectStore.getState().updateEnvironment(projectId, environmentId, { properties: next });
        },
      };

  return (
    <section
      data-testid="environment-page"
      aria-label={`Environment ${environment.name}`}
      className="flex h-full min-h-0 flex-col gap-4 overflow-auto p-4"
    >
      <PageHeader
        name={environment.name}
        {...(isWorkspaceScoped
          ? {}
          : { owningProjectName: owningProjectName ?? 'this project' })}
        editableName={{
          onCommit: (name) => {
            if (isWorkspaceScoped) {
              void queueEnvironmentPatch(environmentId, () => ({ name }));
            } else if (projectId !== undefined) {
              void useProjectStore.getState().updateEnvironment(projectId, environmentId, { name });
            }
          },
        }}
        active={{
          value: active,
          onToggle: () => {
            if (isWorkspaceScoped) {
              void setWorkspaceActive(active ? null : environmentId);
            } else if (projectId !== undefined) {
              void setProjectActive(projectId, active ? null : environmentId);
            }
          },
        }}
        hint={
          isWorkspaceScoped
            ? "A workspace environment, shared across every project — beaten by a linked project's own environment of the same name, when one is active."
            : "This project's own environment — its endpoint overrides and variables win over the workspace's, when both name the same interface."
        }
      />
      {/* Spec §2.2's order: the variables table first, the endpoints group below it. */}
      <div className="flex flex-col gap-1.5">
        <h3 className="text-xs font-medium tracking-wider text-fg-subtle uppercase">Variables</h3>
        <VariablesTable target={target} />
      </div>
      <div className="flex flex-col gap-1.5">
        <h3 className="text-xs font-medium tracking-wider text-fg-subtle uppercase">Endpoints</h3>
        <EndpointsTable environmentId={environmentId} />
      </div>
    </section>
  );
}

export interface EnvironmentPageProps {
  readonly target: EnvironmentTarget;
}

/**
 * The environment editor page: opened from the Environments view's Globals row, Workspace row,
 * or any environment row. Replaces `environment-grid.tsx` (the workspace's all-environments
 * grid) and `environment-editor.tsx` (a project's own single-environment editor) with one page
 * per scope, keyed by {@link EnvironmentTarget}.
 */
export function EnvironmentPage({ target }: EnvironmentPageProps) {
  if (target.kind === 'globals') {
    return <GlobalsPage />;
  }
  if (target.kind === 'workspace') {
    return <WorkspacePage />;
  }
  return <EnvironmentScopePage environmentId={target.id} />;
}
