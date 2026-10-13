/**
 * The main half of each kind (spec §5.1): what main does for one protocol, kept in that kind's folder
 * under `main/kinds/<kind>/` and listed once in {@link MAIN_KINDS}. Core code asks the list rather
 * than switching on a kind's name.
 */

import type { LiveEvent, Project, SelectedRequest, SentRequest, WsExchange } from '@wirebench/engine';
import type { DraftOf } from '../send/draft.js';
import type { AuditedSend, HeldFailure, Recorded, SendSummary, SendThroughEngineDeps } from '../send/exchange.js';
import type { LiveEventWire } from '../send/live.js';
import type { DesktopSend } from '../send/host.js';
import type { ProjectWire } from '../../shared/wire-types.js';
import type { ExchangeSummary } from '../../shared/kinds/soap/wire.js';
import type { SearchQueryRequest } from '../../shared/wire-base.js';
import type { SearchChannelEngine } from '../ipc/search.js';
import type { LogChannelDeps } from '../ipc/log.js';
import type { ApiChannelDeps } from '../ipc/api.js';
import type { HistoryChannelDeps } from '../ipc/history.js';
import type { RequestChannelDeps } from '../ipc/request.js';
import type { DialogPicks } from '../dialog-picks.js';
import type { EngineService } from '../engine-service.js';
import type { HistoryService } from '../history-service.js';
import type { WorkspaceService } from '../workspace-service.js';
import type { ChannelRequest, ChannelResponse, channels } from '../../shared/ipc.js';
import type { SearchDocument } from '../search.js';
import type { KindId } from '../../shared/kinds/kind-module.js';
import type { ProjectChange } from '../../shared/wire-types.js';
import type { RestFolderPatchWire } from '../../shared/kinds/rest/wire.js';
import type { ProjectHostCore } from '../project-host-core.js';
import type { ProjectWireContext } from '../project-wire.js';
import type { MutationDeps, MutationResult } from '../project-mutations.js';
import type { GrpcHost } from './grpc/host.js';
import type { RestHost } from './rest/host.js';
import type { SoapHost } from './soap/host.js';
import type { WsHost } from './ws/host.js';
import type { GrpcRouter } from './grpc/router.js';
import type { RestRouter } from './rest/router.js';
import type { SoapRouter } from './soap/router.js';
import type { WsRouter } from './ws/router.js';
import type { KindEntityIds } from './kind-routes.js';
import { grpcMain } from './grpc/kind.js';
import { restMain } from './rest/kind.js';
import { soapMain } from './soap/kind.js';
import { wsMain } from './ws/kind.js';

export type ChangeKind = ProjectChange['kind'];
export type ChangeOf<K extends ChangeKind> = Extract<ProjectChange, { kind: K }>;

/** Applies one change kind. Pure apart from what `deps` does; never mutates `project`. */
export type ChangeReducer<K extends ChangeKind = ChangeKind> = (
  project: Project,
  change: ChangeOf<K>,
  deps: MutationDeps,
) => MutationResult | Promise<MutationResult>;

/** The change kinds a kind owns, each with its reducer. */
export type KindMutations = { readonly [K in ChangeKind]?: ChangeReducer<K> };

/**
 * A kind whose APIs hold folders: the folder and move changes name a folder, an API or a node, and
 * core asks each kind whether the id is its own (spec §5.2).
 */
export interface KindTree {
  ownsApi(project: Project, apiId: string): boolean;
  /** Whether the folder or request with this id sits in one of this kind's trees. */
  ownsNode(project: Project, nodeId: string): boolean;
  addFolder(
    project: Project,
    input: { readonly apiId: string; readonly parentId?: string; readonly name: string },
  ): MutationResult;
  updateFolder(project: Project, folderId: string, patch: RestFolderPatchWire): MutationResult;
  removeFolder(project: Project, folderId: string): MutationResult;
  moveNode(
    project: Project,
    input: { readonly nodeId: string; readonly parentId?: string; readonly index: number },
  ): MutationResult;
}

/** The documents cached for an API's definition, as the Definition card lists them. */
export interface ApiDefinitionDocuments {
  readonly documents: readonly { location: string; size: number }[];
  readonly rootLocation: string;
  readonly fetchedAt: string;
  readonly declaredVersion?: string;
}

/** A kind whose APIs cache a definition the Definition card can list, show and export. */
export interface KindApiDefinitions {
  ownsApi(apiId: string): boolean;
  apiDefinitionDocuments(apiId: string): Promise<ApiDefinitionDocuments>;
  apiDefinitionText(apiId: string, location: string): Promise<string>;
  exportApiDefinitionTo(apiId: string, dir: string): Promise<string[]>;
}

