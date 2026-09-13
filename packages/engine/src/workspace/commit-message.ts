/**
 * Maps a path inside a shared workspace's tree to the entity it belongs to, and turns a list of
 * changed paths into a git commit message. Pure: no file-system access, no git. `SyncService`
 * (main) calls {@link commitMessage} with the paths `git status`/`diff --name-only` reported for
 * the working tree, right before running `git commit`.
 *
 * Paths are always `/`-separated tree-relative paths, as git itself reports them — never joined
 * with `node:path`, which would emit `\` on Windows and break every pattern below.
 */

import { WSS_DIR, REQUEST_SUFFIX } from '../project/paths.js';
import { KEYSTORES_PATH } from '../project/serialize.js';
import { WORKSPACE_ENVIRONMENTS_DIR, WORKSPACE_MANIFEST, WORKSPACE_PROJECTS_DIR } from './paths.js';

/** What kind of entity a tree path belongs to. */
export type TreeEntityKind =
  | 'workspace'
  | 'environment'
  | 'project'
  | 'interface'
  | 'request'
  | 'project-environment'
  | 'wss'
  | 'keystores'
  | 'attachment'
  | 'definition'
  | 'other';

/**
 * The entity a tree path belongs to. `key` identifies the entity itself (as opposed to the file):
 * a request's `.request.yaml` and `.xml` share one key, as do every file under one interface's
 * `definition/` cache — so {@link commitMessage} can group them into a single change.
 */
export interface TreeEntity {
  readonly kind: TreeEntityKind;
  readonly name: string;
  readonly projectSlug?: string;
  readonly key: string;
}

