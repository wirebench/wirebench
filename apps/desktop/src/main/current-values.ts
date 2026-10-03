/**
 * Current values (cookie jar and current values spec §5): a session-only override per variable, in
 * memory per workspace. They never reach disk, sync or the server, and are gone on quit.
 *
 * A current value exists only for a variable with a committed value in its scope. Main learns the
 * committed values from the snapshots it already broadcasts (the workspace, each project, the
 * globals) and keeps the overrides in step with them:
 * - a deleted variable drops its value;
 * - a renamed one keeps it. A rename shows as one name going and another arriving with the same
 *   committed value, in one change or in two changes in a row (a remove, then a set).
 * A disabled variable keeps its value, which does not apply: resolution drops disabled names first.
 */
import { WirebenchError } from '@wirebench/engine';
import type { CurrentValues, PropertyMap } from '@wirebench/engine';
import { scopeKeyString } from '../shared/current-value-keys.js';
import type {
  CurrentValuesStateWire,
  GlobalsState,
  ProjectWire,
  ScopeKeyWire,
  WorkspaceWire,
} from '../shared/wire-types.js';

interface Held {
  readonly committed: string;
  readonly value: string;
}

interface ScopeEntry {
  readonly key: ScopeKeyWire;
  /** The committed values as last seen: the names a current value may exist for. */
  committed: Readonly<Record<string, string>>;
  readonly values: Map<string, string>;
  /** Values of the names the last change removed, kept for one more change in case it was a rename. */
  parked: Map<string, Held>;
}

/** The map used while no workspace is open: the globals' values. */
const NO_WORKSPACE = '';

export class CurrentValuesStore {
  private readonly workspaces = new Map<string, Map<string, ScopeEntry>>();
  private currentId = NO_WORKSPACE;
  private globals: Readonly<Record<string, string>> = {};
  /** The last snapshot of each open project, replayed into a workspace map when the workspace switches. */
  private readonly projects = new Map<string, ProjectWire>();

  constructor(private readonly onChanged: (state: CurrentValuesStateWire) => void = () => undefined) {}

  /** The open workspace changed (or none is open): its own and its environments' scopes follow it. */
  syncWorkspace(workspace: WorkspaceWire | null): void {
    const id = workspace?.id ?? NO_WORKSPACE;
    const switched = id !== this.currentId;
    this.currentId = id;
    let changed = this.reconcile({ scope: 'global' }, this.globals);
    if (switched) {
      // Projects announce themselves before their workspace does (and while none is current), so
      // the map this workspace now reads has not seen their snapshots yet.
      for (const [projectId, project] of this.projects) {
        changed = this.reconcileProject(projectId, project) || changed;
      }
    }
    if (workspace !== null) {
      changed = this.reconcile({ scope: 'workspace' }, workspace.properties) || changed;
      const live = new Set<string>();
      for (const environment of workspace.environments) {
        const key: ScopeKeyWire = { scope: 'workspaceEnvironment', environmentId: environment.id };
        live.add(scopeKeyString(key));
        changed = this.reconcile(key, environment.properties) || changed;
      }
      changed =
        this.dropWhere((key) => key.scope === 'workspaceEnvironment' && !live.has(scopeKeyString(key))) || changed;
    }
    if (switched || changed) {
      this.announce();
    }
  }

  /** One project's model changed. `null` (its host closed) keeps its values for when it opens again. */
  syncProject(projectId: string, project: ProjectWire | null): void {
    if (project === null) {
      this.projects.delete(projectId);
      return;
    }
    this.projects.set(projectId, project);
    if (this.reconcileProject(projectId, project)) {
      this.announce();
    }
  }

  private reconcileProject(projectId: string, project: ProjectWire): boolean {
    let changed = this.reconcile({ scope: 'project', projectId }, project.properties);
    const live = new Set<string>();
    for (const environment of project.environments) {
      const key: ScopeKeyWire = { scope: 'projectEnvironment', projectId, environmentId: environment.id };
      live.add(scopeKeyString(key));
      changed = this.reconcile(key, environment.properties) || changed;
    }
    changed =
      this.dropWhere(
        (key) => key.scope === 'projectEnvironment' && key.projectId === projectId && !live.has(scopeKeyString(key)),
      ) || changed;
    return changed;
  }

  /** The globals changed; every workspace's global scope reads them. */
  syncGlobals(state: GlobalsState): void {
    this.globals = { ...state.properties };
    if (this.reconcile({ scope: 'global' }, this.globals)) {
      this.announce();
    }
  }

  /** A deleted workspace's values go with it. */
  forgetWorkspace(workspaceId: string): void {
    this.workspaces.delete(workspaceId);
    if (workspaceId === this.currentId) {
      // Announcing reads the current map, which would otherwise be created empty for the dead id.
      this.currentId = NO_WORKSPACE;
      this.announce();
    }
  }

