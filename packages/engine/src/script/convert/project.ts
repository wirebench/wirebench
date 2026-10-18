/**
 * Converting a project's layered levels (spec §3, §7). A request, folder, API or SOAP interface whose
 * `scripts.api` is layered is one level: {@link proposeConversions} converts each one at or below a
 * root and names the backup of each script, and {@link applyConversions} switches the accepted ones
 * to `wirebench`. Nothing here writes a file: the caller writes each applied proposal's backups, then
 * saves the project, whose save deletes the stale `.js` files (`project/managed-files.ts`).
 */
import { createHash } from 'node:crypto';
import { levelScriptPath } from '../../import/scripts.js';
import { slugify } from '../../project/paths.js';
import { containersOf, withContainersOf, type Project } from '../../project/model.js';
import type { ContainerBase } from '../../protocol/module.js';
import { isLayeredApi, type LayeredApi, type RequestScripts, type ScriptSource } from '../model.js';
import { SCRIPT_LIMITS } from '../sandbox/model.js';
import { convertLevelScripts, type ConvertedLevel, type ConvertProtocol } from './index.js';

export interface LevelProposal {
  /** The request, folder, API or interface id. */
  readonly ownerId: string;
  /** The names from the API (or interface) down: a SOAP request's are its interface, operation and own. */
  readonly path: readonly string[];
  readonly dialect: LayeredApi;
  readonly before: { readonly pre?: string; readonly post?: string };
  readonly result: ConvertedLevel;
  /** One per phase with text: what the caller writes before the save. */
  readonly backups: readonly { readonly path: string; readonly source: string }[];
  /** The sha256 of the dialect and the texts before, so an edit made since is caught on apply. */
  readonly fingerprint: string;
}

/** Why an accepted level was not applied. */
export type ConversionRefusal = 'changed' | 'not-layered' | 'syntax';

/** Something in a container's tree that can carry scripts. */
interface Scripted {
  readonly id: string;
  readonly name: string;
  readonly scripts?: RequestScripts;
}

interface Tree extends Scripted {
  readonly folders: readonly Tree[];
  readonly requests: readonly Scripted[];
}

/**
 * The shapes this module reads, by container kind. Core imports no protocol group (protocol modules
 * spec §7.2), so the containers are read with `containersOf` and seen through these.
 */
type TreeContainer = ContainerBase & Tree;
type SoapContainer = ContainerBase &
  Scripted & { readonly operations: readonly { readonly name: string; readonly requests: readonly Scripted[] }[] };
/** The kinds whose levels carry scripts; an MCP server's own level does not, its folders do. */
const TREE_KINDS: readonly (readonly [ConvertProtocol, boolean])[] = [
  ['rest', true],
  ['grpc', true],
  ['mcp', false],
];

function soapOf(project: Project): readonly SoapContainer[] {
  return containersOf(project, 'soap') as readonly SoapContainer[];
}

function treesOf(project: Project, kind: string): readonly TreeContainer[] {
  return containersOf(project, kind) as readonly TreeContainer[];
}

/** One layered level as found, before it is converted. */
interface Level {
  readonly ownerId: string;
  readonly path: readonly string[];
  readonly protocol: ConvertProtocol;
  readonly scripts: RequestScripts & { readonly api: LayeredApi };
  /** At or below the root asked about. */
  readonly inRoot: boolean;
  readonly backups: { readonly pre?: string; readonly post?: string };
}

const PHASES = ['pre', 'post'] as const;

/**
 * Every layered level at or below `rootId`, or in the whole project when it is absent, in explorer
 * order: containers by their shared `order`, a level before the levels inside it. `rootId` may name
 * a container, a folder or a request; one that names nothing yields none. `takenBackups` are paths
 * already used (files on disk); two levels of one call never share a path either. Each level's path
 * is chosen over the whole project, so a root never changes the path a level is given.
 */
export function proposeConversions(
  project: Project,
  rootId?: string,
  takenBackups: ReadonlySet<string> = new Set(),
): LevelProposal[] {
  return layeredLevels(project, rootId, takenBackups)
    .filter((level) => level.inRoot)
    .map(propose);
}

/**
 * The project with each accepted level switched; a level whose fingerprint changed is refused.
 *
 * The proposals are worked out again from `project` itself, with the same `takenBackups` the review
 * used, so a backup path and the header naming it are those the review showed. An accepted level is
 * refused as `changed` when its dialect or text differs from what was proposed, as `not-layered`
 * when it is gone or already `wirebench`, and as `syntax` when it does not convert, which covers a
 * syntax error and a script refused with line 0 (the converter's "could not convert"). The level is
 * switched to `wirebench` with the converted texts; a phase it did not have stays absent, and
 * `enabled`, `secrets`, `timeoutMs` and `postResponseOrder` are kept. `applied` lists what was
 * switched, whose backups the caller writes before it saves.
 */
