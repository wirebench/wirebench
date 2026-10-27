/**
 * Moving an API to another project of the open workspace (#701), as one step: every id kept, so open
 * tabs, History and anything else that names the API or its requests still resolve.
 *
 * The model half is `project-container-moves.ts`. This half owns what the model does not hold: the
 * definition and GraphQL schema caches in the API's folder, the attachment blobs its requests point
 * at, the project variables and this machine's `${secret:…}` values it reads (copied when the target
 * lacks them), and the two saves. Both projects are saved by the move: left to autosave, which is
 * off by default, a save of one without the other would leave the API in both folders or in
 * neither. A failure puts both models back, saves them, and takes back what was copied.
 */

import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  APIS_DIR,
  ProjectError,
  listAttachments,
  propertyReferences,
  putAttachment,
  readAttachment,
} from '@wirebench/engine';
import type { ContainerBase, Project, PropertyScopes } from '@wirebench/engine';
import { copyTreeIfPresent } from './workspace-files.js';
import { secretStoreLabel } from './secret-resolver.js';
import type { SecretStore } from './secrets.js';
import type { ProjectApiMovePlan } from '../shared/wire-types.js';
import { apiAfter, placeApi, takeApi } from './project-container-moves.js';

/** The `ProjectHost` surface a move drives on each side. */
export interface ApiMoveHost {
  savedProject(): { readonly project: Project; readonly dir: string } | undefined;
  /** The scopes a send resolves `${name}` against: what the project can already resolve. */
  scopesFor(): PropertyScopes;
  applyModelUpdate(update: (project: Project) => Project): boolean;
  save(options: { reason: string }): Promise<unknown>;
  expectOnDisk(paths: readonly string[]): void;
}

export type ApiMoveSecrets = Pick<SecretStore, 'get' | 'set' | 'findByLabel' | 'delete'>;

/** What the confirm lists before a move: what is copied, and what will not resolve in the target. */
export type ApiMovePlan = ProjectApiMovePlan;

/** Every string value anywhere in `value`. */
function* stringsIn(value: unknown): Iterable<string> {
  if (typeof value === 'string') {
    yield value;
  } else if (Array.isArray(value)) {
    for (const item of value) yield* stringsIn(item);
  } else if (typeof value === 'object' && value !== null && !(value instanceof Uint8Array)) {
    for (const item of Object.values(value)) yield* stringsIn(item);
  }
}

/** Every object anywhere in `value`, `value` itself included. */
function* objectsIn(value: unknown): Iterable<Record<string, unknown>> {
  if (Array.isArray(value)) {
    for (const item of value) yield* objectsIn(item);
  } else if (typeof value === 'object' && value !== null && !(value instanceof Uint8Array)) {
    const record = value as Record<string, unknown>;
    yield record;
    for (const item of Object.values(record)) yield* objectsIn(item);
  }
}

/** The explicit scopes a variable reference may name: `${#Project#name}`, `${#Env#name}`, …. */
const VARIABLE_SCOPES: ReadonlySet<string> = new Set(['Project', 'Env', 'Workspace', 'Global']);

/** What an API refers to that lives at the project level, collected from its whole container. */
export interface ApiReferences {
  readonly variables: readonly string[];
  readonly secrets: readonly string[];
  readonly keystoreIds: readonly string[];
  readonly requestIds: readonly string[];
  readonly attachmentShas: readonly string[];
}

/** Collects {@link ApiReferences} from one API's container. */
export function apiReferences(container: ContainerBase): ApiReferences {
  const variables = new Set<string>();
  const secrets = new Set<string>();
  for (const text of stringsIn(container)) {
    if (!text.includes('${')) continue;
    for (const reference of propertyReferences(text)) {
      if (reference.name === '') continue;
      if (reference.form === 'secret') secrets.add(reference.name);
      if (reference.form === 'shorthand') variables.add(reference.name);
      if (reference.form === 'scoped' && reference.scope !== undefined && VARIABLE_SCOPES.has(reference.scope)) {
        variables.add(reference.name);
      }
    }
  }
  const keystoreIds = new Set<string>();
  const requestIds = new Set<string>();
  const attachmentShas = new Set<string>();
  for (const record of objectsIn(container)) {
    for (const key of ['sslKeystoreRef', 'clientKeystoreId', 'keystoreRef']) {
      const id = record[key];
      if (typeof id === 'string' && id !== '') keystoreIds.add(id);
    }
    // A script's `secrets.get` names are secrets too, read like a `${secret:…}` token.
    if (Array.isArray(record['secrets']) && typeof record['enabled'] === 'boolean') {
      for (const name of record['secrets'] as unknown[]) if (typeof name === 'string') secrets.add(name);
    }
    if (record['kind'] === 'cache' && typeof record['sha256'] === 'string') attachmentShas.add(record['sha256']);
    if (Array.isArray(record['requests'])) {
      for (const request of record['requests'] as unknown[]) {
        const id = (request as { id?: unknown }).id;
        if (typeof id === 'string') requestIds.add(id);
      }
    }
  }
  return {
    variables: [...variables].sort(),
    secrets: [...secrets].sort(),
    keystoreIds: [...keystoreIds],
    requestIds: [...requestIds],
    attachmentShas: [...attachmentShas],
  };
}