  state(): CurrentValuesStateWire {
    return {
      scopes: [...this.scopes().values()]
        .filter((entry) => entry.values.size > 0)
        .map((entry) => ({ key: entry.key, values: Object.fromEntries(entry.values) })),
    };
  }

  /**
   * Sets `name`'s current value in `key`'s scope. The committed value itself removes the override.
   *
   * @throws WirebenchError `current-value-unknown` — `name` has no committed value in that scope
   */
  set(key: ScopeKeyWire, name: string, value: string): CurrentValuesStateWire {
    const entry = this.scopes().get(scopeKeyString(key));
    if (entry === undefined || !Object.hasOwn(entry.committed, name)) {
      throw new WirebenchError(
        'current-value-unknown',
        `"${name}" has no committed value here, so it cannot have a current value.`,
        { details: { name } },
      );
    }
    if (entry.committed[name] === value) {
      entry.values.delete(name);
    } else {
      entry.values.set(name, value);
    }
    return this.announce();
  }

  /** Resets one current value, or every one of the scope when `name` is omitted. */
  reset(key: ScopeKeyWire, name?: string): CurrentValuesStateWire {
    const entry = this.scopes().get(scopeKeyString(key));
    if (entry !== undefined) {
      if (name === undefined) {
        entry.values.clear();
      } else {
        entry.values.delete(name);
      }
    }
    return this.announce();
  }

  /** What `RunContext.current` is for a send of `projectId` (or of no project) in the open workspace. */
  overlaysFor(projectId: string | undefined): CurrentValues {
    const overlays: {
      global?: PropertyMap;
      workspace?: PropertyMap;
      workspaceEnvironments?: Record<string, PropertyMap>;
      project?: PropertyMap;
      projectEnvironments?: Record<string, PropertyMap>;
    } = {};
    for (const { key, values } of this.scopes().values()) {
      if (values.size === 0) {
        continue;
      }
      const map = Object.fromEntries(values);
      switch (key.scope) {
        case 'global':
          overlays.global = map;
          break;
        case 'workspace':
          overlays.workspace = map;
          break;
        case 'workspaceEnvironment':
          overlays.workspaceEnvironments = { ...overlays.workspaceEnvironments, [key.environmentId]: map };
          break;
        case 'project':
          if (key.projectId === projectId) {
            overlays.project = map;
          }
          break;
        case 'projectEnvironment':
          if (key.projectId === projectId) {
            overlays.projectEnvironments = { ...overlays.projectEnvironments, [key.environmentId]: map };
          }
          break;
      }
    }
    return overlays;
  }

  private scopes(): Map<string, ScopeEntry> {
    let scopes = this.workspaces.get(this.currentId);
    if (scopes === undefined) {
      scopes = new Map();
      this.workspaces.set(this.currentId, scopes);
    }
    return scopes;
  }

  private announce(): CurrentValuesStateWire {
    const state = this.state();
    this.onChanged(state);
    return state;
  }

  /** Drops the scopes `test` picks; true when one of them held a value. */
  private dropWhere(test: (key: ScopeKeyWire) => boolean): boolean {
    const scopes = this.scopes();
    let dropped = false;
    for (const [id, entry] of scopes) {
      if (test(entry.key)) {
        dropped ||= entry.values.size > 0;
        scopes.delete(id);
      }
    }
    return dropped;
  }

  /** Brings `key`'s scope in step with its committed values; true when a current value moved or went. */
  private reconcile(key: ScopeKeyWire, properties: Readonly<Record<string, string>>): boolean {
    const scopes = this.scopes();
    const id = scopeKeyString(key);
    const entry = scopes.get(id);
    if (entry === undefined) {
      scopes.set(id, { key, committed: { ...properties }, values: new Map(), parked: new Map() });
      return false;
    }
    const removed = Object.keys(entry.committed).filter((name) => !Object.hasOwn(properties, name));
    const added = Object.keys(properties).filter((name) => !Object.hasOwn(entry.committed, name));
    const candidates = new Map(entry.parked);
    const parked = new Map<string, Held>();
    let changed = false;
    for (const name of removed) {
      const value = entry.values.get(name);
      if (value !== undefined) {
        const held = { committed: entry.committed[name] ?? '', value };
        candidates.set(name, held);
        parked.set(name, held);
        entry.values.delete(name);
        changed = true;
      }
    }
    for (const name of added) {
      const match = [...candidates].find(([, held]) => held.committed === properties[name]);
      if (match !== undefined) {
        const [from, held] = match;
        entry.values.set(name, held.value);
        candidates.delete(from);
        parked.delete(from);
        changed = true;
      }
    }
    // A committed value that now equals the current one leaves nothing to override.
    for (const [name, value] of entry.values) {
      if (properties[name] === value) {
        entry.values.delete(name);
        changed = true;
      }
    }
    entry.committed = { ...properties };
    entry.parked = parked;
    return changed;
  }
}
