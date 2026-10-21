/**
 * The renderer half of one protocol kind (kind modules spec §6.1). Looked up by `kind` beside the
 * shared half (`shared/kinds/kind-module.ts`).
 *
 * @internal Composed statically in `RENDERER_KINDS`; not yet a plugin API (ADR-0017).
 */
import type { ComponentType, LazyExoticComponent } from 'react';
import type { HistoryEntryWire } from '../../shared/wire-types.js';
import type { SearchMatchWire } from '../../shared/wire-base.js';
import type { KindId } from '../../shared/kinds/kind-module.js';
import type { ExplorerMenuGroup } from '../features/explorer/menu-items.js';
import type { ExplorerNode, ExplorerNodeKind } from '../features/explorer/tree-nodes.js';
import type { CompareSide } from '../features/history/history-actions.js';
import type { RequestLookup } from '../features/console/log-row-actions.js';
import type { LogEntry } from '../state/exchanges.js';
import type { ProjectSnapshot } from '../state/project.js';
import type { PendingNodeDeletion } from '../state/ui.js';
import type { TabContribution } from './tab-contribution.js';
import type { KindQuickOpenItem } from '../shell/quick-open.js';

/** How the explorer treats one node kind a protocol kind owns. */
export interface ExplorerNodeRole {
  readonly icon?: ComponentType<{ size: number }>;
  /** The row's test id, where the names block fixes one. */
  readonly testId?: string;
  /** Drawn in the row's gutter in place of the icon: a request's method or shape. */
  readonly Gutter?: ComponentType<{ readonly node: ExplorerNode }>;
  /** A container row's kind badge: `REST`, `gRPC`, `WS`. */
  readonly badge?: string;
  /**
   * What one click does besides selecting the row: `open` opens its tab (a request's editor, an API's
   * settings) and never folds it (#680) — folding is the chevron's, the arrow keys' and a double-click's
   * job. Unset, the row folds if it has children, since it has nothing to open.
   */
  readonly click?: 'open';
  /** Whether the row can be dragged within its container. */
  readonly movable?: boolean;
  /** Whether rows can be dropped into this one. */
  readonly dropTarget?: boolean;
  /**
   * Whether the row is an API container (#701): it is dragged among its project's containers to
   * reorder them, or onto another project's row to move there, and its menu offers **Move to project…**.
   */
  readonly container?: boolean;
  /** Opens the row's tab: a click on a request, a double-click on anything, Enter. */
  open?(node: ExplorerNode): void;
  /** Commits an inline rename. Unset, the row cannot be renamed inline. */
  rename?(node: ExplorerNode, name: string): void;
  /** Asks to delete the row (the Delete key). */
  remove?(node: ExplorerNode): void;
  /** The row's right-click menu. */
  menu?(node: ExplorerNode): readonly ExplorerMenuGroup[];
  /**
   * The id the Runner runs a container row as (an API, an interface); its menu then gains **Run…**.
   * Unset, the row is not a Runner target.
   */
  runTarget?(node: ExplorerNode): string | undefined;
}

/** A deletion the explorer's confirm dialog carries out, by the pending deletion's kind. */
export interface ExplorerDeletion {
  readonly title: string;
  remove(id: string): Promise<unknown>;
}

/** The explorer's view of a kind: its rows, and what its folders' menus offer. */
export interface KindExplorer {
  readonly nodes: Partial<Record<ExplorerNodeKind, ExplorerNodeRole>>;
  /** **New request** in one of the kind's APIs, or a folder in one. Unset for a kind with no folders. */
  readonly newRequestIn?: (apiId: string, folderId?: string) => void;
  /** **Import cURL…** into a folder: only a kind whose requests are HTTP requests offers it. */
  readonly importCurlIn?: (apiId: string, folderId?: string) => void;
  readonly deletions?: Partial<Record<PendingNodeDeletion['kind'], ExplorerDeletion>>;
  /** Whether `apiId` names one of the kind's APIs: which kind a folder's commands belong to. */
  ownsApi?(apiId: string, project: ProjectSnapshot): boolean;
  /** The dialogs the kind's rows open (a new container's form, a picker), mounted once with the explorer. */
  readonly Dialogs?: ComponentType;
}

/** The kind's saved requests, as History, Search and the HTTP Log reach them. */
export interface KindRequests {
  /** Opens (or focuses) the request's editor tab. */
  open(requestId: string, fallbackTitle?: string): void;
  /** Whether an open project still holds the request. */
  exists(requestId: string, project: ProjectSnapshot): boolean;
  /** The kind's saved requests as Quick Open (⌘P) lists them. Unset, Quick Open builds them itself (SOAP). */
  quickOpen?(project: ProjectSnapshot): readonly KindQuickOpenItem[];
}

/** What a History re-send answers: its IPC reply, with the error when it failed. */
export type HistoryResendResult =
  { readonly ok: true } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

/** How History shows and replays an entry of this kind. A missing `kind` still means SOAP. */
export interface KindHistory {
  /** What says which kind of send this was: in a History row, or the entry tab's header. */
  readonly Badge: ComponentType<{ readonly entry: HistoryEntryWire; readonly place: 'row' | 'header' }>;
  /** Shown after the entry's name in its tab's header. */
  readonly Chip?: ComponentType<{ readonly entry: HistoryEntryWire }>;
  /** The entry tab's body, in place of the request and response side by side, when {@link hasBody}. */
  readonly Body?: LazyExoticComponent<ComponentType<{ readonly entry: HistoryEntryWire }>>;
  hasBody?(entry: HistoryEntryWire): boolean;
  /** Whether History can re-send the entry, and how. */
  canResend(entry: Pick<HistoryEntryWire, 'kind' | 'sse'>): boolean;
  readonly resend?: (historyId: string) => Promise<HistoryResendResult>;
  /** The request's latest response, for **Compare with current**. */
  current?(requestId: string): CompareSide | undefined;
}

/** How Search shows a match of this kind. */
export interface KindSearch {
  /** The group heading's kind badge; none for SOAP, the kind a match has always been. */
  readonly badge?: string;
  /** Opens what the match points at; unset, the match's request opens. */
  reveal?(match: SearchMatchWire): void;
}

/** How the HTTP Log treats a row of this kind. */
export interface KindLog {
  /** Why no row of this kind resends from the log. */
  readonly noResend?: string;
  /** Why this row cannot resend, once its request exists and it was sent. */
  resendRefusal?(entry: LogEntry, requestId: string, lookup: RequestLookup): string | undefined;
  /** Why a row of this kind has no response body to copy. */
  readonly noBody?: string;
}

export interface RendererKind {
  readonly kind: KindId;
  /** Its editor tab kinds: the request editor and the container's tab. */
  readonly tabs: readonly TabContribution[];
  readonly explorer: KindExplorer;
  readonly requests: KindRequests;
  readonly history: KindHistory;
  readonly search: KindSearch;
  readonly log?: KindLog;
  /** Registers the kind's own commands: its send, its creators, its editor actions. */
  readonly registerCommands?: () => void;
}
