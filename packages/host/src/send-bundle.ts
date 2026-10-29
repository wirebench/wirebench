/**
 * The send bundle (hosted edition spec §18.4): what the server host hands a browser tab for its paired agent
 * to send one saved request. It is a project folder of its own, as the engine writes one, holding only what
 * that send reads:
 * - the manifest, the request's container (API or interface) with its scripts, the folders on the way down
 *   to the request with theirs, and the request's own files;
 * - the environment it is sent under, values only (a secret is a `${secret:…}` token in it, never a value);
 * - the project files it reads (a body file, a part, an attachment, a keystore inside the project) and its
 *   container's cached definition;
 * - the names of the `${secret:…}` and `${#System#…}` values it reads, never a value;
 * - the workspace and global properties (`scopes`), values only, which are the send's whole
 *   `${#Workspace#…}` and `${#Global#…}` scopes on the agent;
 * - when it reads a team secret, the workspace's `team-secrets/` subtree as it is (`teamSecrets`).
 *
 * Inside a workspace the agent has no workspace to resolve environments through, so the environment it is
 * sent under is written as a project environment: the values that apply, and the container's resolved
 * address.
 */
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  ATTACHMENTS_DIR,
  createBuiltinRegistry,
  projectFiles,
  ProjectError,
  restApisOf,
  slugify,
  toKeystoreDef,
  WirebenchError,
} from '@wirebench/engine';
import type { Environment, Project, PropertyScopes, ProtocolRegistry } from '@wirebench/engine';
import {
  AGENT_BUNDLE_MAX_BYTES,
  AGENT_BUNDLE_MAX_FILES,
  isBundlePath,
  sendBundleSchema,
  type SendBundle,
  type SendBundleFile,
} from '@wirebench/wire/agent';
import { previewRest, previewSoap, type SendThroughEngineDeps } from './send/exchange.js';
import type { SendRouteDeps } from './send-route.js';
import { itemReferences, keystoreOnMachine, locateRouted, type RoutableItem, type RoutedItem } from './send-route.js';

/** Where the bundle builder reads the item and its workspace. */
export interface SendBundleDeps {
  readonly send: SendThroughEngineDeps;
  /** The server workspace id the project belongs to (the agent's secret namespace is keyed by it). */
  readonly serverWorkspaceId: (projectId: string) => string | undefined;
  /** Whether the project's workspace holds a team secret of that name; none is when absent. */
  readonly isTeamSecret?: SendRouteDeps['isTeamSecret'];
  /** The absolute path of the project's workspace's `team-secrets/` folder; absent when it has none. */
  readonly teamSecretsDir?: (projectId: string) => string | undefined;
  /** The bundle's caps; the wire's when absent (tests lower them). */
  readonly limits?: { readonly maxBytes: number; readonly maxFiles: number };
}

const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function tooLarge(message: string, details: Record<string, unknown>): WirebenchError {
  return new WirebenchError('send-bundle-too-large', message, { details });
}

/** A folder tree with only the branch that leads to `requestId`; `undefined` when it holds no such request. */
interface TreeNode {
  readonly folders: readonly TreeNode[];
  readonly requests: readonly { readonly id: string }[];
}

function branchTo<N extends TreeNode>(node: N, requestId: string): N | undefined {
  const requests = node.requests.filter((request) => request.id === requestId);
  if (requests.length > 0) return { ...node, folders: [], requests };
  for (const folder of node.folders) {
    const kept = branchTo(folder, requestId);
    if (kept !== undefined) return { ...node, folders: [kept], requests: [] };
  }
  return undefined;
}

/** The request's container cut down to the request and its folder chain. */
function prunedContainer(item: RoutableItem, container: unknown): unknown {
  if (item.kind === 'rest') return branchTo(container as typeof item.api, item.request.id) ?? container;
  const iface = container as typeof item.iface;
  // Every operation stays, for the definition; only this request's operation keeps a request.
  return {
    ...iface,
    operations: iface.operations.map((operation) => ({
      ...operation,
      requests: operation.requests.filter((request) => request.id === item.request.id),
    })),
  };
}

/** The id of the container the item lives in; `undefined` for a webhook item, which the project keeps. */
function containerIdOf(project: Project, item: RoutableItem): string | undefined {
  if (item.kind === 'soap') return item.iface.id;
  return restApisOf(project).some((api) => api.id === item.api.id) ? item.api.id : undefined;
}

/** `project` holding only what a send of `item` reads, before its environment is settled. */
function prunedProject(project: Project, item: RoutableItem, registry: ProtocolRegistry): Project {
  const containerId = containerIdOf(project, item);
  let pruned: Project = { ...project, sequences: [], mocks: [] };
  for (const { storage } of registry.modules) {
    const kept = storage
      .containers(pruned)
      .filter((container) => (container as { readonly id: string }).id === containerId)
      .map((container) => prunedContainer(item, container));
    pruned = storage.withContainers(pruned, kept as never);
  }
  return pruned;
}

