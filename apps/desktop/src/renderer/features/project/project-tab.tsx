import {
  BooleanSetting,
  NumberSetting,
  ReadOnlySetting,
  SettingsGroup,
  TextSetting,
} from '../../components/settings-grid.js';
import { useGlobalsStore } from '../../state/globals.js';
import { useProjectStore } from '../../state/project.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import { workspaceActions } from '../workspace/workspace-actions.js';
import { SaveIndicator } from './save-indicator.js';
import { VariablesTable, type InheritedScope, type VariablesTableTarget } from '../environments/variables-table.js';
import type { ProjectSettingsPatchWire } from '../../../shared/wire-types.js';

export interface ProjectTabProps {
  readonly projectId: string;
}

/**
 * What used to be the Details panel's view of a project: its name, folder (with a *Reveal*
 * button), where it came from (an internal project of the workspace, or a linked folder), the
 * project-wide `ProjectSettings`, and its own properties table (the `VariablesTable` from T6,
 * reused rather than forked — the same *Enabled* column, wired to the project's own channels).
 */
export function ProjectTab({ projectId }: ProjectTabProps) {
  const project = useProjectStore((state) => state.projects[projectId]);
  const source = useWorkspaceStore(
    (state) => state.workspace?.projects.find((candidate) => candidate.id === projectId)?.source,
  );
  const updateProjectSettings = useProjectStore((state) => state.updateProjectSettings);
  const setProjectProperty = useProjectStore((state) => state.setProjectProperty);
  const removeProjectProperty = useProjectStore((state) => state.removeProjectProperty);
  const setProjectPropertyEnabled = useProjectStore((state) => state.setProjectPropertyEnabled);
  const workspaceProperties = useWorkspaceStore((state) => state.workspace?.properties ?? {});
  const workspaceDisabled = useWorkspaceStore((state) => state.workspace?.disabled ?? []);
  const globalsProperties = useGlobalsStore((state) => state.properties);
  const globalsDisabled = useGlobalsStore((state) => state.disabled);

  if (project === undefined) {
    return <p className="p-4 text-sm text-fg-subtle">This project is no longer in the workspace.</p>;
  }

  const patch = (next: ProjectSettingsPatchWire): void => {
    void updateProjectSettings(projectId, next);
  };

  const inherited: readonly InheritedScope[] = [
    { label: 'Workspace', properties: workspaceProperties, disabled: workspaceDisabled },
    { label: 'Globals', properties: globalsProperties, disabled: globalsDisabled },
  ];

  const propertiesTarget: VariablesTableTarget = {
    label: 'Project properties',
    scopeLabel: 'This project',
    inherited,
    properties: project.properties,
    disabled: project.disabledProperties,
    onSet: (name, value) => {
      void setProjectProperty(projectId, name, value);
    },
    onRemove: (name) => {
      void removeProjectProperty(projectId, name);
    },
    onSetEnabled: (name, enabled) => {
      void setProjectPropertyEnabled(projectId, name, enabled);
    },
  };

  return (
    <section
      data-testid="project-tab"
      aria-label={`Project ${project.name}`}
      className="flex h-full min-h-0 flex-col gap-4 overflow-auto p-4"
    >
      {/* Above the first field rather than beside one: every group below writes through the same
          autosave, so one indicator speaks for the whole tab. */}
      <div className="flex items-center justify-between gap-3">
        <h2 className="truncate text-md font-medium text-fg-default">{project.name}</h2>
        <SaveIndicator projectId={projectId} />
      </div>

      <SettingsGroup title="Project">
        <ReadOnlySetting label="Name" value={project.name} />
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <TextSetting label="Folder" value={project.dir} readOnly monospace onCommit={() => undefined} />
          </div>
          <button
            type="button"
            className="mb-0.5 h-row shrink-0 rounded-md border border-hairline-strong bg-surface-raised px-2 text-sm text-fg-default hover:bg-surface-hover"
            onClick={() => {
              void workspaceActions.revealProject(projectId);
            }}
          >
            Reveal
          </button>
        </div>
        <ReadOnlySetting label="Source" value={source === 'linked' ? 'Linked' : 'Internal'} />
      </SettingsGroup>

      <SettingsGroup title="Settings">
        <BooleanSetting
          label="Cache definitions"
          value={project.settings.cacheDefinitions}
          onChange={(cacheDefinitions) => patch({ cacheDefinitions })}
        />
        <NumberSetting
          label="Default timeout (ms)"
          value={project.settings.defaultTimeoutMs}
          min={0}
          onCommit={(defaultTimeoutMs) => {
            if (defaultTimeoutMs !== undefined) {
              patch({ defaultTimeoutMs });
            }
          }}
        />
        <TextSetting
          label="Resource root"
          value={project.settings.resourceRoot ?? ''}
          placeholder="the project folder"
          onCommit={(resourceRoot) => patch({ resourceRoot: resourceRoot.length > 0 ? resourceRoot : null })}
        />
        <BooleanSetting
          label="Pretty print responses"
          value={project.settings.prettyPrintResponses}
          onChange={(prettyPrintResponses) => patch({ prettyPrintResponses })}
        />
      </SettingsGroup>

      <div className="flex flex-col gap-1">
        <h3 className="text-xs font-medium tracking-wider text-fg-subtle uppercase">Properties</h3>
        <div data-testid="project-properties-table">
          <VariablesTable target={propertiesTarget} />
        </div>
      </div>
    </section>
  );
}
