/**
 * One editor tab kind as a table row (kind modules spec §6.1): which `EditorTab` field names its
 * entity, the id prefix it opens under, whether it survives a workspace switch, what it renders and
 * how it is titled. The editor area, the tab labels and the workspace's saved tabs all read
 * `TAB_KINDS` rather than switching on the kind.
 */
import type { ComponentType, LazyExoticComponent } from 'react';
import type { DraftsState } from '../state/drafts.js';
import type { EditorTab } from '../state/editors.js';
import type { ProjectStore } from '../state/project.js';
import type { WorkspaceEnvironmentWire } from '../../shared/wire-base.js';

/** The `EditorTab` fields that hold a tab's entity id. */
export type TabIdField =
  | 'requestId'
  | 'interfaceId'
  | 'restRequestId'
  | 'apiId'
  | 'grpcRequestId'
  | 'grpcApiId'
  | 'wsRequestId'
  | 'wsApiId'
  | 'environmentId'
  | 'projectId'
  | 'sequenceId'
  | 'mockId'
  | 'historyId'
  | 'hookId'
  | 'runnerTargetId';

/** What a tab's title is read from. */
export interface TabTitleContext {
  readonly project: ProjectStore;
  readonly workspaceEnvironments: readonly WorkspaceEnvironmentWire[];
  /** Catch URLs' names by hook id. */
  readonly hookNames: Readonly<Record<string, string>>;
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
  /** Whether the entity has unsaved edits; only the request kinds carry drafts. */
  dirty?(id: string, drafts: DraftsState): boolean;
}

/** A tab's entity id, read through its contribution. */
export function entityIdOf(tab: EditorTab, contribution: TabContribution): string | undefined {
  return tab[contribution.idField];
}