/** `project` with no active environment: the bundle names its own. */
function withoutActive(project: Project): Project {
  const copy: { -readonly [K in keyof Project]: Project[K] } = { ...project };
  delete copy.activeEnvironmentId;
  return copy;
}

/** The resolved address the request's container has under the environment, for a written environment. */
async function containerAddress(
  deps: SendThroughEngineDeps,
  item: RoutableItem,
  request: RoutedItem,
): Promise<string | undefined> {
  try {
    if (item.kind === 'rest')
      return (await previewRest(deps, request.itemId, undefined, request.environment))?.input.baseUrl;
    return (await previewSoap(deps, request.itemId, undefined, request.environment))?.input.endpoint;
  } catch {
    return undefined;
  }
}

/**
 * The environments the bundle carries: the project's own one it is sent under, or, inside a workspace, that
 * workspace environment written as a project one. Laid on `pruned`.
 */
async function withEnvironment(
  deps: SendThroughEngineDeps,
  pruned: Project,
  item: RoutableItem,
  request: RoutedItem,
  located: { readonly environmentId?: string; readonly workspace?: unknown },
  scopes: PropertyScopes,
): Promise<Project> {
  const environmentId = located.environmentId;
  if (located.workspace === undefined) {
    const environments = pruned.environments.filter((environment) => environment.id === environmentId);
    const rest = withoutActive(pruned);
    return { ...rest, environments, ...(environmentId !== undefined ? { activeEnvironmentId: environmentId } : {}) };
  }
  const rest = withoutActive(pruned);
  if (environmentId === undefined) return { ...rest, environments: [] };
  const address = await containerAddress(deps, item, request);
  const slug = item.kind === 'rest' ? item.api.slug : item.iface.slug;
  const environment: Environment = {
    id: environmentId,
    name: 'Sent under',
    slug: slugify(environmentId) || 'environment',
    order: 0,
    endpoints: address !== undefined && address.length > 0 ? { [slug]: address } : {},
    properties: { ...scopes.env },
    disabledProperties: [],
  };
  return { ...rest, environments: [environment], activeEnvironmentId: environmentId };
}

/**
 * A file the request reads, by its path relative to `rootDir` (the project, or the `team-secrets/` folder),
 * refused when it, or a link on its way, leaves that folder.
 */
async function insideRoot(
  rootDir: string,
  path: string,
): Promise<{ readonly relative: string; readonly absolute: string }> {
  const outside = (): ProjectError =>
    new ProjectError('send-bundle-path-outside', `The file "${path}" is outside the project`, { details: { path } });
  if (isAbsolute(path)) throw outside();
  const root = await realpath(rootDir);
  const target = resolve(root, path);
  if (!target.startsWith(root + sep)) throw outside();
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    // A file that is not there is the send's to refuse, as it would on the server.
    return { relative: relative(root, target).split(sep).join('/'), absolute: target };
  }
  if (!real.startsWith(root + sep)) throw outside();
  const rel = relative(root, real).split(sep).join('/');
  if (!isBundlePath(rel)) throw outside();
  return { relative: rel, absolute: real };
}

/**
 * Every file and link under `dir` (relative to `root`), descending into no link; nothing when `dir` is not
 * there. A link is listed so {@link insideRoot} refuses it when it leads out.
 */
async function filesUnder(root: string, dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(root, dir), { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const child = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await filesUnder(root, child)));
    else if (entry.isFile() || entry.isSymbolicLink()) found.push(child);
  }
  return found;
}

/**
 * The send bundle for one saved request (§18.4).
 *
 * @throws ProjectError `unknown-entity` when the project does not own the item, `send-bundle-path-outside`
 * when it reads a file outside the project
 * @throws WirebenchError `agent-kind-unsupported` for a kind the agent does not send,
 * `send-bundle-no-workspace` for a project in no server workspace, `send-bundle-too-large` over the caps
 */
