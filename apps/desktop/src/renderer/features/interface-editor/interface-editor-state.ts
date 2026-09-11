/**
 * Session state of the Interface editor: which tab each open interface viewer is on, which
 * schema component its Schema tab has selected, and which document/line its WSDL Content tab
 * should reveal. Kept in a store rather than component state so go-to-definition (which runs
 * from the request editor, before the viewer even exists) can drive it.
 */

import { create } from 'zustand';
import type {
  DefinitionDocumentsResponse,
  DefinitionDocumentWire,
  SchemaComponentKind,
  SchemaNamespaceWire,
} from '../../../shared/wire-types.js';
import { ipc } from '../../state/ipc-client.js';

/** Which tab of the Interface editor is showing. */
export type InterfaceTabId = 'overview' | 'endpoints' | 'wsdl' | 'schema' | 'wsi';

/**
 * One selected schema component. `document`/`line` are carried for a component that is not in
 * the index at all — a *local* element declaration, which go-to-definition can land on but the
 * tree (global components only) never lists.
 */
export interface SchemaSelection {
  readonly namespace: string;
  readonly kind: SchemaComponentKind;
  readonly name: string;
  readonly document?: string;
  readonly line?: number;
}

/** Which definition dialog one interface's viewer is showing, if any. */
export type InterfaceDialogId = 'update' | 'docs';

/** A document position the WSDL Content tab should scroll to. */
export interface SourceTarget {
  readonly location: string;
  readonly line?: number;
}

/** How far one interface's cached definition data has got. */
export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/** The bundle and schema index of one interface, fetched once per viewer and kept here. */
export interface InterfaceDefinitionData {
  readonly status: LoadStatus;
  readonly documents?: DefinitionDocumentsResponse | undefined;
  readonly namespaces?: readonly SchemaNamespaceWire[] | undefined;
  readonly error?: string | undefined;
  /**
   * The `loadedAt` this data was fetched for. A re-import gives the interface a newer one, at
   * which point everything cached here (documents, schema index, texts) is stale.
   */
  readonly loadedAt?: number | undefined;
  /** Document text by location, fetched one document at a time by `loadText`. */
  readonly texts?: Readonly<Record<string, string | undefined>> | undefined;
}

const EMPTY_DATA: InterfaceDefinitionData = { status: 'idle' };

/** A stable empty list, so a component reading `documents` of an unloaded interface never rerenders. */
export const NO_DOCUMENTS: readonly DefinitionDocumentWire[] = [];

export interface InterfaceEditorStore {
  readonly tabs: Readonly<Record<string, InterfaceTabId>>;
  readonly data: Readonly<Record<string, InterfaceDefinitionData | undefined>>;
  /** The cached bundle/schema index for `interfaceId`; `{ status: 'idle' }` before any load. */
  readonly dataFor: (interfaceId: string) => InterfaceDefinitionData;
  /**
   * Fetches the document bundle and the schema index once per interface. Idempotent, except
   * that a definition re-imported since (a newer `loadedAt` on the project's summary) is
   * refetched — the cached projections describe the old bytes. The caller passes that
   * `loadedAt` because the definition's freshness lives in the project mirror, not here.
   */
  readonly load: (interfaceId: string, loadedAt?: number) => Promise<void>;
  /** One document's text, fetched on demand and cached per location; `undefined` until it lands. */
  readonly textFor: (interfaceId: string, location: string) => string | undefined;
  /** Fetches one document's text through `definition.documentText` (idempotent per location). */
  readonly loadText: (interfaceId: string, location: string) => Promise<void>;
  /** Drops everything cached for one interface — called when it is removed from the project. */
  readonly forget: (interfaceId: string) => void;
  readonly selections: Readonly<Record<string, SchemaSelection | undefined>>;
  readonly sourceTargets: Readonly<Record<string, SourceTarget | undefined>>;
  /** The tab `interfaceId`'s viewer is on, defaulting to Overview. */
  readonly tabFor: (interfaceId: string) => InterfaceTabId;
  readonly setTab: (interfaceId: string, tab: InterfaceTabId) => void;
  readonly selectionFor: (interfaceId: string) => SchemaSelection | undefined;
  /** Selects a schema component and switches that viewer to the Schema tab. */
  readonly selectComponent: (interfaceId: string, selection: SchemaSelection) => void;
  readonly sourceTargetFor: (interfaceId: string) => SourceTarget | undefined;
  /**
   * Forgets a reveal once the WSDL Content tab has performed it, so stepping Prev/Next away
   * and back does not jump the caret to a line the user has since left.
   */
  readonly clearSourceTarget: (interfaceId: string) => void;
  /**
   * Reveals a document (optionally at a line) and, unless `focus` is false, switches that
   * viewer to WSDL Content. Go-to-definition records the target without the switch, so the
   * declaration is already revealed if the user later opens that tab.
   */
  readonly revealSource: (interfaceId: string, target: SourceTarget, options?: { readonly focus?: boolean }) => void;
  readonly dialogs: Readonly<Record<string, InterfaceDialogId | undefined>>;
  /** Which definition dialog `interfaceId`'s viewer is showing, or `undefined` for none. */
  readonly dialogFor: (interfaceId: string) => InterfaceDialogId | undefined;
  /**
   * Opens (or, with `undefined`, closes) one of the viewer's definition dialogs. Kept in the
   * store rather than in the viewer's own state so the explorer and the palette can ask for a
   * dialog on an interface whose viewer is not mounted yet.
   */
  readonly setDialog: (interfaceId: string, dialog: InterfaceDialogId | undefined) => void;
}