export function applyConversions(
  project: Project,
  accepted: readonly { readonly ownerId: string; readonly fingerprint: string }[],
  takenBackups: ReadonlySet<string> = new Set(),
): {
  readonly project: Project;
  readonly applied: readonly LevelProposal[];
  readonly refused: readonly { readonly ownerId: string; readonly reason: ConversionRefusal }[];
} {
  const levels = new Map(layeredLevels(project, undefined, takenBackups).map((level) => [level.ownerId, level]));
  const applied: LevelProposal[] = [];
  const refused: { ownerId: string; reason: ConversionRefusal }[] = [];
  const seen = new Set<string>();
  for (const { ownerId, fingerprint } of accepted) {
    if (seen.has(ownerId)) continue;
    seen.add(ownerId);
    const level = levels.get(ownerId);
    if (level === undefined) {
      refused.push({ ownerId, reason: 'not-layered' });
      continue;
    }
    if (fingerprintOf(level.scripts.api, textsOf(level.scripts)) !== fingerprint) {
      refused.push({ ownerId, reason: 'changed' });
      continue;
    }
    const proposal = propose(level);
    if (!proposal.result.ok) {
      refused.push({ ownerId, reason: 'syntax' });
      continue;
    }
    applied.push(proposal);
  }
  if (applied.length === 0) return { project, applied, refused };

  const switched = new Map(applied.map((proposal) => [proposal.ownerId, proposal]));
  const update = <R extends Scripted>(owner: R): R => {
    const proposal = switched.get(owner.id);
    if (proposal === undefined || owner.scripts === undefined || !proposal.result.ok) return owner;
    return { ...owner, scripts: switchedScripts(owner.scripts, proposal.result) };
  };
  return { project: mapLevels(project, update), applied, refused };
}

/** `scripts` as `wirebench` with the converted texts, everything else kept. */
function switchedScripts(scripts: RequestScripts, result: Extract<ConvertedLevel, { ok: true }>): RequestScripts {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit them
  const { pre, post, ...rest } = scripts;
  return {
    ...(result.pre !== undefined ? { pre: sourceOf(result.pre) } : {}),
    ...(result.post !== undefined ? { post: sourceOf(result.post) } : {}),
    ...rest,
    api: 'wirebench',
  };
}

/** A converted script's source: text over the size limit is kept and refuses to send, as a loaded one does. */
function sourceOf(text: string): ScriptSource {
  return Buffer.byteLength(text, 'utf8') > SCRIPT_LIMITS.fileBytes ? { text, problem: 'script-too-large' } : { text };
}

function textsOf(scripts: RequestScripts): { pre?: string; post?: string } {
  return {
    ...(scripts.pre !== undefined ? { pre: scripts.pre.text } : {}),
    ...(scripts.post !== undefined ? { post: scripts.post.text } : {}),
  };
}

function fingerprintOf(dialect: LayeredApi, before: { readonly pre?: string; readonly post?: string }): string {
  return createHash('sha256')
    .update(JSON.stringify([dialect, before.pre ?? null, before.post ?? null]))
    .digest('hex');
}

function propose(level: Level): LevelProposal {
  const { scripts } = level;
  const before = textsOf(scripts);
  const backups = PHASES.flatMap((phase) => {
    const path = level.backups[phase];
    const source = before[phase];
    return path !== undefined && source !== undefined ? [{ path, source }] : [];
  });
  return {
    ownerId: level.ownerId,
    path: level.path,
    dialect: scripts.api,
    before,
    result: convertLevel(level, before),
    backups,
    fingerprint: fingerprintOf(scripts.api, before),
  };
}

/** The level converted; a script file that was missing or too large on load is refused, not converted. */
function convertLevel(level: Level, before: { readonly pre?: string; readonly post?: string }): ConvertedLevel {
  for (const phase of PHASES) {
    const problem = level.scripts[phase]?.problem;
    if (problem !== undefined) {
      const why = problem === 'script-file-missing' ? 'its file is missing' : 'its file is too large';
      return { ok: false, phase, line: 0, message: `could not convert: ${why}` };
    }
  }
  return convertLevelScripts({
    dialect: level.scripts.api,
    protocol: level.protocol,
    ...before,
    backups: level.backups,
  });
}

