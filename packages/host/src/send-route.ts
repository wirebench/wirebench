/**
 * The send route rule (hosted edition spec §18.4): on the server host, whether a browser send of one saved
 * request goes out from the server or must go through the person's paired agent, and why.
 *
 * A send needs the agent when its target resolves to an address on the person's own network (loopback,
 * link-local, private or metadata, whatever the server's own egress rule allows: in the browser the
 * person's `localhost` is never the server's), or when it reads something only their machine has: a
 * `${#System#…}` value, a secret source, a team secret, a keystore on a machine path, Kerberos, or NTLM with
 * the machine's logon. A pin to the agent forces it too. A send that needs the agent but reads a secret
 * whose value only the server holds is not split between them (§3.4 rule 4): it fails with `secret-missing`.
 *
 * Nothing here reads a secret value: the target is resolved as a preview resolves it, with each
 * `${secret:…}` left as its token text, and references are found by expanding against scopes that hold no
 * secret and no process environment.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { mkdir, readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, isAbsolute, join } from 'node:path';
import {
  classifyAddress,
  composeUrl,
  expand,
  nodeFs,
  parseSecretPseudoRef,
  ProjectError,
  restEffectiveAuth,
  restItemFor,
  soapEffectiveAuth,
  soapItemFor,
  toKeystoreDef,
  WirebenchError,
  writeFileAtomic,
  wssConfigsOf,
} from '@wirebench/engine';
import type { AuthConfig, Project, PropertyScopes, RestSelected, SoapSelected } from '@wirebench/engine';
import { SEND_NEEDS, type RequestRouteResponse, type SendNeed } from '@wirebench/wire/agent-route';
import { previewRest, previewSoap, type SendThroughEngineDeps } from './send/exchange.js';

/** One saved request of an open project, sent under `environment` (the active one when absent). */
export interface RoutedItem {
  readonly projectId: string;
  readonly itemId: string;
  readonly environment?: string | undefined;
}

/** A saved request the agent can send: REST or SOAP (`AGENT_SEND_KINDS`). */
export type RoutableItem = RestSelected | SoapSelected;

/** What one request reads, found without reading a value. */
export interface SendReferences {
  /** Every `${secret:name}` name it reads, directly or through a property, and every `secret:name` ref. */
  readonly secretNames: readonly string[];
  /** Every `${#System#NAME}` name it reads. */
  readonly systemNames: readonly string[];
  /** The `wss/keystores.yaml` ids it names (TLS client identity, a JWT key, an OAuth2 client key). */
  readonly keystoreIds: readonly string[];
  /** The project files it reads by path (a body file, a part, an attachment), as the model names them. */
  readonly paths: readonly string[];
  /** The attachment-cache digests it reads. */
  readonly cached: readonly string[];
}

/** The field names a keystore id is kept under, across the kinds' models. */
function isKeystoreKey(key: string): boolean {
  return key === 'sslKeystoreRef' || key === 'keystoreRef' || key === 'clientKeystoreId' || key === 'keystoreId';
}

/** The scopes references are found against: no secret, and no process environment. */
function referenceScopes(scopes: PropertyScopes): PropertyScopes {
  const found: { -readonly [K in keyof PropertyScopes]: PropertyScopes[K] } = { ...scopes, system: {} };
  delete found.secrets;
  delete found.onSystemRead;
  return found;
}

/** `value` without the child containers a folder, an API or an interface holds: its own fields only. */
function own(value: object, ...children: readonly string[]): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...value };
  for (const child of children) delete copy[child];
  return copy;
}

/**
 * The WS-Security configurations a SOAP request names, as stored: their keystores, and their passwords'
 * `secret:` refs (`passwordRef`, `defaultPasswordRef`), are read like any other part.
 */
function wssParts(project: Project, item: SoapSelected): readonly unknown[] {
  const { outgoing, incoming } = wssConfigsOf(project);
  const { wssOutgoingRef, wssIncomingRef } = item.request;
  return [
    ...outgoing.filter((config) => config.id === wssOutgoingRef),
    ...incoming.filter((config) => config.id === wssIncomingRef),
  ].map((config) => config.document);
}