/** Whether `scopes` resolve `name` anywhere a plain reference looks. */
function resolves(scopes: PropertyScopes, name: string): boolean {
  return [scopes.env, scopes.project, scopes.workspace, scopes.global].some(
    (map) => map !== undefined && Object.hasOwn(map, name),
  );
}

/** One side of a move, read once. */
interface Side {
  readonly host: ApiMoveHost;
  readonly project: Project;
  readonly dir: string;
}

function sideOf(host: ApiMoveHost): Side {
  const saved = host.savedProject();
  if (saved === undefined) throw new ProjectError('no-project', 'The project is not open');
  return { host, project: saved.project, dir: saved.dir };
}

async function secretValue(secrets: ApiMoveSecrets, projectId: string, name: string): Promise<string | undefined> {
  const ref = await secrets.findByLabel(secretStoreLabel(projectId, name));
  return ref === undefined ? undefined : await secrets.get(ref);
}

/** The plan, and the references carrying it out needs. */
interface Prepared {
  readonly plan: ApiMovePlan;
  readonly references: ApiReferences;
}

async function prepare(source: Side, target: Side, apiId: string, secrets: ApiMoveSecrets): Promise<Prepared> {
  if (source.project.id === target.project.id) {
    throw new ProjectError('project-move-same-project', 'The API is already in this project', {
      details: { apiId },
    });
  }
  const { slice } = takeApi(source.project, apiId);
  const references = apiReferences(slice.container);
  const sourceScopes = source.host.scopesFor();
  const targetScopes = target.host.scopesFor();

  const missing = references.variables.filter((name) => !resolves(targetScopes, name));
  const copiedVariables = missing.filter((name) => Object.hasOwn(source.project.properties, name));
  const unresolvedVariables = missing.filter((name) => !copiedVariables.includes(name) && resolves(sourceScopes, name));

  const copiedSecrets: string[] = [];
  const unresolvedSecrets: string[] = [];
  for (const name of references.secrets) {
    if ((await secretValue(secrets, target.project.id, name)) !== undefined) continue;
    if ((await secretValue(secrets, source.project.id, name)) !== undefined) copiedSecrets.push(name);
    else unresolvedSecrets.push(name);
  }

  const keystores = source.project.keystores
    .filter((keystore) => references.keystoreIds.includes(keystore.id))
    .map((keystore) => keystore.name);
  const requestIds = new Set(references.requestIds);
  const sequences = source.project.sequences
    .filter((sequence) =>
      [...objectsIn(sequence)].some(
        (record) => typeof record['requestId'] === 'string' && requestIds.has(record['requestId']),
      ),
    )
    .map((sequence) => sequence.name);

  return {
    references,
    plan: {
      apiName: slice.container.name,
      targetName: target.project.name,
      copiedVariables,
      copiedSecrets,
      unresolvedVariables,
      unresolvedSecrets,
      keystores,
      sequences,
    },
  };
}

/**
 * What moving `apiId` from `sourceHost` to `targetHost` would copy and leave behind, for the confirm.
 *
 * @throws ProjectError `project-move-same-project`, `project-entity-not-found`
 */
export async function planApiMove(
  sourceHost: ApiMoveHost,
  targetHost: ApiMoveHost,
  apiId: string,
  secrets: ApiMoveSecrets,
): Promise<ApiMovePlan> {
  return (await prepare(sideOf(sourceHost), sideOf(targetHost), apiId, secrets)).plan;
}

