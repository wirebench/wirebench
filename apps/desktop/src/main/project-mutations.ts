/**
 * Pure, immutable transformations of the engine `Project` model — one per {@link ProjectChange}
 * variant. `ProjectHost` owns the I/O (generate, save, watch); this module owns "what the model
 * looks like afterwards", so every rule about naming, slugs and ordering is unit-testable without a
 * disk or an Electron app.
 *
 * Core applies the changes that are about no protocol here; each kind applies its own from its
 * `mutations` table under `main/kinds/<kind>/` (spec §5.2).
 */

import { ProjectError, slugify } from '@wirebench/engine';
import type { AttachmentSource, Project, ProjectSettings, PropertyMap } from '@wirebench/engine';
import type { ProjectChange } from '../shared/wire-types.js';
import type { ProjectSettingsPatchWire } from '../shared/wire-base.js';
import type { ChangeReducer, KindTree } from './kinds/kind-main.js';
import { MAIN_KINDS, mutationOwner } from './kinds/kind-main.js';
import { kindById, type KindId } from '../shared/kinds/kind-module.js';
import type { GeneratedEnvelope } from './kinds/soap/mutations.js';
import { notFound } from './project-api-mutations.js';
import { rekeyProjectEnvironments, renamedContainerSlugs } from './endpoint-renames.js';
import {
  addEnvironment,
  deleteEnvironment,
  setActiveEnvironment,
  updateEnvironment,
} from './project-environment-mutations.js';
import { addKeystore, removeKeystore, updateKeystore } from './project-keystore-mutations.js';
import { setRequestAssertions } from './project-assertion-mutations.js';
import { convertScripts, enableScripts, updateRequestScripts } from './project-script-mutations.js';
import type { ScriptConversions } from './project-script-mutations.js';
import {
  addMock,
  addMockResponse,
  duplicateMock,
  moveMockResponse,
  removeMock,
  removeMockResponse,
  updateMock,
  updateMockOperation,
  updateMockResponse,
} from './project-mock-mutations.js';
import type { GenerateMockFn } from './project-mock-mutations.js';
import { reorderApi } from './project-container-moves.js';
import { addSequence, duplicateSequence, removeSequence, updateSequence } from './project-sequence-mutations.js';

/**
 * Reads (and, when asked, content-addresses into the project's attachment cache) the file an
 * `add-attachment` names. Kept as a dependency so the reducer stays free of `fs`: the service
 * owns the project directory, which is the only thing that can turn a path into a cache blob.
 */
export type AddAttachmentFile = (input: {
  readonly path: string;
  readonly copyToCache: boolean;
  /** The already-resolved media type, so the cache index records the same one the model does. */
  readonly contentType: string;
}) => Promise<{ readonly size: number; readonly source: AttachmentSource }>;

/** I/O the pure reducer cannot do itself. */
export interface MutationDeps {
  /** Builds a fresh sample envelope for one operation of an already-hydrated interface. */
  readonly generate: (interfaceId: string, bindingName: string, operationName: string) => Promise<GeneratedEnvelope>;
  /** Supplied by `ProjectHost` whenever a project is open; absent only in tests that never attach. */
  readonly addAttachmentFile?: AddAttachmentFile;
  /**
   * Whether `add-keystore` may register this path: it must be inside the project folder or
   * have been picked through `keystores.pickFile` this session. Absent only in tests that
   * never add a keystore — `add-keystore` refuses outright when it is.
   */
  readonly allowsKeystorePath?: (path: string) => Promise<boolean>;
  /** The slugs of sequence files the last load refused; a new or renamed sequence avoids them. */
  readonly reservedSequenceSlugs?: ReadonlySet<string>;
  /** The slugs of mock folders the last load refused; a new or renamed mock avoids them. */
  readonly reservedMockSlugs?: ReadonlySet<string>;
  /** Generates a mock from a container's cached definition; absent only in tests that never add one. */
  readonly generateMock?: GenerateMockFn;
  /**
   * The properties of the workspace the project is open inside, if any: creating the webhook
   * collection seeds `webhookTarget` only when neither the project nor these define it.
   */
  readonly workspaceProperties?: PropertyMap;
  /**
   * The kinds this run has on (`WIREBENCH_KINDS`). A change a kind that is off owns is refused: the
   * engine neither loads nor saves what that kind keeps. Absent, every kind is on.
   */
  readonly enabledKinds?: readonly KindId[];
  /**
   * The project-relative paths under `imported-scripts/`, listed afresh for this change. A
   * `convert-scripts` change refuses outright without it: a backup's name depends on what is there.
   */
  readonly takenBackups?: ReadonlySet<string>;
}

/** The outcome of one change: the next model, plus any entity the change created. */
export interface MutationResult {
  readonly project: Project;
  /**
   * The REST entity a change created — an API, a folder or a request. One field for all three
   * because the caller already knows which change it sent, and the renderer only ever needs "the
   * thing I just made" to select or open it.
   */
  readonly createdId?: string;
  readonly createdRequestId?: string;
  readonly createdEnvironmentId?: string;
  readonly createdAttachmentId?: string;
  readonly createdKeystoreId?: string;
  readonly createdWssOutgoingId?: string;
  readonly createdWssIncomingId?: string;
  /** Set by `convert-scripts`: the caller writes `applied[].backups` before it saves. */
  readonly conversions?: ScriptConversions;
}

