/**
 * What the kinds' hosts share with `ProjectHost` (spec §5.3): the core they are built on, and the
 * open project's state they read through it.
 */

import type { Project, ProjectFiles } from '@wirebench/engine';
import type { ProjectProblemWire, UnsupportedContainerWire } from '../shared/wire-base.js';
import type { InterfaceRuntime } from './project-wire.js';
import type { ProjectWatcher } from './project-watch.js';
import type { ProjectHost } from './project-host.js';

/** The mutable state of one open project. */
export interface OpenProject {
  project: Project;
  readonly dir: string;
  dirty: boolean;
  lastSavedAt: string | undefined;
  problems: ProjectProblemWire[];
  readonly runtime: Map<string, InterfaceRuntime>;
  lastWritten: ProjectFiles | undefined;
  /**
   * The project's files as they are on disk when the model was last in sync with them: at open,
   * or after a save. What an unsaved-changes record is merged against when it is restored.
   */
  baseline: ProjectFiles;
  readonly watcher: ProjectWatcher;
  /** The project-level folders of kinds this run switched off, read at open; their files are never written. */
  switchedOff?: readonly UnsupportedContainerWire[];
}

/** An error's message, or the thrown value as text. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The part of `ProjectHost` a kind's host is built on: the open project, the save and change
 * machinery, preferences, secrets, keystores and the run context, and the other kinds' hosts.
 */
export type ProjectHostCore = Pick<
  ProjectHost,
  | 'open'
  | 'knowsEnvironment'
  | 'resolveEndpointFor'
  | 'picks'
  | 'prefs'
  | 'require'
  | 'expectOnDisk'
  | 'save'
  | 'snapshot'
  | 'scopesFor'
  | 'trustAnchors'
  | 'keystoreFor'
  | 'secrets'
  | 'issuedTokens'
  | 'runContextFor'
  | 'proxyFor'
  | 'clientIdentityFor'
  | 'markDirty'
  | 'emitChanged'
  | 'engine'
  | 'hooks'
  | 'writeImportedScripts'
  | 'getSecret'
  | 'workspaceContext'
  | 'kind'
  | 'hostState'
>;