/** The folder names under `apis/` on disk, so a new slug never lands on a stray folder. */
async function apiFoldersOnDisk(dir: string): Promise<Set<string>> {
  try {
    return new Set((await readdir(join(dir, APIS_DIR), { withFileTypes: true })).map((entry) => entry.name));
  } catch {
    return new Set();
  }
}

/**
 * Moves `apiId` to the target project, before `beforeApiId` there or after its last API, and saves
 * both projects. Every id is kept. On failure both projects are put back as they were and the error
 * is rethrown. Answers the API that followed it in the source, so an undo can put it back there.
 *
 * @throws ProjectError `project-move-same-project`, `project-entity-not-found`, `project-move-id-clash`,
 *   or whatever a save throws
 */
export async function moveApi(
  sourceHost: ApiMoveHost,
  targetHost: ApiMoveHost,
  input: { readonly apiId: string; readonly beforeApiId?: string | undefined },
  secrets: ApiMoveSecrets,
): Promise<{ readonly sourceBeforeApiId: string | undefined }> {
  const source = sideOf(sourceHost);
  const target = sideOf(targetHost);
  const { plan, references } = await prepare(source, target, input.apiId, secrets);

  const sourceBeforeApiId = apiAfter(source.project, input.apiId);
  const taken = takeApi(source.project, input.apiId);
  const strays = await apiFoldersOnDisk(target.dir);
  const placedModel = placeApi(target.project, taken.slice, input.beforeApiId, strays);
  const placed = placedModel.containers[taken.slice.kind]?.find((container) => container.id === input.apiId);
  if (placed === undefined) throw new Error('The moved API is missing from the target');
  const nextTarget: Project =
    plan.copiedVariables.length === 0
      ? placedModel
      : {
          ...placedModel,
          properties: {
            ...placedModel.properties,
            ...Object.fromEntries(plan.copiedVariables.map((name) => [name, source.project.properties[name] ?? ''])),
          },
        };

  const fromFolder = join(source.dir, APIS_DIR, taken.slice.container.slug);
  const toFolder = join(target.dir, APIS_DIR, placed.slug);
  const createdSecrets: string[] = [];
  let modelsChanged = false;
  let sourceSaving = false;
  try {
    // The caches the save does not manage, before the source's save deletes its folder.
    for (const sub of ['definition', 'graphql']) {
      if (existsSync(join(fromFolder, sub))) {
        targetHost.expectOnDisk([`${APIS_DIR}/${placed.slug}/${sub}`]);
        await copyTreeIfPresent(join(fromFolder, sub), join(toFolder, sub));
      }
    }
    if (references.attachmentShas.length > 0) {
      const meta = new Map((await listAttachments(source.dir)).map((entry) => [entry.sha256, entry]));
      for (const sha256 of references.attachmentShas) {
        let bytes: Uint8Array;
        try {
          bytes = await readAttachment(source.dir, sha256);
        } catch {
          continue; // already missing here; the request reports it, as it did before the move
        }
        const entry = meta.get(sha256);
        await putAttachment(target.dir, bytes, {
          originalName: entry?.originalName ?? sha256,
          contentType: entry?.contentType ?? 'application/octet-stream',
        });
      }
    }
    for (const name of plan.copiedSecrets) {
      const value = await secretValue(secrets, source.project.id, name);
      if (value === undefined) continue;
      createdSecrets.push(await secrets.set(value, { label: secretStoreLabel(target.project.id, name) }));
    }
    // Out of the source first, so the routing index never sees the ids in two projects at once.
    modelsChanged = true;
    sourceHost.applyModelUpdate(() => taken.project);
    targetHost.applyModelUpdate(() => nextTarget);
    await targetHost.save({ reason: 'move-api' });
    sourceSaving = true;
    await sourceHost.save({ reason: 'move-api' });
    return { sourceBeforeApiId };
  } catch (error) {
    if (modelsChanged) {
      targetHost.applyModelUpdate(() => target.project);
      sourceHost.applyModelUpdate(() => source.project);
      await targetHost.save({ reason: 'move-api-undo' }).catch(() => undefined);
      // Only a source save that may have half-run is written again; an untouched one stays as it was.
      if (sourceSaving) await sourceHost.save({ reason: 'move-api-undo' }).catch(() => undefined);
    }
    // The slug was free in the model and on disk, so the folder holds only what this move wrote.
    await rm(toFolder, { recursive: true, force: true }).catch(() => undefined);
    for (const ref of createdSecrets) await secrets.delete(ref).catch(() => undefined);
    throw error;
  }
}
