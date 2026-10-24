/**
 * One editor tab kind as a table row (kind modules spec §6.1): which `EditorTab` field names its
 * entity, the id prefix it opens under, whether it survives a workspace switch, what it renders and
 * how it is titled. The editor area, the tab labels and the workspace's saved tabs all read
 * `TAB_KINDS` rather than switching on the kind.
 */
import type { ComponentType, LazyExoticComponent } from 'react';
import type { DraftsState } from '../state/drafts.js';
import type { EditorTab } from '../state/editors.js';
import type { ProjectSnapshot, ProjectStore } from '../state/project.js';
import type { WorkspaceEnvironmentWire } from '../../shared/wire-base.js';

/** The `EditorTab` fields that hold a tab's entity id. */
export type TabIdField =
  | 'requestId'
  | 'interfaceId'
  | 'restRequestId'
  | 'apiId'
  | 'apiDocsId'
  | 'folderId'
  | 'grpcRequestId'
  | 'grpcApiId'
  | 'wsRequestId'
  | 'wsApiId'
  | 'mcpRequestId'
  | 'mcpApiId'
  | 'environmentId'
  | 'projectId'
  | 'sequenceId'
  | 'mockId'
  | 'historyId'
  | 'hookId'
  | 'scheduleId'
  | 'runnerTargetId';

/** What a tab's title is read from. */
export interface TabTitleContext {
  readonly project: ProjectStore;
  readonly workspaceEnvironments: readonly WorkspaceEnvironmentWire[];
  /** Catch URLs' names by hook id. */
  readonly hookNames: Readonly<Record<string, string>>;
  /** Schedules' names by schedule id. */
  readonly scheduleNames: Readonly<Record<string, string>>;
}

export interface TabContribution {
  readonly kind: EditorTab['kind'];
  readonly idField: TabIdField;
  /** The tab id is `${prefix}${entityId}`. */
  readonly prefix: string;
  /** Whether the tab is saved with the workspace and reopened with it. */
  readonly persisted: boolean;
  readonly Component:
    LazyExoticComponent<ComponentType<{ readonly id: string }>> | ComponentType<{ readonly id: string }>;
  /** What the panel says while a lazy component loads. */
  readonly loading?: string;
  /** Remount the panel when the entity changes, rather than reuse it across tabs of this kind. */
  readonly keyed?: boolean;
  /** The entity's current name, or `undefined` when it is gone (or has no name of its own). */
  title(id: string, context: TabTitleContext): string | undefined;
  /** What tells the entity apart from others of the same name, shown after it in the tab menu. */
  detail?(id: string, context: TabTitleContext): string | undefined;
  /**
   * The API (and folder) the tab's entity sits in: where a `<kind>.new*` command run from this tab creates.
   * Unset, or `undefined`, for a tab that is not in one of its kind's APIs.
   */
  container?(id: string, project: ProjectSnapshot): TabContainer | undefined;
  /** The explorer row the tab's entity is: what the tree reveals and selects while the tab is active. */
  treeNode?(id: string, project: ProjectSnapshot): string | undefined;
  /** Whether the entity has unsaved edits; only the request kinds carry drafts. */
  dirty?(id: string, drafts: DraftsState): boolean;
}

/** An API, and the folder inside it, that a tab's entity sits in. */
export interface TabContainer {
  readonly apiId: string;
  readonly folderId?: string;
}

/** The container of a request that has an `apiId` and maybe a `folderId`, when `owns` says the API is its kind's. */
export function requestContainer(
  request: { readonly apiId: string; readonly folderId?: string | undefined } | undefined,
  owns: (apiId: string) => boolean,
): TabContainer | undefined {
  if (request === undefined || !owns(request.apiId)) return undefined;
  return request.folderId === undefined
    ? { apiId: request.apiId }
    : { apiId: request.apiId, folderId: request.folderId };
}

/** A tab's entity id, read through its contribution. */
export function entityIdOf(tab: EditorTab, contribution: TabContribution): string | undefined {
  return tab[contribution.idField];
}