/** Last `/`-separated segment of a path. */
function basename(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

/** Classifies a path inside a project's own folder (relative to `projects/<slug>/`). */
function describeProjectPath(projectSlug: string, relative: string, fullPath: string): TreeEntity {
  if (relative === 'wirebench.yaml') {
    return { kind: 'project', name: projectSlug, projectSlug, key: fullPath };
  }

  if (relative === KEYSTORES_PATH) {
    return { kind: 'keystores', name: 'keystores', projectSlug, key: fullPath };
  }

  const wssMatch = /^wss\/[^/]+\/([^/]+)\.yaml$/.exec(relative);
  if (wssMatch !== undefined && wssMatch !== null) {
    return { kind: 'wss', name: wssMatch[1] ?? basename(relative), projectSlug, key: fullPath };
  }
  if (relative.startsWith(`${WSS_DIR}/`)) {
    // Any other file under wss/ that isn't the registry or a `<direction>/<name>.yaml` config.
    return { kind: 'wss', name: basename(relative), projectSlug, key: fullPath };
  }

  if (relative.startsWith('attachments/')) {
    return { kind: 'attachment', name: basename(relative), projectSlug, key: fullPath };
  }

  const environmentMatch = /^environments\/([^/]+)\.yaml$/.exec(relative);
  if (environmentMatch !== undefined && environmentMatch !== null) {
    return { kind: 'project-environment', name: environmentMatch[1] ?? basename(relative), projectSlug, key: fullPath };
  }

  // A request occupies two files under the same operation folder that share one entity key:
  // `<slug>.request.yaml` (metadata) and `<slug>.xml` (the verbatim envelope) — see
  // `project/paths.ts`'s `requestFiles()`.
  const requestSuffix = escapeRegExp(REQUEST_SUFFIX);
  const requestMatch = new RegExp(`^interfaces/[^/]+/operations/[^/]+/([^/]+)(?:${requestSuffix}|\\.xml)$`).exec(
    relative,
  );
  if (requestMatch !== undefined && requestMatch !== null) {
    const requestSlug = requestMatch[1] ?? basename(relative);
    const suffixLength = relative.endsWith(REQUEST_SUFFIX) ? REQUEST_SUFFIX.length : '.xml'.length;
    const key = fullPath.slice(0, fullPath.length - suffixLength);
    return { kind: 'request', name: requestSlug, projectSlug, key };
  }

  const interfaceMatch = /^interfaces\/([^/]+)\/interface\.yaml$/.exec(relative);
  if (interfaceMatch !== undefined && interfaceMatch !== null) {
    return { kind: 'interface', name: interfaceMatch[1] ?? basename(relative), projectSlug, key: fullPath };
  }

  const definitionMatch = /^interfaces\/([^/]+)\/definition\//.exec(relative);
  if (definitionMatch !== undefined && definitionMatch !== null) {
    const interfaceSlug = definitionMatch[1] ?? basename(relative);
    return {
      kind: 'definition',
      name: interfaceSlug,
      projectSlug,
      key: `${WORKSPACE_PROJECTS_DIR}/${projectSlug}/interfaces/${interfaceSlug}/definition`,
    };
  }

  return { kind: 'other', name: basename(relative), key: fullPath };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Classifies a tree-relative path into the {@link TreeEntity} it belongs to, following the tree
 * layout `workspace.yaml`, `environments/<slug>.yaml`, `.gitattributes` at the root plus
 * `projects/<slug>/` per internal project (itself laid out exactly as `project/serialize.ts`'s
 * `projectFiles()` writes it). Anything unrecognised — including `.gitattributes` — classifies as
 * `other`.
 */
export function describeTreePath(relativePath: string): TreeEntity {
  if (relativePath === WORKSPACE_MANIFEST) {
    return { kind: 'workspace', name: 'workspace', key: relativePath };
  }

  const environmentMatch = new RegExp(`^${WORKSPACE_ENVIRONMENTS_DIR}/([^/]+)\\.yaml$`).exec(relativePath);
  if (environmentMatch !== undefined && environmentMatch !== null) {
    return { kind: 'environment', name: environmentMatch[1] ?? basename(relativePath), key: relativePath };
  }

  const projectMatch = new RegExp(`^${WORKSPACE_PROJECTS_DIR}/([^/]+)/(.+)$`).exec(relativePath);
  if (projectMatch !== undefined && projectMatch !== null) {
    const projectSlug = projectMatch[1] ?? '';
    const rest = projectMatch[2] ?? '';
    return describeProjectPath(projectSlug, rest, relativePath);
  }

  return { kind: 'other', name: basename(relativePath), key: relativePath };
}

/** A path that changed in the tree, as `git status`/`diff --name-only` reports it. */
export interface TreeChange {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'deleted';
}

/** Human-facing label for one entity kind, singular. */
const LABELS: Record<TreeEntityKind, string> = {
  workspace: 'workspace properties',
  environment: 'environment',
  project: 'project',
  interface: 'interface',
  request: 'request',
  'project-environment': 'project environment',
  wss: 'WS-Security config',
  keystores: 'keystores',
  attachment: 'attachment',
  definition: 'definition',
  other: 'file',
};

/** Kinds whose label does not take a plain `s` suffix when the count isn't 1. */
const INVARIANT_PLURAL: ReadonlySet<TreeEntityKind> = new Set(['keystores', 'workspace']);

function pluralise(kind: TreeEntityKind, count: number): string {
  const label = LABELS[kind];
  if (count === 1 || INVARIANT_PLURAL.has(kind)) {
    return label;
  }
  return `${label}s`;
}

const MAX_SUBJECT_LENGTH = 72;
const AUTOSAVE_SUFFIX = ' (autosave)';

/** Combines an entity's changed-file statuses into one verb: mixed statuses read as `modified`. */
function combinedStatus(statuses: readonly TreeChange['status'][]): TreeChange['status'] {
  if (statuses.every((status) => status === 'added')) {
    return 'added';
  }
  if (statuses.every((status) => status === 'deleted')) {
    return 'deleted';
  }
  return 'modified';
}

const VERBS: Record<TreeChange['status'], string> = {
  added: 'Add',
  modified: 'Update',
  deleted: 'Delete',
};

/** Truncates `subject` to fit `AUTOSAVE_SUFFIX` (when `autosave`) within {@link MAX_SUBJECT_LENGTH}. */
function withAutosave(subject: string, autosave: boolean | undefined): string {
  const suffix = autosave === true ? AUTOSAVE_SUFFIX : '';
  const full = `${subject}${suffix}`;
  if (full.length <= MAX_SUBJECT_LENGTH) {
    return full;
  }
  const budget = MAX_SUBJECT_LENGTH - suffix.length - 1; // 1 for the ellipsis
  return `${subject.slice(0, budget)}…${suffix}`;
}

/**
 * Builds a git commit message — subject line, blank line, one changed path per line — from the
 * tree paths a save touched. `''` for no changes (nothing to commit).
 *
 * One entity changed: `Update request GetWeather in billing`, `Add environment QA`, `Update
 * workspace properties`. Several: `Update 3 requests, 1 environment`, counts sorted by count
 * descending then label ascending. `options.autosave` appends ` (autosave)`; the subject
 * (suffix included) is truncated to {@link MAX_SUBJECT_LENGTH} characters with a trailing `…`.
 */
export function commitMessage(changes: readonly TreeChange[], options?: { readonly autosave?: boolean }): string {
  if (changes.length === 0) {
    return '';
  }

  interface Group {
    readonly entity: TreeEntity;
    readonly paths: string[];
    readonly statuses: TreeChange['status'][];
  }

  const groups = new Map<string, Group>();
  for (const change of changes) {
    const entity = describeTreePath(change.path);
    let group = groups.get(entity.key);
    if (group === undefined) {
      group = { entity, paths: [], statuses: [] };
      groups.set(entity.key, group);
    }
    group.paths.push(change.path);
    group.statuses.push(change.status);
  }

  const body = [...changes.map((change) => change.path)].sort().join('\n');

  let subject: string;
  if (groups.size === 1) {
    const group = groups.values().next().value as Group;
    const { entity } = group;
    const verb = VERBS[combinedStatus(group.statuses)];
    const label = LABELS[entity.kind];
    const nameSuffix = entity.kind === 'workspace' ? '' : ` ${entity.name}`;
    const projectSuffix = entity.projectSlug === undefined ? '' : ` in ${entity.projectSlug}`;
    subject = `${verb} ${label}${nameSuffix}${projectSuffix}`;
  } else {
    const counts = new Map<TreeEntityKind, number>();
    for (const group of groups.values()) {
      counts.set(group.entity.kind, (counts.get(group.entity.kind) ?? 0) + 1);
    }
    const parts = [...counts.entries()]
      .sort(([kindA, countA], [kindB, countB]) => {
        if (countA !== countB) {
          return countB - countA;
        }
        return LABELS[kindA].localeCompare(LABELS[kindB]);
      })
      .map(([kind, count]) => `${count} ${pluralise(kind, count)}`);
    subject = `Update ${parts.join(', ')}`;
  }

  return `${withAutosave(subject, options?.autosave)}\n\n${body}`;
}