/**
 * What core asks of every kind's host (spec §5.3), each optional: `ProjectHost` calls them in turn
 * rather than naming a kind.
 */
export interface KindHostHooks {
  /** After an open: what the kind loads in the background (SOAP re-imports each interface). */
  hydrate?(): Promise<void>;
  /** As the project closes: drops what belongs to it alone. */
  close?(project: Project): void;
  /** After a change is applied: drops what the change made stale. */
  afterChange?(change: ProjectChange): void;
  /** What the kind adds to the snapshot's options. */
  wireOptions?(): Partial<ProjectWireContext>;
  /** Present when the kind's APIs cache a definition. */
  readonly apiDefinitions?: KindApiDefinitions;
}

/** Each kind's host, by kind (spec §5.3). */
export interface KindHosts {
  readonly soap: SoapHost & KindHostHooks;
  readonly rest: RestHost & KindHostHooks;
  readonly grpc: GrpcHost & KindHostHooks;
  readonly websocket: WsHost & KindHostHooks;
}

/**
 * How one of a kind's router methods reaches the kind's host (spec §5.3). `entity` finds the host by
 * the entity id the call takes first and passes every argument on; `project` finds it by a leading
 * project id and passes the rest; `project-kept` finds it by a leading project id and passes that on
 * too, for a host method that takes the project id itself.
 */
export interface KindRoute<H> {
  readonly method: keyof H & string;
  readonly by: 'entity' | 'project' | 'project-kept';
}

/** The router methods a kind's route table declares, typed from its host's methods. */
export type KindRouter<H, R extends Readonly<Record<string, KindRoute<H>>>> = {
  [N in keyof R]: H[R[N]['method']] extends (...args: infer A) => infer Result
    ? R[N]['by'] extends 'project'
      ? (projectId: string, ...args: A) => Result
      : (...args: A) => Result
    : never;
};

/** Every kind's router methods, which `ProjectRouter` adds to the core's. */
export type KindRouters = SoapRouter & RestRouter & GrpcRouter & WsRouter;

/**
 * Every kind the engine can send, which can be ahead of the kinds the app has: a kind the engine
 * sends before the app registers it (MCP, #79) has no send steps here yet, and `kindSend` refuses it.
 */
export type SendKind = SelectedRequest['kind'];

/** A kind's saved request as a send item, its live event, and its exchange as `SentRequest` holds it. */
type ItemOf<K extends SendKind> = Extract<SelectedRequest, { kind: K }>;
type LiveOf<K extends SendKind> = Extract<LiveEvent, { protocol: K }>;
type ExchangeOf<K extends SendKind> = Extract<NonNullable<SentRequest['exchange']>, { kind: K }>;

/** What one send's summary is built from (`exchange.ts`'s `summarise`). */
export interface SummariseInput<K extends SendKind> {
  readonly deps: SendThroughEngineDeps;
  readonly sendId: string;
  readonly item: ItemOf<K>;
  readonly sent: SentRequest;
  readonly masks: Pick<DesktopSend, 'keyParams' | 'keyHeaders'>;
  readonly show: boolean;
  /** The saved request the rows name, or the one a resent entry came from. */
  readonly requestId: string | undefined;
  /** A WebSocket session's exchange with its frames' contract results. */
  readonly checked: WsExchange | undefined;
}

/**
 * The send path's steps for one kind (spec §5.5): `exchange.ts`, `draft.ts` and `live.ts` look the
 * item's kind up here rather than switching on it.
 */
