/**
 * Session state of the Interface editor: which tab each open interface viewer is on, which
 * schema component its Schema tab has selected, and which document/line its WSDL Content tab
 * should reveal. Kept in a store rather than component state so go-to-definition (which runs
 * from the request editor, before the viewer even exists) can drive it.
 */

import { create } from 'zustand';
import type {
  DefinitionDocumentsResponse,
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
}

const EMPTY_DATA: InterfaceDefinitionData = { status: 'idle' };

export interface InterfaceEditorStore {
  readonly tabs: Readonly<Record<string, InterfaceTabId>>;
  readonly data: Readonly<Record<string, InterfaceDefinitionData | undefined>>;
  /** The cached bundle/schema index for `interfaceId`; `{ status: 'idle' }` before any load. */
  readonly dataFor: (interfaceId: string) => InterfaceDefinitionData;
  /** Fetches the document bundle and the schema index once per interface (idempotent). */
  readonly load: (interfaceId: string) => Promise<void>;
  readonly selections: Readonly<Record<string, SchemaSelection | undefined>>;
  readonly sourceTargets: Readonly<Record<string, SourceTarget | undefined>>;
  /** The tab `interfaceId`'s viewer is on, defaulting to Overview. */
  readonly tabFor: (interfaceId: string) => InterfaceTabId;
  readonly setTab: (interfaceId: string, tab: InterfaceTabId) => void;
  readonly selectionFor: (interfaceId: string) => SchemaSelection | undefined;
  /** Selects a schema component and switches that viewer to the Schema tab. */
  readonly selectComponent: (interfaceId: string, selection: SchemaSelection) => void;
  readonly sourceTargetFor: (interfaceId: string) => SourceTarget | undefined;
  /** Reveals a document (optionally at a line) and switches that viewer to WSDL Content. */
  readonly revealSource: (interfaceId: string, target: SourceTarget) => void;
}

const DEFAULT_TAB: InterfaceTabId = 'overview';

export const useInterfaceEditorStore = create<InterfaceEditorStore>((set, get) => ({
  tabs: {},
  data: {},
  selections: {},

  dataFor: (interfaceId) => get().data[interfaceId] ?? EMPTY_DATA,

  load: async (interfaceId) => {
    const current = get().dataFor(interfaceId);
    if (current.status === 'loading' || current.status === 'ready') {
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
          // A definition whose schema set could not be built still shows its documents.
          namespaces: schemaIndex.ok ? schemaIndex.value.namespaces : [],
          ...(schemaIndex.ok ? {} : { error: schemaIndex.error.message }),
        },
      },
    });
  },
  sourceTargets: {},

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

  revealSource: (interfaceId, target) => {
    set({
      sourceTargets: { ...get().sourceTargets, [interfaceId]: target },
      tabs: { ...get().tabs, [interfaceId]: 'wsdl' },
    });
  },
}));
