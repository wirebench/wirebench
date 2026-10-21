/**
 * Which WS-Security configuration the right panel edits (#730). The sidebar keeps the list; the selected
 * configuration opens in the right-hand panel, wide enough for every label, with the request still in
 * front.
 *
 * Edits apply to the project as they are made, as they always have; "unsaved" is the configuration
 * differing from what it was when the panel opened (or was last saved) while its project is not yet saved.
 * Closing then asks: Save writes the project, Don't save puts the configuration back.
 */

import { create } from 'zustand';
import type { WssIncomingWire, WssOutgoingWire } from '../../../shared/kinds/soap/wire.js';
import { useProjectStore } from '../../state/project.js';

export type WssDirection = 'outgoing' | 'incoming';

export interface WssEditing {
  readonly direction: WssDirection;
  readonly id: string;
}

type WssConfig = WssOutgoingWire | WssIncomingWire;

interface WssConfigPanelState {
  readonly editing: WssEditing | undefined;
  /** The configuration as it stood when the panel opened or was last saved: what Don't save restores. */
  readonly original: WssConfig | undefined;
  /** The close question is up. */
  readonly asking: boolean;
  /** Opens `id` in the panel; one already open with unsaved edits asks first. */
  readonly open: (direction: WssDirection, id: string) => void;
  /** Closes the panel, asking first when the configuration has unsaved edits. */
  readonly requestClose: () => void;
  /** Answers the close question. */
  readonly answer: (answer: 'save' | 'discard' | 'cancel') => Promise<void>;
  /** Saves the configuration's project and takes what is there now as the saved state. */
  readonly save: () => Promise<void>;
}

/** The configuration `editing` names, as the project mirror holds it now. */
export function currentConfig(
  editing: WssEditing | undefined,
): (WssConfig & { readonly projectId: string }) | undefined {
  if (editing === undefined) return undefined;
  const state = useProjectStore.getState();
  const list: readonly (WssConfig & { readonly projectId: string })[] =
    editing.direction === 'outgoing' ? state.wssOutgoing : state.wssIncoming;
  return list.find((config) => config.id === editing.id);
}

/** A configuration's own fields, without the project the mirror tags it with. */
function fieldsOf(config: WssConfig & { readonly projectId: string }): WssConfig {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
  const { projectId, ...fields } = config;
  return fields;
}

/** Whether the configuration open in the panel holds edits its project has not saved. */
export function isWssConfigDirty(editing: WssEditing | undefined, original: WssConfig | undefined): boolean {
  const current = currentConfig(editing);
  if (current === undefined || original === undefined) return false;
  if (useProjectStore.getState().projects[current.projectId]?.dirty !== true) return false;
  return JSON.stringify(fieldsOf(current)) !== JSON.stringify(original);
}

/** Writes `original` back over the configuration: what Don't save does. */
async function restore(editing: WssEditing, original: WssConfig): Promise<void> {
  const project = useProjectStore.getState();
  if (editing.direction === 'outgoing') {
    const config = original as WssOutgoingWire;
    await project.updateWssOutgoing(editing.id, {
      name: config.name,
      defaultAlias: config.defaultAlias ?? null,
      defaultPasswordRef: config.defaultPasswordRef ?? null,
      actor: config.actor ?? null,
      mustUnderstand: config.mustUnderstand,
      entries: [...config.entries],
    });
    return;
  }
  const config = original as WssIncomingWire;
  await project.updateWssIncoming(editing.id, {
    name: config.name,
    decryptKeystoreRef: config.decryptKeystoreRef ?? null,
    decryptAlias: config.decryptAlias ?? null,
    decryptKeyPasswordRef: config.decryptKeyPasswordRef ?? null,
    signatureKeystoreRef: config.signatureKeystoreRef ?? null,
    requireSignature: config.requireSignature,
    requireTimestamp: config.requireTimestamp,
    timestampSkewSeconds: config.timestampSkewSeconds,
    verifyChain: config.verifyChain,
  });
}

/** Where to go once the close question is answered: another configuration, or nowhere. */
let afterAnswer: WssEditing | undefined;

export const useWssConfigPanelStore = create<WssConfigPanelState>((set, get) => {
  /** Shows `next` (or nothing), taking its fields as they stand as the saved state. */
  const show = (next: WssEditing | undefined): void => {
    const config = currentConfig(next);
    set({
      editing: config === undefined ? undefined : next,
      original: config === undefined ? undefined : fieldsOf(config),
      asking: false,
    });
  };

  return {
    editing: undefined,
    original: undefined,
    asking: false,
    open: (direction, id) => {
      const { editing, original } = get();
      if (editing?.direction === direction && editing.id === id) return;
      if (isWssConfigDirty(editing, original)) {
        afterAnswer = { direction, id };
        set({ asking: true });
        return;
      }
      show({ direction, id });
    },
    requestClose: () => {
      const { editing, original } = get();
      if (isWssConfigDirty(editing, original)) {
        afterAnswer = undefined;
        set({ asking: true });
        return;
      }
      show(undefined);
    },
    answer: async (answer) => {
      const { editing, original } = get();
      if (answer === 'cancel') {
        afterAnswer = undefined;
        set({ asking: false });
        return;
      }
      if (editing !== undefined && original !== undefined) {
        if (answer === 'save') await get().save();
        else await restore(editing, original);
      }
      const next = afterAnswer;
      afterAnswer = undefined;
      show(next);
    },
    save: async () => {
      const config = currentConfig(get().editing);
      if (config === undefined) return;
      const saved = await useProjectStore.getState().save(config.projectId);
      const now = currentConfig(get().editing);
      if (saved && now !== undefined) set({ original: fieldsOf(now) });
    },
  };
});

/** Whether the panel has a configuration to show. */
export function useWssConfigPanelShown(): boolean {
  const editing = useWssConfigPanelStore((state) => state.editing);
  return useProjectStore((state) => {
    if (editing === undefined) return false;
    const list = editing.direction === 'outgoing' ? state.wssOutgoing : state.wssIncoming;
    return list.some((config) => config.id === editing.id);
  });
}

/** The panel's title: which kind of configuration it edits. */
export function useWssConfigPanelLabel(): string {
  const direction = useWssConfigPanelStore((state) => state.editing?.direction);
  return direction === 'incoming' ? 'Incoming WS-Security configuration' : 'Outgoing WS-Security configuration';
}