/** Merges a settings patch into the project's settings; `resourceRoot: null` clears it. */
function updateProjectSettings(project: Project, patch: ProjectSettingsPatchWire): MutationResult {
  const settings: Record<string, unknown> = { ...project.settings };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      continue;
    }
    if (value === null) {
      delete settings[key];
      continue;
    }
    settings[key] = value;
  }
  return { project: { ...project, settings: settings as unknown as ProjectSettings } };
}

/**
 * The change kinds core applies itself: they are about no protocol (sequences, mocks, environments,
 * properties, keystores, assertions, scripts, settings) or, like the folder changes, they serve every
 * kind with folders. Every other change kind belongs to exactly one kind's `mutations` table.
 */
export const CORE_CHANGE_KINDS: readonly ProjectChange['kind'][] = [
  'rename-project',
  'add-sequence',
  'update-sequence',
  'remove-sequence',
  'duplicate-sequence',
  'add-mock',
  'update-mock',
  'update-mock-operation',
  'add-mock-response',
  'update-mock-response',
  'remove-mock-response',
  'move-mock-response',
  'remove-mock',
  'duplicate-mock',
  'add-environment',
  'update-environment',
  'remove-environment',
  'set-active-environment',
  'set-project-property',
  'remove-project-property',
  'set-project-property-enabled',
  'set-request-assertions',
  'update-request-scripts',
  'enable-scripts',
  'convert-scripts',
  'update-project-settings',
  'add-keystore',
  'update-keystore',
  'remove-keystore',
  'add-folder',
  'update-folder',
  'remove-folder',
  'move-node',
  'move-container',
];

/**
 * Applies one {@link ProjectChange}, returning the next model. Never mutates its input.
 *
 * Core applies the change kinds that are about no protocol; every other one is looked up in the
 * kinds' `mutations` tables (spec §5.2). A change that renames an interface or API moves its
 * endpoint overrides in the project's environments with its slug (#477).
 *
 * @throws ProjectError `unknown-change` when no kind owns `change.kind`.
 */
export async function applyChange(
  project: Project,
  change: ProjectChange,
  deps: MutationDeps,
): Promise<MutationResult> {
  const result = await applyChangeOnly(project, change, deps);
  const rekeyed = rekeyProjectEnvironments(result.project, renamedContainerSlugs(project, result.project));
  return rekeyed === result.project ? result : { ...result, project: rekeyed };
}