export async function buildSendBundle(deps: SendBundleDeps, request: RoutedItem): Promise<SendBundle> {
  const { project, item } = locateRouted(deps.send, request);
  if (item === undefined) {
    throw new WirebenchError('agent-kind-unsupported', 'The agent sends REST and SOAP requests only', {
      details: { itemId: request.itemId },
    });
  }
  const workspaceId = deps.serverWorkspaceId(request.projectId);
  if (workspaceId === undefined) {
    throw new WirebenchError('send-bundle-no-workspace', 'This project is not in a server workspace', {
      details: { projectId: request.projectId },
    });
  }
  const located = deps.send.project.runContextFor?.(request.itemId, request.environment);
  if (located === undefined) {
    throw new ProjectError('unknown-entity', `No request "${request.itemId}"`, { details: { itemId: request.itemId } });
  }
  const registry = located.registry ?? createBuiltinRegistry();
  const scopes = deps.send.project.scopesFor(request.itemId, request.environment);
  const references = itemReferences(project, item, scopes);
  const bundled = await withEnvironment(
    deps.send,
    prunedProject(project, item, registry),
    item,
    request,
    located,
    scopes,
  );
  const maxBytes = deps.limits?.maxBytes ?? AGENT_BUNDLE_MAX_BYTES;
  const maxFiles = deps.limits?.maxFiles ?? AGENT_BUNDLE_MAX_FILES;

  const files = new Map<string, SendBundleFile>();
  const teamFiles = new Map<string, SendBundleFile>();
  let bytes = 0;
  /** Adds `file` to `into`; both lists count toward one cap of files and of bytes. */
  const add = (file: SendBundleFile, size: number, into = files): void => {
    if (into.has(file.path)) return;
    bytes += size;
    if (files.size + teamFiles.size + 1 > maxFiles) {
      throw tooLarge(`The request reads more than ${String(maxFiles)} files`, { maxFiles });
    }
    if (bytes > maxBytes) {
      throw tooLarge(`The request's files come to more than ${String(maxBytes)} bytes`, { maxBytes });
    }
    into.set(file.path, file);
  };
  /** Reads `path` under `root` into `into`, held to the folder and the caps; a missing file is skipped. */
  const readInto = async (root: string, path: string, into: Map<string, SendBundleFile>): Promise<void> => {
    const { relative: rel, absolute } = await insideRoot(root, path);
    if (into.has(rel)) return;
    let stat;
    try {
      stat = await lstat(absolute);
    } catch {
      return;
    }
    if (!stat.isFile()) return;
    // Checked against the cap before it is read, so an outsized file is never held in memory.
    if (bytes + stat.size > maxBytes) {
      throw tooLarge(`The request's files come to more than ${String(maxBytes)} bytes`, { maxBytes });
    }
    const content = await readFile(absolute);
    add({ path: rel, encoding: 'base64', content: content.toString('base64') }, content.byteLength, into);
  };
  for (const [path, content] of projectFiles(bundled, { registry })) {
    add({ path, encoding: 'utf8', content }, Buffer.byteLength(content, 'utf8'));
  }

  // The files the request reads from the project folder, and its container's cached definition.
  const readPaths = new Set<string>(references.paths);
  for (const sha256 of references.cached) readPaths.add(`${ATTACHMENTS_DIR}/${sha256}`);
  for (const keystoreId of references.keystoreIds) {
    const ref = bundled.keystores.find((candidate) => candidate.id === keystoreId);
    if (ref !== undefined && !keystoreOnMachine(bundled, keystoreId)) readPaths.add(toKeystoreDef(ref).path);
  }
  const projectDir = located.projectDir;
  const definition =
    item.kind === 'soap'
      ? `interfaces/${item.iface.slug}/definition`
      : containerIdOf(project, item) !== undefined
        ? `apis/${item.api.slug}/definition`
        : undefined;
  if (definition !== undefined) for (const path of await filesUnder(projectDir, definition)) readPaths.add(path);
  for (const path of [...readPaths].sort()) await readInto(projectDir, path, files);

  // A team secret: the workspace's `team-secrets/` subtree as it is, by path inside it (§18.4).
  let readsTeamSecret = false;
  for (const name of references.secretNames) {
    if ((await deps.isTeamSecret?.(request.projectId, name)) === true) readsTeamSecret = true;
  }
  const teamDir = readsTeamSecret ? deps.teamSecretsDir?.(request.projectId) : undefined;
  if (teamDir !== undefined) {
    const listed = (await filesUnder(teamDir, '.')).map((path) => path.replace(/^\.\//, ''));
    for (const path of listed.sort()) await readInto(teamDir, path, teamFiles);
  }

  const parsed = sendBundleSchema.safeParse({
    version: 1,
    kind: item.kind,
    workspaceId,
    itemId: request.itemId,
    ...(located.environmentId !== undefined ? { environment: located.environmentId } : {}),
    files: [...files.values()],
    secretNames: references.secretNames.filter((name) => SECRET_NAME.test(name)),
    systemNames: references.systemNames.filter((name) => SECRET_NAME.test(name)),
    scopes: { workspace: { ...scopes.workspace }, global: { ...scopes.global } },
    ...(teamDir !== undefined ? { teamSecrets: [...teamFiles.values()] } : {}),
  });
  if (!parsed.success) {
    throw new WirebenchError('send-bundle-invalid', 'The request could not be bundled for the agent', {
      details: { issues: parsed.error.issues.slice(0, 10).map((issue) => issue.path.join('.') + ': ' + issue.message) },
    });
  }
  return parsed.data;
}
