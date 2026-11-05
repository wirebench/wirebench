/**
 * One settings section's card state: the server's view of it, a draft the card edits, and its save and removal. The
 * draft is filled from the view when the section loads or changes on the server, so a save that came back with the
 * server's own values (a default filled in, a trimmed URL) shows them.
 */
import { useEffect, useState } from 'react';
import type { ServerSettingsSectionStateWire, ServerSettingsWritableSectionWire } from '@shared/wire-base.js';
import { showToast } from '../../../components/toast.js';
import { useServerSettingsStore } from './server-settings-store.js';

export interface SectionCard<D> {
  readonly url: string;
  readonly state: ServerSettingsSectionStateWire | undefined;
  readonly value: Readonly<Record<string, unknown>> | null;
  /** The section is a tenant's own and this caller may write it. */
  readonly writable: boolean;
  readonly busy: boolean;
  readonly error: string | undefined;
  readonly draft: D;
  readonly setDraft: (patch: Partial<D>) => void;
  /** Sends `input`; a toast says it was saved. `problem`, when given, is shown instead and nothing is sent. */
  readonly save: (input: Readonly<Record<string, unknown>>, problem?: string) => Promise<boolean>;
  readonly remove: () => Promise<boolean>;
}

export function useSection<D>(
  section: ServerSettingsWritableSectionWire,
  label: string,
  toDraft: (value: Readonly<Record<string, unknown>> | null) => D,
): SectionCard<D> {
  const url = useServerSettingsStore((s) => s.url) ?? '';
  const state = useServerSettingsStore((s) => s.settings?.sections[section]);
  const busy = useServerSettingsStore((s) => s.busy[section] === true);
  const error = useServerSettingsStore((s) => s.errors[section]);
  const [local, setLocal] = useState<{ readonly error: string | undefined }>({ error: undefined });
  const value = state?.value ?? null;
  const [draft, setDraftState] = useState<D>(() => toDraft(value));
  const stamp = `${state?.updatedAt ?? ''}|${value === null ? 'null' : 'set'}`;

  useEffect(() => {
    setDraftState(toDraft(state?.value ?? null));
    // Re-read only when the server's copy changes, not on every render's new `toDraft`.
  }, [stamp]);

  return {
    url,
    state,
    value,
    writable: state?.writable === true && state.source === 'tenant',
    busy,
    error: local.error ?? error,
    draft,
    setDraft: (patch) => {
      setDraftState((current) => ({ ...current, ...patch }));
      if (local.error !== undefined) setLocal({ error: undefined });
    },
    save: async (input, problem) => {
      if (problem !== undefined) {
        setLocal({ error: problem });
        return false;
      }
      setLocal({ error: undefined });
      const saved = await useServerSettingsStore.getState().save(section, input);
      if (saved) showToast(`${label} saved.`);
      return saved;
    },
    remove: async () => {
      setLocal({ error: undefined });
      const removed = await useServerSettingsStore.getState().clear(section);
      if (removed) showToast(`${label} removed.`);
      return removed;
    },
  };
}

/** A draft's text, trimmed; `undefined` when empty, so an optional field is left out of the input. */
export const optional = (text: string): string | undefined => {
  const trimmed = text.trim();
  return trimmed === '' ? undefined : trimmed;
};

/** A whole number typed in a field; `undefined` when empty, `NaN` when it is not one. */
export const wholeNumber = (text: string): number | undefined => {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
};

/** `input` without its `undefined` fields: the server's strict shapes refuse none, but a JSON body drops them anyway. */
export function compact(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, field]) => field !== undefined));
}