async function applyChangeOnly(project: Project, change: ProjectChange, deps: MutationDeps): Promise<MutationResult> {
  switch (change.kind) {
    case 'rename-project':
      return { project: { ...project, name: change.name } };

    case 'add-sequence':
      return addSequence(project, change.name, deps.reservedSequenceSlugs);

    case 'update-sequence':
      return updateSequence(project, change.sequenceId, change.patch, deps.reservedSequenceSlugs);

    case 'remove-sequence':
      return removeSequence(project, change.sequenceId);

    case 'duplicate-sequence':
      return duplicateSequence(project, change.sequenceId, deps.reservedSequenceSlugs);

    case 'add-mock':
      return addMock(
        project,
        { containerId: change.containerId, name: change.name, binding: change.binding },
        deps.generateMock,
        deps.reservedMockSlugs,
      );

    case 'update-mock':
      return updateMock(project, change.mockId, change.patch, deps.reservedMockSlugs);

    case 'update-mock-operation':
      return updateMockOperation(project, change.mockId, change.operationId, change.patch);

    case 'add-mock-response':
      return addMockResponse(project, change.mockId, change.operationId, change.copyOf);

    case 'update-mock-response':
      return updateMockResponse(project, change.mockId, change.operationId, change.responseId, change.patch);

    case 'remove-mock-response':
      return removeMockResponse(project, change.mockId, change.operationId, change.responseId);

    case 'move-mock-response':
      return moveMockResponse(project, change.mockId, change.operationId, change.responseId, change.to);

    case 'remove-mock':
      return removeMock(project, change.mockId);

    case 'duplicate-mock':
      return duplicateMock(project, change.mockId, deps.reservedMockSlugs);

    case 'add-environment': {
      const added = addEnvironment(project, change.name);
      return { project: added.project, createdEnvironmentId: added.environment.id };
    }

    case 'update-environment':
      return { project: updateEnvironment(project, change.environmentId, change.patch) };

    case 'remove-environment':
      return { project: deleteEnvironment(project, change.environmentId) };

    case 'set-active-environment':
      return { project: setActiveEnvironment(project, change.environmentId) };

    case 'set-project-property':
      return { project: { ...project, properties: { ...project.properties, [change.name]: change.value } } };

    case 'remove-project-property': {
      const properties = { ...project.properties };
      delete properties[change.name];
      return { project: { ...project, properties } };
    }

    case 'set-project-property-enabled': {
      const disabledProperties = change.enabled
        ? project.disabledProperties.filter((name) => name !== change.name)
        : [...project.disabledProperties, change.name];
      return { project: { ...project, disabledProperties } };
    }

    case 'set-request-assertions':
      return setRequestAssertions(project, change.requestId, change.assertions);

    case 'update-request-scripts':
      return updateRequestScripts(project, change.requestId, change.scripts);

    case 'enable-scripts':
      return enableScripts(project, change.requestIds);

    case 'convert-scripts': {
      if (deps.takenBackups === undefined) {
        throw new ProjectError('convert-unavailable', 'Scripts can only be converted in an open project folder.');
      }
      return convertScripts(project, change.levels, deps.takenBackups);
    }

    case 'update-project-settings':
      return updateProjectSettings(project, change.patch);

    case 'add-keystore': {
      // The renderer may name any string it likes, so the path is checked here — against the
      // project folder and the session's dialog picks — before it is ever written down, let
      // alone read. See `path-access.ts`.
      const allowed = (await deps.allowsKeystorePath?.(change.path)) ?? false;
      if (!allowed) {
        throw new ProjectError(
          'keystore-outside-project',
          'A keystore must live inside the project folder, or be chosen through the file picker.',
          { details: { path: change.path } },
        );
      }
      const added = addKeystore(project, {
        path: change.path,
        ...(change.name !== undefined ? { name: change.name } : {}),
        ...(change.passwordSecretRef !== undefined ? { passwordSecretRef: change.passwordSecretRef } : {}),
      });
      return { project: added.project, createdKeystoreId: added.keystoreId };
    }

    case 'update-keystore':
      return { project: updateKeystore(project, change.keystoreId, change.patch) };

    case 'remove-keystore':
      return { project: removeKeystore(project, change.keystoreId) };

    // The folder changes serve every API kind: a folder is a folder, and the change names the
    // folder or its API, so the kind that owns the id applies it (spec §5.2).
    case 'add-folder':
      return treeOwning((tree) => tree.ownsApi(project, change.apiId), 'API', change.apiId, deps).addFolder(project, {
        apiId: change.apiId,
        ...(change.parentId !== undefined ? { parentId: change.parentId } : {}),
        name: change.name,
      });

    case 'update-folder':
      return treeOwning(
        (tree) => tree.ownsNode(project, change.folderId),
        'folder',
        change.folderId,
        deps,
      ).updateFolder(project, change.folderId, change.patch);

    case 'remove-folder':
      return treeOwning(
        (tree) => tree.ownsNode(project, change.folderId),
        'folder',
        change.folderId,
        deps,
      ).removeFolder(project, change.folderId);

    case 'move-node':
      return treeOwning((tree) => tree.ownsNode(project, change.nodeId), 'node', change.nodeId, deps).moveNode(
        project,
        {
          nodeId: change.nodeId,
          ...(change.parentId !== undefined ? { parentId: change.parentId } : {}),
          index: change.index,
        },
      );

    case 'move-container':
      return { project: reorderApi(project, change.apiId, change.beforeApiId) };

    default:
      return applyKindChange(project, change, deps);
  }
}

/** Hands a change to the kind whose `mutations` table names it. */
function applyKindChange(
  project: Project,
  change: ProjectChange,
  deps: MutationDeps,
): MutationResult | Promise<MutationResult> {
  const owner = mutationOwner(change.kind);
  const reducer = owner?.mutations[change.kind] as ChangeReducer | undefined;
  if (owner === undefined || reducer === undefined) {
    throw new ProjectError('unknown-change', `No kind applies the change "${change.kind}"`, {
      details: { kind: change.kind },
    });
  }
  requireKindEnabled(owner.kind, deps.enabledKinds);
  return reducer(project, change, deps);
}

/**
 * The tree of the kind that owns an id, per `owns`.
 *
 * @throws ProjectError `project-entity-not-found` when no kind does.
 */
function treeOwning(owns: (tree: KindTree) => boolean, what: string, id: string, deps: MutationDeps): KindTree {
  for (const kind of MAIN_KINDS) {
    if (kind.tree !== undefined && owns(kind.tree)) {
      requireKindEnabled(kind.kind, deps.enabledKinds);
      return kind.tree;
    }
  }
  return notFound(what, id);
}

/**
 * Refuses a write through a kind this run switched off, as the engine refuses a feature that is off:
 * the write would alter the model and the save, whose registry has the kind off, would drop it.
 * `enabledKinds` absent means every kind is on.
 *
 * @throws ProjectError `feature-disabled` with `details.feature`
 */
export function requireKindEnabled(kind: KindId, enabledKinds: readonly KindId[] | undefined): void {
  if (enabledKinds === undefined || enabledKinds.includes(kind)) {
    return;
  }
  const module = kindById(kind);
  throw new ProjectError('feature-disabled', `${module.label} is switched off`, {
    details: { feature: module.feature.id },
  });
}

/** Derives a project's default name from its folder, the folder's last segment. */
export function projectNameFromDir(dir: string): string {
  const segments = dir.split(/[\\/]/).filter((segment) => segment.length > 0);
  return slugify(segments.at(-1) ?? 'Project');
}