/** The parts of the item a send reads: the request, and its folders', API's or interface's own settings. */
function itemParts(project: Project, item: RoutableItem): readonly unknown[] {
  if (item.kind === 'rest') {
    return [
      item.request,
      own(item.api, 'folders', 'requests'),
      ...item.chain.map((folder) => own(folder, 'folders', 'requests')),
      restEffectiveAuth(item),
      item.signing,
    ];
  }
  return [
    item.request,
    own(item.iface, 'operations', 'endpoints'),
    soapEffectiveAuth(item),
    ...wssParts(project, item),
  ];
}

/**
 * Everything `parts` reads, found by expanding each string the way a send does (so a reference reached
 * through a property's value counts) against `scopes` with no secret and no system value.
 */
export function sendReferences(parts: readonly unknown[], scopes: PropertyScopes): SendReferences {
  const found = referenceScopes(scopes);
  const secretNames = new Set<string>();
  const systemNames = new Set<string>();
  const keystoreIds = new Set<string>();
  const paths = new Set<string>();
  const cached = new Set<string>();
  const visitString = (key: string | undefined, text: string): void => {
    if (key !== undefined && isKeystoreKey(key) && text.length > 0) keystoreIds.add(text);
    // A credential field's `secret:name` pseudo-ref names a `${secret:…}` token too.
    const pseudo = key !== undefined && key.endsWith('Ref') ? parseSecretPseudoRef(text) : undefined;
    if (pseudo !== undefined) secretNames.add(pseudo);
    if (!text.includes('${')) return;
    for (const ref of expand(text, found).unresolved) {
      if (ref.name === undefined) continue;
      if (ref.scope === 'Secret') secretNames.add(ref.name);
      if (ref.scope === 'System') systemNames.add(ref.name);
    }
  };
  const visit = (value: unknown, key?: string): void => {
    if (typeof value === 'string') {
      visitString(key, value);
      return;
    }
    if (Array.isArray(value)) {
      // A script's `secrets` list names the secrets it may read with `secrets.get`.
      for (const entry of value) {
        if (key === 'secrets' && typeof entry === 'string') secretNames.add(entry);
        else visit(entry);
      }
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    // An `AttachmentSource`: a file the send reads from the project folder or its attachment cache.
    if (record['kind'] === 'path' && typeof record['path'] === 'string') paths.add(record['path']);
    if (record['kind'] === 'cache' && typeof record['sha256'] === 'string') cached.add(record['sha256']);
    for (const [childKey, child] of Object.entries(record)) visit(child, childKey);
  };
  for (const part of parts) visit(part);
  return {
    secretNames: [...secretNames].sort(),
    systemNames: [...systemNames].sort(),
    keystoreIds: [...keystoreIds].sort(),
    paths: [...paths].sort(),
    cached: [...cached].sort(),
  };
}

/** The item `itemId` names in `project`, when it is one the agent sends. */
export function routableItem(project: Project, itemId: string): RoutableItem | undefined {
  return restItemFor(project, itemId) ?? soapItemFor(project, itemId);
}

/** The references of `item`, against the scopes its send expands with. */
export function itemReferences(
  project: Project,
  item: RoutableItem,
  scopes: PropertyScopes,
  extra: readonly unknown[] = [],
): SendReferences {
  return sendReferences([...itemParts(project, item), ...extra], scopes);
}

/** The addresses a host name resolves to; a literal address is its own answer. */
export type ResolveHost = (host: string) => Promise<readonly string[]>;

const systemResolve: ResolveHost = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((answer) => answer.address);

/** What the target's address asks for: its needs, and whether its host did not resolve on the server. */
export interface AddressNeeds {
  readonly needs: readonly SendNeed[];
  readonly unresolved: boolean;
}

/**
 * The address needs of `url`'s host: `loopback-target` for a loopback or unspecified answer, and
 * `private-target` for a private, link-local or metadata one. A host the server cannot resolve needs the
 * agent too (`private-target`, `unresolved`): it is most likely a name only the person's network knows. A URL
 * with no host needs nothing.
 */
export async function addressNeeds(
  url: string | undefined,
  resolve: ResolveHost = systemResolve,
): Promise<AddressNeeds> {
  const none: AddressNeeds = { needs: [], unresolved: false };
  if (url === undefined) return none;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return none;
  }
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (bare.length === 0) return none;
  let addresses: readonly string[];
  try {
    addresses = isIP(bare) !== 0 ? [bare] : await resolve(bare);
  } catch {
    return { needs: ['private-target'], unresolved: true };
  }
  if (addresses.length === 0) return { needs: ['private-target'], unresolved: true };
  const needs = new Set<SendNeed>();
  for (const address of addresses) {
    const addressClass = classifyAddress(address);
    if (addressClass === 'loopback' || addressClass === 'unspecified') needs.add('loopback-target');
    if (addressClass === 'private' || addressClass === 'link-local' || addressClass === 'metadata') {
      needs.add('private-target');
    }
  }
  return { needs: [...needs], unresolved: false };
}