export interface KindSend<K extends SendKind> {
  /** The saved request as a send item with the editor's draft applied; undefined: no such request of this kind. */
  selected(project: Project, requestId: string, draft: Extract<DraftOf, { kind: K }>): ItemOf<K> | undefined;
  /** One live event as the renderer receives it; absent for a kind that reports none. */
  liveEvent?(sendId: string, event: LiveOf<K>, show: boolean, keyParams?: readonly string[]): LiveEventWire;
  /** The summary the renderer is handed and, where History records more, the unredacted one. */
  summarise(input: SummariseInput<K>): { readonly summary: SendSummary; readonly unredacted?: ExchangeSummary };
  /** Writes History for a send that got its answer. */
  record(
    deps: SendThroughEngineDeps,
    recorded: Recorded & { readonly item: ItemOf<K> },
    sent: SentRequest,
    summary: SendSummary,
    unredacted: ExchangeSummary | undefined,
  ): Promise<void>;
  /** Writes History for a send that failed on the wire. */
  recordFailure(
    deps: SendThroughEngineDeps,
    recorded: Recorded & { readonly item: ItemOf<K> },
    failed: HeldFailure,
    error: unknown,
    summaryOf: { readonly sendId: string; readonly show: boolean },
  ): Promise<void>;
  /** What the audit log keeps of a send that got its answer. */
  sentAudit(exchange: ExchangeOf<K>, summary: SendSummary): AuditedSend;
  /** What the audit log keeps of a send that failed on the wire; undefined when it never reached it. */
  failedAudit(item: ItemOf<K>, failed: HeldFailure): AuditedSend | undefined;
  /** The API key names the item's effective credentials put in its URL or headers; absent: none. */
  keyMasks?(item: ItemOf<K>): KeyMasks;
}

/** The query parameter and header names a send masks wherever its request is shown. */
export type KeyMasks = Pick<DesktopSend, 'keyParams' | 'keyHeaders'>;

/** What one project's search documents are built from. */
export interface KindSearchContext {
  readonly snapshot: ProjectWire;
  readonly scopes: SearchQueryRequest['scopes'];
  readonly projectId: string;
  readonly projectName: string;
  readonly engine: SearchChannelEngine;
}

/** A kind's share of `search.query`'s corpus (spec §5.4). */
export interface KindSearch {
  /** Its requests' documents, as the scopes ask. */
  requests(context: KindSearchContext): readonly SearchDocument[];
  /** Its cached definitions' documents, which follow every kind's requests. */
  definitions?(context: KindSearchContext): readonly SearchDocument[];
}

/** What a Log row's resend is handed (spec §5.4). */
export interface KindLogContext {
  readonly request: ChannelRequest<typeof channels.log.resend>;
  readonly deps: LogChannelDeps;
  /** The request channels' own send through the engine, cancelled through the same registry. */
  readonly sendDeps: SendThroughEngineDeps;
  readonly sendId: string;
}

/** A kind's answer to the HTTP Log's Resend. */
export interface KindLog {
  /** Replays the saved request behind a row as it is now — never the row's own (redacted) copy. */
  resend(context: KindLogContext): Promise<ChannelResponse<typeof channels.log.resend>>;
}

/**
 * What a kind's IPC channels are registered with (spec §5.4): the deps main wires the core channel
 * modules with, and the app services a kind's own modules take theirs from.
 */
export interface KindChannelDeps {
  readonly engine: EngineService;
  readonly request: RequestChannelDeps;
  readonly api: ApiChannelDeps;
  readonly history: HistoryService;
  readonly historyDeps: HistoryChannelDeps;
  readonly router: WorkspaceService;
  readonly picks: DialogPicks;
  /** The folders of every project open in the calling window's workspace. */
  readonly projectDirs: () => readonly string[];
  readonly userDataDir: string;
  /** The native Save-as panel for an HTML export (with the e2e override), the chosen path or undefined. */
  readonly showSaveHtml: (options: { defaultPath: string; title: string }) => Promise<string | undefined>;
}

export interface MainKind<K extends KindId = KindId> {
  readonly kind: K;
  /** Its share of the project host: caches and methods, built once per open project. */
  createHost(core: ProjectHostCore): KindHosts[K];
  /** Its router methods, each naming the host method it reaches (spec §5.3). */
  readonly routes: Readonly<Record<string, { readonly method: string; readonly by: KindRoute<unknown>['by'] }>>;
  /** Applies the change kinds this kind owns. */
  readonly mutations: KindMutations;
  readonly tree?: KindTree;
  /** The send path's steps (spec §5.5). */
  readonly send: KindSend<K>;
  readonly search?: KindSearch;
  readonly log?: KindLog;
  /** The entity ids its channels address in a project snapshot, for the routing index. */
  readonly entityIds: KindEntityIds;
  /** Registers its channels against the routed workspace. */
  registerChannels(deps: KindChannelDeps): void;
}

/** Any one kind's main half. */
export type AnyMainKind = { [K in KindId]: MainKind<K> }[KindId];

export const MAIN_KINDS: readonly AnyMainKind[] = [soapMain, restMain, grpcMain, wsMain];

/** The kind that owns `changeKind`, if any. */
export function mutationOwner(changeKind: string): AnyMainKind | undefined {
  return MAIN_KINDS.find((kind) => Object.hasOwn(kind.mutations, changeKind));
}