const DEFAULT_TAB: InterfaceTabId = 'overview';

/** A copy of `record` without `key`. */
function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([candidate]) => candidate !== key));
}

export const useInterfaceEditorStore = create<InterfaceEditorStore>((set, get) => ({
  tabs: {},
  data: {},
  selections: {},
  dialogs: {},

  dataFor: (interfaceId) => get().data[interfaceId] ?? EMPTY_DATA,

  load: async (interfaceId, expected) => {
    const current = get().dataFor(interfaceId);
    const stale = expected !== undefined && current.loadedAt !== undefined && current.loadedAt !== expected;
    if (!stale && (current.status === 'loading' || current.status === 'ready')) {
      return;
    }
    set({ data: { ...get().data, [interfaceId]: { status: 'loading' } } });
    const [documents, schemaIndex] = await Promise.all([
      ipc().definition.documents({ interfaceId }),
      ipc().definition.schemaIndex({ interfaceId }),
    ]);
    if (!documents.ok) {
      set({ data: { ...get().data, [interfaceId]: { status: 'error', error: documents.error.message } } });
      return;
    }
    set({
      data: {
        ...get().data,
        [interfaceId]: {
          status: 'ready',
          documents: documents.value,
          loadedAt: documents.value.loadedAt,
          // Whatever a concurrent `loadText` already fetched for *this* load is kept; the
          // `{ status: 'loading' }` placeholder above is what drops a previous load's texts.
          texts: get().dataFor(interfaceId).texts ?? {},
          // A definition whose schema set could not be built still shows its documents.
          namespaces: schemaIndex.ok ? schemaIndex.value.namespaces : [],
          ...(schemaIndex.ok ? {} : { error: schemaIndex.error.message }),
        },
      },
    });
  },
  sourceTargets: {},

  textFor: (interfaceId, location) => get().dataFor(interfaceId).texts?.[location],

  loadText: async (interfaceId, location) => {
    const before = get().dataFor(interfaceId);
    if (before.texts?.[location] !== undefined) {
      return;
    }
    const result = await ipc().definition.documentText({ interfaceId, location });
    if (!result.ok) {
      // A document that cannot be shown (too large, or gone with a re-import) becomes a note in
      // place of its text rather than an error for the whole viewer.
      set({
        data: {
          ...get().data,
          [interfaceId]: {
            ...get().dataFor(interfaceId),
            texts: { ...get().dataFor(interfaceId).texts, [location]: `<!-- ${result.error.message} -->` },
          },
        },
      });
      return;
    }
    const data = get().dataFor(interfaceId);
    set({
      data: { ...get().data, [interfaceId]: { ...data, texts: { ...data.texts, [location]: result.value.text } } },
    });
  },

  forget: (interfaceId) => {
    set({
      data: without(get().data, interfaceId),
      selections: without(get().selections, interfaceId),
      sourceTargets: without(get().sourceTargets, interfaceId),
      tabs: without(get().tabs, interfaceId),
      dialogs: without(get().dialogs, interfaceId),
    });
  },

  tabFor: (interfaceId) => get().tabs[interfaceId] ?? DEFAULT_TAB,

  setTab: (interfaceId, tab) => {
    set({ tabs: { ...get().tabs, [interfaceId]: tab } });
  },

  selectionFor: (interfaceId) => get().selections[interfaceId],

  selectComponent: (interfaceId, selection) => {
    set({
      selections: { ...get().selections, [interfaceId]: selection },
      tabs: { ...get().tabs, [interfaceId]: 'schema' },
    });
  },

  sourceTargetFor: (interfaceId) => get().sourceTargets[interfaceId],

  clearSourceTarget: (interfaceId) => {
    if (get().sourceTargets[interfaceId] === undefined) {
      return;
    }
    set({ sourceTargets: without(get().sourceTargets, interfaceId) });
  },

  dialogFor: (interfaceId) => get().dialogs[interfaceId],

  setDialog: (interfaceId, dialog) => {
    set({
      dialogs: dialog === undefined ? without(get().dialogs, interfaceId) : { ...get().dialogs, [interfaceId]: dialog },
    });
  },

  revealSource: (interfaceId, target, options) => {
    set({
      sourceTargets: { ...get().sourceTargets, [interfaceId]: target },
      ...(options?.focus === false ? {} : { tabs: { ...get().tabs, [interfaceId]: 'wsdl' } }),
    });
  },
}));