/** The machine's own credentials an auth configuration reads: its Kerberos ticket, or its NTLM logon. */
export function authNeeds(auth: AuthConfig | undefined): SendNeed[] {
  if (auth?.type === 'kerberos') return ['kerberos'];
  // No stored password: NTLM then logs on with the machine's own account, which only the person's machine has.
  if (auth?.type === 'ntlm' && auth.passwordRef === undefined) return ['ntlm-machine'];
  return [];
}

/** Whether a keystore lives on a path of the machine's rather than inside the project. */
export function keystoreOnMachine(project: Project, keystoreId: string): boolean {
  const ref = project.keystores.find((candidate) => candidate.id === keystoreId);
  if (ref === undefined) return false;
  try {
    const { path } = toKeystoreDef(ref);
    return isAbsolute(path) || path.split(/[\\/]/).includes('..');
  } catch {
    return false;
  }
}

/** Where the route rule reads the item, its secrets and the person's pins. */
export interface SendRouteDeps {
  /** The send path's own dependencies: the previews resolve the target as a send would. */
  readonly send: SendThroughEngineDeps;
  /** Resolves a target's host; the system resolver when absent. */
  readonly resolve?: ResolveHost;
  /** The secret names the project's workspace maps to a secret source; none when absent. */
  readonly secretSourceNames?: (projectId: string) => readonly string[];
  /** Whether the project's workspace holds a team secret of that name. */
  readonly isTeamSecret?: (projectId: string, name: string) => Promise<boolean>;
  /** The `${secret:name}` names whose value this host holds for the project; names only. */
  readonly serverSecretNames?: (projectId: string) => Promise<readonly string[]>;
  /** The person's pins. */
  readonly pins?: Pick<RoutePins, 'pinned'>;
  /** The server workspace id of the project's workspace: what the browser knows it by, and pins it by. */
  readonly workspaceIdOf?: (projectId: string) => string | undefined;
}

/**
 * The project the item belongs to, checked against the one the caller named, and the item itself; refuses
 * an id no open project owns, or one another project owns.
 */
export function locateRouted(
  deps: Pick<SendThroughEngineDeps, 'project'>,
  request: RoutedItem,
): { readonly project: Project; readonly item: RoutableItem | undefined } {
  const owner = deps.project.projectId(request.itemId);
  const located =
    owner === request.projectId ? deps.project.runContextFor?.(request.itemId, request.environment) : undefined;
  if (located === undefined) {
    throw new ProjectError('unknown-entity', `No request "${request.itemId}" in project "${request.projectId}"`, {
      details: { projectId: request.projectId, itemId: request.itemId },
    });
  }
  return { project: located.project, item: routableItem(located.project, request.itemId) };
}

