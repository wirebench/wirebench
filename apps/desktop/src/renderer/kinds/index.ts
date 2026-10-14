/**
 * The renderer's kinds and its tab table (kind modules spec §6).
 */
import type { ComponentType } from 'react';
import { GENERIC_TABS } from './generic-tabs.js';
import { grpcRenderer } from './grpc/index.js';
import { restRenderer } from './rest/index.js';
import type { ExplorerDeletion, ExplorerNodeRole, KindExplorer, RendererKind } from './renderer-kind.js';
import { soapRenderer } from './soap/index.js';
import type { TabContribution } from './tab-contribution.js';
import { wsRenderer } from './ws/index.js';
import { mcpRenderer } from './mcp/index.js';
import type { KindId } from '../../shared/kinds/kind-module.js';
import type { ExplorerNodeKind } from '../features/explorer/tree-nodes.js';
import type { EditorTab } from '../state/editors.js';
import type { PendingNodeDeletion } from '../state/ui.js';

/** Every renderer kind, in the explorer's tie-break order. */
export const RENDERER_KINDS: readonly RendererKind[] = [
  soapRenderer,
  restRenderer,
  grpcRenderer,
  wsRenderer,
  mcpRenderer,
];

/** Every tab kind that names an entity, by `EditorTab.kind`: the kinds' own, then the generic ones. */
export const TAB_KINDS: Readonly<Partial<Record<EditorTab['kind'], TabContribution>>> = Object.fromEntries(
  [...RENDERER_KINDS.flatMap((kind) => kind.tabs), ...GENERIC_TABS].map((tab) => [tab.kind, tab]),
);

export type { TabContribution, TabTitleContext } from './tab-contribution.js';
export { entityIdOf } from './tab-contribution.js';

/** Every kind's explorer dialogs, mounted once beside the tree. */
export const EXPLORER_DIALOGS: readonly ComponentType[] = RENDERER_KINDS.flatMap((kind) =>
  kind.explorer.Dialogs === undefined ? [] : [kind.explorer.Dialogs],
);

/** The explorer role of a node kind a protocol kind owns; `undefined` for a core node kind. */
export function explorerRole(nodeKind: ExplorerNodeKind): ExplorerNodeRole | undefined {
  for (const kind of RENDERER_KINDS) {
    const role = kind.explorer.nodes[nodeKind];
    if (role !== undefined) return role;
  }
  return undefined;
}

/** The kind whose tab `tabKind` is; `undefined` for a tab no protocol kind owns. */
export function tabOwner(tabKind: EditorTab['kind']): KindId | undefined {
  return RENDERER_KINDS.find((kind) => kind.tabs.some((tab) => tab.kind === tabKind))?.kind;
}

/** The renderer half of one kind. */
export function rendererKind(kind: KindId): RendererKind {
  const found = RENDERER_KINDS.find((candidate) => candidate.kind === kind);
  if (found === undefined) throw new Error(`unknown kind: ${kind}`);
  return found;
}

/** The renderer half of a kind named by the wire or a record; `undefined` for one the desktop has no half of. */
export function rendererKindOf(kind: string | undefined): RendererKind | undefined {
  return RENDERER_KINDS.find((candidate) => candidate.kind === (kind ?? 'soap'));
}

/** The explorer half of one kind. */
export function kindExplorer(kind: KindId): KindExplorer | undefined {
  return RENDERER_KINDS.find((candidate) => candidate.kind === kind)?.explorer;
}

/** How the confirm dialog deletes a pending deletion a protocol kind owns. */
export function explorerDeletion(kind: PendingNodeDeletion['kind']): ExplorerDeletion | undefined {
  for (const renderer of RENDERER_KINDS) {
    const deletion = renderer.explorer.deletions?.[kind];
    if (deletion !== undefined) return deletion;
  }
  return undefined;
}

export type { ExplorerDeletion, ExplorerNodeRole, KindExplorer, RendererKind } from './renderer-kind.js';