/** Every layered level of the project with its backup paths, in explorer order. */
function layeredLevels(project: Project, rootId: string | undefined, takenBackups: ReadonlySet<string>): Level[] {
  const taken = new Set(takenBackups);
  const levels: Level[] = [];
  const containers: { readonly order: number; readonly walk: () => void }[] = [];

  const visit = (
    owner: Scripted,
    path: readonly string[],
    protocol: ConvertProtocol,
    apiSlug: string,
    above: boolean,
  ): boolean => {
    const inRoot = above || rootId === undefined || owner.id === rootId;
    const scripts = owner.scripts;
    if (scripts !== undefined && isLayeredApi(scripts.api)) {
      const backups: { pre?: string; post?: string } = {};
      for (const phase of PHASES) {
        if (scripts[phase] !== undefined) backups[phase] = levelScriptPath(apiSlug, path, phase, taken);
      }
      levels.push({
        ownerId: owner.id,
        path,
        protocol,
        scripts: scripts as RequestScripts & { readonly api: LayeredApi },
        inRoot,
        backups,
      });
    }
    return inRoot;
  };
  const walkTree = (
    node: Tree,
    path: readonly string[],
    protocol: ConvertProtocol,
    apiSlug: string,
    above: boolean,
    scripted: boolean,
  ): void => {
    // An MCP server keeps no scripts of its own; its folders and requests do.
    const inRoot = scripted
      ? visit(node, path, protocol, apiSlug, above)
      : above || rootId === undefined || node.id === rootId;
    for (const folder of node.folders) walkTree(folder, [...path, folder.name], protocol, apiSlug, inRoot, true);
    for (const request of node.requests) visit(request, [...path, request.name], protocol, apiSlug, inRoot);
  };
  const apiSlugOf = (name: string): string => slugify(name).toLowerCase();

  for (const iface of soapOf(project)) {
    containers.push({
      order: iface.order,
      walk: () => {
        const slug = apiSlugOf(iface.name);
        const inRoot = visit(iface, [iface.name], 'soap', slug, false);
        for (const operation of iface.operations) {
          for (const request of operation.requests) {
            visit(request, [iface.name, operation.name, request.name], 'soap', slug, inRoot);
          }
        }
      },
    });
  }
  for (const [protocol, scripted] of TREE_KINDS) {
    for (const api of treesOf(project, protocol)) {
      containers.push({
        order: api.order,
        walk: () => walkTree(api, [api.name], protocol, apiSlugOf(api.name), false, scripted),
      });
    }
  }
  // A stable sort: containers of one order keep their kind's place, as they load.
  containers.sort((a, b) => a.order - b.order);
  for (const container of containers) container.walk();
  return levels;
}

/** An edit applied to each level; a level it returns unchanged keeps its identity. */
type Update = <R extends Scripted>(owner: R) => R;

/** `items` mapped, or the same array when no item changed. */
function mapSame<T>(items: readonly T[], map: (item: T) => T): readonly T[] {
  const next = items.map(map);
  return next.some((item, index) => item !== items[index]) ? next : items;
}

/** `node` with `update` applied to it (when `scripted`), its folders and its requests; the same object when none changed. */
function mapTree<T extends Tree>(node: T, update: Update, scripted: boolean): T {
  const self = scripted ? update(node) : node;
  const folders = mapSame(self.folders, (folder) => mapTree(folder, update, true));
  const requests = mapSame(self.requests, (request) => update(request));
  return folders === self.folders && requests === self.requests ? self : { ...self, folders, requests };
}

/** `project` with `update` applied to every level of every SOAP, REST, gRPC and MCP container. */
function mapLevels(project: Project, update: Update): Project {
  let next = project;
  const interfaces = soapOf(project);
  const mappedInterfaces = mapSame(interfaces, (iface) => {
    const self = update(iface);
    const operations = mapSame(self.operations, (operation) => {
      const requests = mapSame(operation.requests, (request) => update(request));
      return requests === operation.requests ? operation : { ...operation, requests };
    });
    return operations === self.operations ? self : { ...self, operations };
  });
  if (mappedInterfaces !== interfaces) next = withContainersOf(next, 'soap', mappedInterfaces);
  for (const [kind, scripted] of TREE_KINDS) {
    const trees = treesOf(project, kind);
    const mapped = mapSame(trees, (tree) => mapTree(tree, update, scripted));
    if (mapped !== trees) next = withContainersOf(next, kind, mapped);
  }
  return next;
}