/** The URL a send of `item` goes to, resolved as a send resolves it with no secret read; `undefined` when none does. */
async function targetOf(
  deps: SendThroughEngineDeps,
  item: RoutableItem,
  request: RoutedItem,
): Promise<string | undefined> {
  try {
    if (item.kind === 'rest') {
      const preview = await previewRest(deps, request.itemId, undefined, request.environment);
      return preview === undefined ? undefined : composedUrl(preview);
    }
    return (await previewSoap(deps, request.itemId, undefined, request.environment))?.input.endpoint;
  } catch {
    // What the preview refuses, the send refuses too: on the server, as today.
    return undefined;
  }
}

/** A host and port with no scheme in front: `localhost:8080/x`, `[::1]:80`, `localhost/x`. */
const SCHEMELESS_HOST = /^(?:localhost(?=[:/?#]|$)|\[[0-9A-Fa-f:.]+\](?=[:/?#]|$)|[A-Za-z0-9.-]+(?=:\d+(?:[/?#]|$)))/;

/**
 * A REST preview's URL, composed as the send composes it. A request URL written without a scheme but with
 * a host of its own (`localhost:8080/x`) is classified by that host, never by the base URL's.
 */
export function composedUrl(preview: Pick<NonNullable<Awaited<ReturnType<typeof previewRest>>>, 'input'>): string {
  const { baseUrl, request, settings } = preview.input;
  if (SCHEMELESS_HOST.test(request.url)) return `http://${request.url}`;
  const { url } = composeUrl(baseUrl, request.url, request.pathParams, request.query, {
    encode: settings.encodeUrl ?? true,
  });
  return url;
}

/**
 * Where a send of the item must go (§18.4). Kinds the agent does not send (gRPC, WebSocket, MCP) answer
 * `server`.
 *
 * @throws ProjectError `unknown-entity` when the project does not own the item
 * @throws WirebenchError `secret-missing` when the send needs the agent and reads a secret only the server
 * holds (no split sends)
 */
export async function routeSend(deps: SendRouteDeps, request: RoutedItem): Promise<RequestRouteResponse> {
  const { project, item } = locateRouted(deps.send, request);
  if (item === undefined) return { route: 'server' };
  const scopes = deps.send.project.scopesFor(request.itemId, request.environment);
  const references = itemReferences(project, item, scopes);
  const target = await targetOf(deps.send, item, request);
  const address = await addressNeeds(target, deps.resolve);
  const needs = new Set<SendNeed>(address.needs);
  if (references.systemNames.length > 0) needs.add('system-values');
  const sources = new Set(deps.secretSourceNames?.(request.projectId) ?? []);
  const machineSecrets = new Set<string>();
  for (const name of references.secretNames) {
    if (sources.has(name)) {
      needs.add('secret-source');
      machineSecrets.add(name);
    } else if ((await deps.isTeamSecret?.(request.projectId, name)) === true) {
      needs.add('team-secret');
      machineSecrets.add(name);
    }
  }
  if (references.keystoreIds.some((id) => keystoreOnMachine(project, id))) needs.add('keystore');
  for (const need of authNeeds(item.kind === 'rest' ? restEffectiveAuth(item) : soapEffectiveAuth(item))) {
    needs.add(need);
  }
  const workspaceId = deps.workspaceIdOf?.(request.projectId);
  const pins = {
    request: deps.pins?.pinned('request', request.itemId) === true,
    workspace: workspaceId !== undefined && deps.pins?.pinned('workspace', workspaceId) === true,
  };
  if (pins.request || pins.workspace) needs.add('pinned');
  const targetHost = hostOf(target);
  const info = {
    pins,
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    ...(targetHost !== undefined ? { targetHost } : {}),
  };
  if (needs.size === 0) return { route: 'server', info };
  // No split sends: a value only the server holds never travels to the agent, and the agent has no other.
  const onServer = new Set(await (deps.serverSecretNames?.(request.projectId) ?? Promise.resolve([])));
  const stranded = references.secretNames.find((name) => onServer.has(name) && !machineSecrets.has(name));
  if (stranded !== undefined) {
    throw new WirebenchError(
      'secret-missing',
      `This request must be sent from your machine, which does not have the secret "${stranded}": its value is kept on the server`,
      { details: { name: stranded, missingOn: 'agent', needs: ordered(needs) } },
    );
  }
  return {
    route: 'agent',
    info,
    needs: ordered(needs),
    ...(address.unresolved ? { detail: { reason: 'unresolved' as const } } : {}),
  };
}

/** The lower-case host name of a target URL, brackets off; `undefined` when there is none. */
function hostOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const host = new URL(url).hostname.toLowerCase();
    const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
    return bare.length === 0 || bare.length > 256 ? undefined : bare;
  } catch {
    return undefined;
  }
}

/** `needs` in the order the wire lists them. */
function ordered(needs: ReadonlySet<SendNeed>): SendNeed[] {
  return SEND_NEEDS.filter((need) => needs.has(need));
}

/** The pins file: the workspaces and requests pinned to the agent. */
interface PinsFile {
  readonly version: 1;
  readonly workspace: Readonly<Record<string, 'agent'>>;
  readonly request: Readonly<Record<string, 'agent'>>;
}

/** How many pins of each scope are kept. */
export const MAX_ROUTE_PINS = 1000;

const EMPTY_PINS: PinsFile = { version: 1, workspace: {}, request: {} };

/** Where the pins are kept: `<userData>/route-pins.json`, the user's state on the server host. */
export function routePinsPath(userDataDir: string): string {
  return join(userDataDir, 'route-pins.json');
}

/**
 * The person's pins to the agent (§18.4), kept in a small JSON file in the host's user data. Read once and
 * kept in memory; each change is written atomically. A file that does not parse reads as no pins.
 */
export class RoutePins {
  private state: PinsFile | undefined;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  /** Loads the file, once; later calls are no-ops. */
  async load(): Promise<void> {
    if (this.state !== undefined) return;
    let text: string | undefined;
    try {
      text = await readFile(this.file, 'utf8');
    } catch {
      text = undefined;
    }
    this.state ??= parsePins(text);
  }

  /** Whether `id` (a workspace or a request, by `scope`) is pinned to the agent; false before `load`. */
  pinned(scope: 'workspace' | 'request', id: string): boolean {
    const pins = this.state?.[scope];
    return pins !== undefined && Object.hasOwn(pins, id);
  }

  /** Pins `id` to the agent, or (`null`) takes its pin off, and writes the file. */
  async set(scope: 'workspace' | 'request', id: string, pin: 'agent' | null): Promise<'agent' | null> {
    await this.load();
    const current = this.state ?? EMPTY_PINS;
    const entries = { ...current[scope] };
    if (pin === null) delete entries[id];
    else if (!Object.hasOwn(entries, id) && Object.keys(entries).length >= MAX_ROUTE_PINS) {
      throw new WirebenchError('route-pins-full', `At most ${String(MAX_ROUTE_PINS)} ${scope} pins are kept`, {
        details: { scope, max: MAX_ROUTE_PINS },
      });
    } else entries[id] = pin;
    const next: PinsFile = { ...current, [scope]: entries };
    this.state = next;
    const write = this.writes.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFileAtomic(nodeFs, this.file, Buffer.from(`${JSON.stringify(next, null, 2)}\n`, 'utf8'));
    });
    this.writes = write.catch(() => undefined);
    await write;
    return pin;
  }
}

function parsePins(text: string | undefined): PinsFile {
  if (text === undefined) return EMPTY_PINS;
  try {
    const parsed = JSON.parse(text) as Partial<PinsFile> | null;
    const pick = (value: unknown): Record<string, 'agent'> =>
      value !== null && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .filter((pair): pair is [string, 'agent'] => pair[1] === 'agent')
              .slice(0, MAX_ROUTE_PINS),
          )
        : {};
    return { version: 1, workspace: pick(parsed?.workspace), request: pick(parsed?.request) };
  } catch {
    return EMPTY_PINS;
  }
}
